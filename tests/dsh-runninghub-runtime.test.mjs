// Real host-contract test for the standalone dsh-runninghub plugin.
//
// Boots a REAL cordis Context with the REAL runtime service packages
// (dsh-tools -> ToolRuntime "tools", dsh-credentials-local ->
// LocalCredentialProvider "credentials", dsh-attachment-local ->
// LocalAttachmentStore "attachments") resolved from the installed DSH runtime
// selected by DSH_BOOT_MODULE, then drives the plugin's exported `apply`
// exactly as the real host loader would.
//
// `tavern` and `webServer` are host bridges the plugin only *registers* against
// (handle / register); they are not the contract under test, so they are
// provided as minimal capture stubs. ToolProvider, LocalAttachmentStore and the
// credential provider are the genuine runtime implementations.
//
// Nothing touches the user's real DSH_HOME: every writable location
// (credentials document, attachment root, RunningHub data directory) is created
// under an isolated mkdtemp root. No external or paid gateway is ever called.
//
// Run with:  DSH_BOOT_MODULE=<runtime>/dsh-app-boot/lib/index.js node --test tests/dsh-runninghub-runtime.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Explicitly select the host runtime; never import the Tavern source checkout.
const DSH_BOOT_MODULE = process.env.DSH_BOOT_MODULE
if (!DSH_BOOT_MODULE) throw new Error('真实运行时测试需要 DSH_BOOT_MODULE 指向 dsh-app-boot/lib/index.js')
const runtimeRequire = createRequire(path.resolve(DSH_BOOT_MODULE))
const { Context } = await import(runtimeRequire.resolve('@deepseek-ai/cordis'))
const { default: ToolRuntime } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-tools'))
const { default: LocalCredentialProvider } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-credentials-local'))
const { default: LocalAttachmentStore } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-attachment-local'))
const { credentialRef, isCredentialRefName } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-credentials'))
const { apply, createRunningHubHost, API, MEDIA } = await import('../index.mjs')

const BASE = 'http://127.0.0.1:6888'

// Mirror of the package-internal dynamic credential name so the harness can
// address the exact ref the plugin writes/reads.
function credentialName(baseURL) {
  return 'DSH_RUNNINGHUB_' + createHash('sha256').update(baseURL).digest('hex').slice(0, 24).toUpperCase() + '_KEY'
}

// Host bridges the plugin only registers against. They capture what the plugin
// hands the host so the test can assert the registration contract.
function makeBridgeStubs() {
  const routes = new Map()
  const tavernHandles = {}
  const webServer = {
    register(spec) {
      const stop = () => routes.delete(spec.path)
      routes.set(spec.path, spec.handler)
      return stop
    },
  }
  const tavern = {
    handle(name, fn) { tavernHandles[name] = fn },
    list: async () => [],
    update: async () => {},
    attach: async () => {},
    getTurnState: async () => ({ settled: true, busy: false, turn: 1, textVersion: 'v1' }),
    getTurn: async () => ({ gameId: 'g', turn: 1, textVersion: 'v1' }),
  }
  return { routes, tavernHandles, webServer, tavern }
}

// Minimal response/request shims to drive a registered route handler directly
// (no real HTTP server) and assert the handler is the genuine host.route.
function fakeRouteRes() {
  return {
    statusCode: 0, headers: undefined, chunks: [], ended: false,
    headersSent: false, writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.ended = true; this.writableEnded = true; return this
    },
    destroy() {},
  }
}
function fakeRouteReq({ method = 'GET', url = API, headers = {}, body } = {}) {
  return {
    method, url, headers,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(body) },
  }
}

// Build a real cordis Context wired with the genuine runtime service packages.
// `tavern`/`webServer` are provided as capture stubs; `systemPrompt` is a minimal
// shim because the real dsh-tools ToolRuntime injects it at construction.
async function bootRuntime() {
  const dshHome = await mkdtemp(path.join(tmpdir(), 'rh-runtime-home-'))
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'rh-runtime-data-'))
  const ctx = new Context()
  const bridges = makeBridgeStubs()
  // dsh-tools injects `systemPrompt`; provide a no-op shim (native mode never
  // calls section()/getSectionOrder()).
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0 } })
  ctx.provide('tavern', bridges.tavern)
  ctx.provide('webServer', bridges.webServer)
  await ctx.plugin(LocalCredentialProvider, { path: path.join(dshHome, '.credentials.yaml'), dshHome, watch: false })
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(ToolRuntime, {})
  return { ctx, bridges, dshHome, dataDirectory }
}

async function shutdown({ ctx, dataDirectory, dshHome }) {
  await ctx.fiber.dispose()
  await rm(dataDirectory, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
}

test('真实凭据函数契约：credentialRef / isCredentialRefName 来自真实 dsh-credentials', () => {
  // The plugin's dynamic name grammar is exactly a credential ref.
  const ref = credentialName(BASE)
  assert.ok(isCredentialRefName(ref), '动态凭据名须通过 isCredentialRefName')
  assert.equal(credentialRef(ref), ref, 'credentialRef 须原样返回合法引用')
  assert.throws(() => credentialRef('not a ref!'), TypeError, '非法引用须被 credentialRef 拒绝')
  assert.equal(isCredentialRefName('DSH_RUNNINGHUB_ABC_KEY'), true)
  assert.equal(isCredentialRefName('has space'), false)
})

test('真实 loader：ctx.plugin 加载 dsh-runninghub 经真实 ToolProvider 注册 3 工具 + 2 路由 + 2 handle，且 dispose 拆除 host', async () => {
  const rt = await bootRuntime()
  let fork
  try {
    // Load the plugin through the REAL cordis loader, exactly as the host would.
    // After the index.mjs fix (apply no longer returns the host object) this must
    // NOT throw "Invalid effect".
    fork = await rt.ctx.plugin(
      { name: 'dsh-runninghub', inject: ['tavern', 'attachments', 'credentials', 'webServer'], apply },
      { dataDirectory: rt.dataDirectory, baseURL: BASE },
    )

    // 3 tools registered in the REAL ToolRuntime (dsh-tools) by apply().
    const expected = ['runninghub_describe', 'runninghub_generate', 'runninghub_status']
    const toolRefs = {}
    for (const name of expected) {
      const tool = rt.ctx.tools.get(name)
      assert.ok(tool, `${name} 须经真实 loader 注册到 ToolProvider`)
      assert.equal(tool.name, name)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      toolRefs[name] = tool
    }
    assert.equal(expected.filter(n => rt.ctx.tools.get(n)).length, 3, '不得有多余/缺失的 RunningHub 工具')

    // 2 exact HTTP routes registered via the real ctx.webServer.register shim.
    const apiHandler = rt.bridges.routes.get(API)
    const mediaHandler = rt.bridges.routes.get(MEDIA)
    assert.equal(typeof apiHandler, 'function', 'API 路由须注册')
    assert.equal(typeof mediaHandler, 'function', 'MEDIA 路由须注册')
    // The handler is the genuine host.route: an unconfigured GET returns 200 list.
    const res = fakeRouteRes()
    await apiHandler(fakeRouteReq({ method: 'GET', url: API }), res)
    assert.equal(res.statusCode, 200, '已注册的 API 路由须响应 host.route')

    // 2 tavern handles registered.
    assert.equal(typeof rt.bridges.tavernHandles['dsh-runninghub/list'], 'function')
    assert.equal(typeof rt.bridges.tavernHandles['dsh-runninghub/describe'], 'function')

    // apply-registered tool output.render returns the canonical text-block array.
    const value = { configured: true, baseURL: BASE, jobs: [{ id: 'j1', status: 'ready' }] }
    const rendered = toolRefs['runninghub_describe'].output.render({}, value)
    assert.deepEqual(rendered, [{ type: 'text', text: JSON.stringify(value) }])
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].type, 'text')
    assert.deepEqual(JSON.parse(rendered[0].text), value)

    // Dispose the plugin fork (NOT the whole runtime) and prove the host is torn
    // down: a previously-registered tool must now reject with DISPOSED.
    await fork.dispose()
    await assert.rejects(
      toolRefs['runninghub_describe'].execute({ model: 'demo' }),
      (e) => e.code === 'DISPOSED',
      'dispose 插件 fork 须拆除 host（dispatch 须报 DISPOSED）',
    )
  } finally {
    await shutdown(rt)
  }
})

test('真实凭据服务：动态名 set/resolve 经 LocalCredentialProvider 往返成功且落盘', async () => {
  const rt = await bootRuntime()
  try {
    const ref = credentialName(BASE)
    assert.equal(await rt.ctx.credentials.resolve(ref), undefined, '未设置前应解析为空')
    await rt.ctx.credentials.set(ref, 'secret-gateway-key')
    const resolved = await rt.ctx.credentials.resolve(ref)
    assert.ok(resolved, '设置后须可解析')
    assert.equal(resolved.value, 'secret-gateway-key')
    assert.equal(resolved.source, 'file', '本地文件来源')
    const described = await rt.ctx.credentials.describe(ref)
    assert.equal(described.configured, true)
    assert.equal(described.writable, true)
    // Persisted to the isolated credential document (ref present; the document
    // is the credential store, so the value is plaintext by design).
    const text = await readFile(path.join(rt.dshHome, '.credentials.yaml'), 'utf8')
    assert.ok(text.includes(ref), '凭据名须落盘到 .credentials.yaml')
  } finally {
    await shutdown(rt)
  }
})

test('插件 configure 经真实凭据服务写入动态名；connection.json 不含 key', async () => {
  const rt = await bootRuntime()
  let host
  try {
    // apply 不再返回 host；需要 host 时单独用 factory 创建。
    host = await createRunningHubHost(rt.ctx, { dataDirectory: rt.dataDirectory, baseURL: BASE })
    const result = await host.dispatch({ action: 'configure', baseURL: BASE, apiKey: 'my-gateway-key' })
    assert.equal(result.configured, true)
    assert.equal(result.baseURL, BASE)
    // The plugin wrote the dynamic ref through the REAL credential provider.
    const ref = credentialName(BASE)
    const resolved = await rt.ctx.credentials.resolve(ref)
    assert.equal(resolved.value, 'my-gateway-key', 'configure 须经真实凭据服务 set')

    // connection.json must carry the baseURL but never the key.
    const raw = await readFile(path.join(rt.dataDirectory, 'connection.json'), 'utf8')
    const conn = JSON.parse(raw)
    assert.equal(conn.baseURL, BASE)
    assert.equal('apiKey' in conn, false, 'connection.json 不得含 apiKey')
  } finally {
    host?.dispose()
    await shutdown(rt)
  }
})

test('插件 summary 经真实凭据服务解析动态名后连通（fake fetch，无外部调用）', async () => {
  const rt = await bootRuntime()
  const realFetch = globalThis.fetch
  // Fake the gateway so connect()/listWorkflows() succeeds without any external
  // or paid call.
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/api/workflows')
      return new Response(JSON.stringify([{ alias: 'demo', customFields: [], referenceSlots: [], capabilities: {} }]), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let host
  try {
    host = await createRunningHubHost(rt.ctx, { dataDirectory: rt.dataDirectory, baseURL: BASE }, { fetchImpl: globalThis.fetch })
    await host.dispatch({ action: 'configure', baseURL: BASE, apiKey: 'my-gateway-key' })
    const summary = await host.dispatch({ action: 'list' })
    assert.equal(summary.configured, true, '凭据解析后须 configured')
    assert.equal(summary.adapter, 'gateway')
    assert.ok(Array.isArray(summary.workflows), 'workflows 须经真实网关客户端返回')
    assert.equal(summary.workflows[0].alias, 'demo')
    assert.equal('gatewayError' in summary, false, '连通后不得有网关错误')
  } finally {
    globalThis.fetch = realFetch
    host?.dispose()
    await shutdown(rt)
  }
})

test('真实 LocalAttachmentStore.saveFile 返回无 mediaType 的 ref；fileHostPath 真实可读', async () => {
  const rt = await bootRuntime()
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
    const ref = await rt.ctx.attachments.saveFile({ data: bytes, name: 'clip.bin' })
    // Video refs (saveFile) deliberately carry no mediaType (Tavern validates
    // that field as an image).
    assert.equal('mediaType' in ref, false, 'saveFile 的 ref 不得含 mediaType')
    assert.equal(ref.bytes, bytes.byteLength)
    assert.equal(typeof ref.attachmentId, 'string')
    assert.equal(ref.name, 'clip.bin')
    // The host-resolved path the plugin serves must really exist and match.
    const file = await rt.ctx.attachments.fileHostPath(ref)
    const read = await readFile(file)
    assert.ok(read.equals(bytes), 'fileHostPath 返回的文件须与写入字节一致')
  } finally {
    await shutdown(rt)
  }
})
