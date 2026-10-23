// Host-bridge tests for the standalone dsh-runninghub plugin
// No real gateway, no paid calls. Fake ctx + fake fetch + a real temporary HTTP server.
// Run with: bin/test-tavern.mjs tests/dsh-runninghub-host.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test, describe, afterEach } from 'node:test'

import { createRunningHubHost, apply, API, LIBRARY, MEDIA, REFERENCE } from '../index.mjs'

const BASE = 'http://127.0.0.1:6888'
const NEW_BASE = 'http://127.0.0.1:6889'
const DEFAULT_API_KEY = 'secret-gateway-key'

// Mirror of the package-internal credential naming so the harness can address it.
function credentialName(baseURL) {
  return 'DSH_RUNNINGHUB_' + createHash('sha256').update(baseURL).digest('hex').slice(0, 24).toUpperCase() + '_KEY'
}

// Minimal valid PNG / MP4 magic bytes so the gateway content sniffer accepts them.
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 1, 2, 3, 4])
const MP4_BYTES = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 5, 6, 7, 8])
const AUDIO_BYTES = Buffer.from([0xff, 0xfb, 0x10, 0, 1, 2])

// ---- fake HTTP surface used to invoke host.route ----
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: undefined,
    chunks: [],
    ended: false,
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; res.headersSent = true; return res },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      res.ended = true
      res.writableEnded = true
      return res
    },
    destroy() { res.destroyed = true },
  }
  return res
}
function fakeReq({ method = 'POST', url = API, headers = {}, body } = {}) {
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(body)
    },
  }
  return req
}
function resBody(res) {
  const text = Buffer.concat(res.chunks).toString('utf8')
  try { return JSON.parse(text) } catch { return text }
}

// ---- gateway fetch stub implementing the local gateway protocol ----
function makeGatewayFetch({
  kind = 'image',
  taskStatus = 'succeeded',
  workflows = null,
  onGenerations,
  settings,
  nodes,
  loraLibrary,
  referenceBytes,
  referenceType,
  referenceStatus = 200,
  portDirectiveText,
  portDirectiveRejectModes,
  optionGroups,
  defaultsConflict = false,
  galleryItems = [],
  audioLibraryItems = [],
  libraryBytes,
  libraryType,
  libraryStatus = 200,
} = {}) {
  const ext = kind === 'video' ? 'mp4' : 'png'
  const fileBytes = kind === 'video' ? MP4_BYTES : PNG_BYTES
  const fileType = kind === 'video' ? 'video/mp4' : 'image/png'
  const outPath = `/files/out/result.${ext}`
  const list = workflows ?? [{ alias: 'demo', customFields: [], referenceSlots: [], capabilities: {} }]
  const portDirectiveCalls = []
  const settingsWrites = { defaults: [], duration: [], seeds: [], modelFields: [], slots: [] }
  let generations = 0
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url)
    if (u.pathname === '/api/workflows') {
      return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/settings') {
      return new Response(JSON.stringify(settings ?? { defaultModel: 'demo' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/option-groups') {
      return new Response(JSON.stringify({ groups: optionGroups ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/defaults$/.test(u.pathname) && opts.method === 'PUT') {
      const body = JSON.parse(opts.body || '{}')
      settingsWrites.defaults.push(body)
      if (defaultsConflict) return new Response(JSON.stringify({ error: { message: '已被其他页面修改' } }), { status: 409, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ alias: 'demo', defaults: { ...body, updatedAt: 'updated-2' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/duration$/.test(u.pathname) && opts.method === 'PUT') {
      const body = JSON.parse(opts.body || '{}')
      settingsWrites.duration.push({ body, site: u.searchParams.get('site') })
      return new Response(JSON.stringify({ alias: 'demo', videoDuration: { seconds: body.seconds, fps: 24 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/seed$/.test(u.pathname) && opts.method === 'PUT') {
      const body = JSON.parse(opts.body || '{}')
      settingsWrites.seeds.push({ body, site: u.searchParams.get('site') })
      return new Response(JSON.stringify({ alias: 'demo', seedTargets: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/model-field$/.test(u.pathname) && opts.method === 'PUT') {
      settingsWrites.modelFields.push({ body: JSON.parse(opts.body || '{}'), site: u.searchParams.get('site') })
      return new Response(JSON.stringify({ alias: 'demo', modelFields: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/reference-slots\/[^/]+$/.test(u.pathname) && opts.method === 'PUT') {
      settingsWrites.slots.push({ nodeId: decodeURIComponent(u.pathname.split('/').at(-1)), body: JSON.parse(opts.body || '{}') })
      return new Response(JSON.stringify({ alias: 'demo', referenceSlots: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/nodes$/.test(u.pathname)) {
      return new Response(JSON.stringify(nodes ?? []), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/port-directive$/.test(u.pathname) && opts.method === 'POST') {
      const body = JSON.parse(opts.body || '{}')
      portDirectiveCalls.push({ alias: decodeURIComponent(u.pathname.split('/')[3]), body })
      if (portDirectiveRejectModes?.includes(body.mode)) {
        return new Response(JSON.stringify({ error: { message: '模板缺少参考图' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      if (typeof portDirectiveText !== 'string' && typeof portDirectiveText !== 'function') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      const text = typeof portDirectiveText === 'function' ? portDirectiveText(body.mode, body) : portDirectiveText
      if (typeof text !== 'string') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return new Response(JSON.stringify({ text, mode: body.mode }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/lora-library') {
      return new Response(JSON.stringify(loraLibrary ?? { loras: [], maxConcurrent: 1, enabled: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/defaults\/references\/[^/]+$/.test(u.pathname)) {
      const bytes = referenceBytes ?? fileBytes
      return new Response(bytes, { status: referenceStatus, headers: { 'content-type': referenceType ?? fileType } })
    }
    if (u.pathname === '/api/gallery') {
      return new Response(JSON.stringify(galleryItems), { status: libraryStatus, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/audio-library') {
      return new Response(JSON.stringify(audioLibraryItems), { status: libraryStatus, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/(?:gallery|audio-library)\/[^/]+\/file$/.test(u.pathname)) {
      const audio = u.pathname.startsWith('/api/audio-library/')
      return new Response(libraryBytes ?? (audio ? AUDIO_BYTES : PNG_BYTES), {
        status: libraryStatus,
        headers: { 'content-type': libraryType ?? (audio ? 'audio/mpeg' : 'image/png') },
      })
    }
    if (u.pathname === '/v1/images/generations' && (opts.method ?? 'GET') === 'POST') {
      generations += 1
      onGenerations?.(url, opts)
      return new Response(JSON.stringify({ task_id: ['task-' + generations], accepted: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/v1\/tasks\//.test(u.pathname)) {
      return new Response(JSON.stringify({ status: taskStatus, outputs: [{ path: outPath }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname.startsWith('/files/')) {
      return new Response(fileBytes, { status: 200, headers: { 'content-type': fileType } })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
  return { fetchImpl, generations: () => generations, outPath, portDirectiveCalls, settingsWrites }
}

// ---- fake attachments that actually persist bytes so media can be served back ----
function makeAttachments(calls) {
  const store = new Map()
  let seq = 0
  return {
    store,
    saveImage({ data, mediaType, name }) {
      const id = 'img-' + (++seq)
      store.set(id, { data, mediaType, name })
      calls.saveImage.push({ data, mediaType, name })
      return { attachmentId: id, name, mediaType }
    },
    saveFile({ data, name }) {
      const id = 'vid-' + (++seq)
      store.set(id, { data, name })
      calls.saveFile.push({ data, name })
      return { attachmentId: id, name, bytes: data.byteLength }
    },
    readImage(att) {
      const entry = store.get(att.attachmentId)
      assert.ok(entry, 'readImage referenced unknown attachment ' + att.attachmentId)
      return { data: entry.data }
    },
    fileHostPath(att) {
      const entry = store.get(att.attachmentId)
      assert.ok(entry, 'fileHostPath referenced unknown attachment ' + att.attachmentId)
      const tmp = join(tmpRoot, `rh-media-${att.attachmentId}.bin`)
      return writeFile(tmp, entry.data).then(() => tmp)
    },
  }
}

let tmpRoot = tmpdir()
const liveHosts = []

async function makeHost({ baseURL = BASE, configured = true, gateway = null, tavernImpl = null, clientFactory = null, pollMs = 5 } = {}) {
  const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
  const calls = { saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [], effects: [] }
  const credentialStore = new Map()
  if (configured) credentialStore.set(credentialName(baseURL), DEFAULT_API_KEY)
  const attachments = makeAttachments(calls)
  const tavern = tavernImpl ?? {
    getTurnState: async ({ gameId }) => { calls.getTurnState.push(gameId); return { settled: true, busy: false, turn: 5, textVersion: 'v1' } },
    getTurn: async ({ gameId, turn }) => { calls.getTurn.push({ gameId, turn }); return { gameId, turn, textVersion: 'v1' } },
    captureGeneration: async ({ gameId }) => ({ gameId, generationId: 'g'.repeat(64) }),
    resolveGeneration: async () => null,
    onTurnSettled: () => () => {},
    list: async () => [],
    update: async () => {},
    attach: async () => {},
  }
  const credentials = {
    resolve: async (name) => (credentialStore.has(name) ? { value: credentialStore.get(name), source: 'runtime', writable: true } : undefined),
    set: async (name, value) => { credentialStore.set(name, value); calls.credentialsSet.push([name, value]) },
    describe: async (name) => (credentialStore.has(name) ? { source: 'runtime', writable: true } : undefined),
  }
  const ctx = { attachments, credentials, tavern }
  const options = { pollMs }
  if (gateway) options.fetchImpl = gateway.fetchImpl
  if (clientFactory) options.clientFactory = clientFactory
  const host = await createRunningHubHost(ctx, { dataDirectory, baseURL }, options)
  liveHosts.push({ host, dataDirectory, calls, credentialStore })
  return { host, calls, credentialStore, ctx, dataDirectory }
}

afterEach(async () => {
  while (liveHosts.length) {
    const { host, dataDirectory } = liveHosts.pop()
    try { host.dispose() } catch {}
    try { await rm(dataDirectory, { recursive: true, force: true }) } catch {}
  }
})

async function waitForJob(host, id, predicate, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const job = await host.store.read(id)
    if (job && predicate(job)) return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('job ' + id + ' did not reach expected state')
}

// =====================================================================
describe('configure: key isolation and address change', () => {
  test('apiKey only lands in credentials, never in connection.json or return value', async () => {
    const { host, calls, dataDirectory, credentialStore } = await makeHost({ configured: false })
    const result = await host.dispatch({ action: 'configure', baseURL: BASE, apiKey: DEFAULT_API_KEY })
    assert.equal(result.configured, true)
    assert.equal(result.baseURL, BASE)
    assert.equal('apiKey' in result, false, 'return value must not leak apiKey')
    assert.equal(calls.credentialsSet.length, 1, 'key must be written through credentials.set')
    const [name, value] = calls.credentialsSet[0]
    assert.equal(name, credentialName(BASE))
    assert.equal(value, DEFAULT_API_KEY)
    const raw = await readFile(join(dataDirectory, 'connection.json'), 'utf8')
    const conn = JSON.parse(raw)
    assert.equal(conn.baseURL, BASE)
    assert.equal('apiKey' in conn, false, 'connection.json must not contain apiKey')
    assert.equal(credentialStore.get(credentialName(BASE)), DEFAULT_API_KEY)
  })

  test('new address must not reuse the old address key', async () => {
    const { host, calls } = await makeHost({ configured: true, baseURL: BASE })
    calls.credentialsSet.length = 0
    await assert.rejects(
      host.dispatch({ action: 'configure', baseURL: NEW_BASE, apiKey: undefined }),
      (e) => e.code === 'VALIDATION_ERROR',
    )
    // No key should be written to the new address credential.
    assert.equal(calls.credentialsSet.length, 0)
    const wroteToNew = calls.credentialsSet.some(([name]) => name === credentialName(NEW_BASE))
    assert.equal(wroteToNew, false, 'old key must never be forwarded to the new address')
  })

  test('active job blocks address change', async () => {
    const { host } = await makeHost({ configured: true })
    const { randomUUID } = await import('node:crypto')
    await host.store.write({
      id: randomUUID(), requestId: 'lock-active', status: 'running', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    await assert.rejects(
      host.dispatch({ action: 'configure', baseURL: NEW_BASE, apiKey: DEFAULT_API_KEY }),
      (e) => /锁定/.test(e.message),
    )
  })

  test('submit_unknown job blocks address change', async () => {
    const { host } = await makeHost({ configured: true })
    const { randomUUID } = await import('node:crypto')
    await host.store.write({
      id: randomUUID(), requestId: 'lock-unknown', status: 'submit_unknown', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    await assert.rejects(
      host.dispatch({ action: 'configure', baseURL: NEW_BASE, apiKey: DEFAULT_API_KEY }),
      (e) => /锁定/.test(e.message),
    )
  })

  test('terminal job (ready) does not block address change', async () => {
    const { host } = await makeHost({ configured: true })
    const { randomUUID } = await import('node:crypto')
    await host.store.write({
      id: randomUUID(), requestId: 'lock-ready', status: 'ready', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    const result = await host.dispatch({ action: 'configure', baseURL: NEW_BASE, apiKey: DEFAULT_API_KEY })
    assert.equal(result.baseURL, NEW_BASE)
  })

  test('invalid (non-loopback http) baseURL is rejected and writes nothing', async () => {
    const { host, dataDirectory, calls } = await makeHost({ configured: false })
    await assert.rejects(
      host.dispatch({ action: 'configure', baseURL: 'http://8.8.8.8:6888', apiKey: DEFAULT_API_KEY }),
      (e) => e.code === 'VALIDATION_ERROR',
    )
    assert.equal(calls.credentialsSet.length, 0)
    const { access } = await import('node:fs/promises')
    await assert.rejects(access(join(dataDirectory, 'connection.json')))
  })
})

// =====================================================================
describe('route: cross-site / method / body limits', () => {
  test('cross-site request rejected with 403', async () => {
    const { host } = await makeHost({ configured: false })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API, headers: { 'sec-fetch-site': 'cross-site' } }), res)
    assert.equal(res.statusCode, 403)
  })

  test('same-site request rejected with 403', async () => {
    const { host } = await makeHost({ configured: false })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API, headers: { 'sec-fetch-site': 'same-site' } }), res)
    assert.equal(res.statusCode, 403)
  })

  test('unsupported method (PUT) rejected with 405', async () => {
    const { host } = await makeHost({ configured: false })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'PUT', url: API }), res)
    assert.equal(res.statusCode, 405)
  })

  test('non-JSON content-type rejected with 415', async () => {
    const { host } = await makeHost({ configured: true })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'POST', url: API, headers: { 'content-type': 'text/plain' }, body: 'hello' }), res)
    assert.equal(res.statusCode, 415)
  })

  test('JSON body over 25MB rejected with 413', async () => {
    const { host } = await makeHost({ configured: true })
    const res = fakeRes()
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0x20)
    await host.route(fakeReq({ method: 'POST', url: API, headers: { 'content-type': 'application/json' }, body: big }), res)
    assert.equal(res.statusCode, 413)
  })

  test('unknown path returns 404', async () => {
    const { host } = await makeHost({ configured: false })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: '/api/dsh-runninghub/unknown' }), res)
    assert.equal(res.statusCode, 404)
  })

  test('describe over HTTP when not configured returns 409', async () => {
    const { host } = await makeHost({ configured: false })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'POST', url: API, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'describe', model: 'demo' }) }), res)
    assert.equal(res.statusCode, 409)
  })
})

// =====================================================================
describe('GET history still surfaces gatewayError when gateway is down', () => {
  test('configured but disconnected gateway returns gatewayError and history', async () => {
    const brokenFetch = async () => { throw new Error('connection refused') }
    const { host } = await makeHost({ configured: true, gateway: { fetchImpl: brokenFetch } })
    const { randomUUID } = await import('node:crypto')
    await host.store.write({
      id: randomUUID(), requestId: 'hist-1', status: 'ready', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    assert.equal(res.statusCode, 200)
    const body = resBody(res)
    assert.ok(body.gatewayError, 'gatewayError must be present when gateway is down')
    assert.ok(Array.isArray(body.jobs), 'history (jobs) must still be returned')
    assert.ok(body.jobs.some(j => j.requestId === 'hist-1'), 'existing job history must be returned')
  })
})

// =====================================================================
describe('submit: parameter validation before acceptance', () => {
  test('invalid requestId rejected before any job is created', async () => {
    const { host, calls } = await makeHost({ configured: true, gateway: makeGatewayFetch() })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: '../evil', input: { model: 'demo', prompt: 'x' }, bindToTurn: false }),
      (e) => e.code === 'VALIDATION_ERROR',
    )
    const jobs = await host.store.list()
    assert.equal(jobs.length, 0, 'no job may be persisted for an invalid requestId')
  })

  test('workflow override rejected: the panel selection wins', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch() })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-unknown-model', input: { model: 'nope', prompt: 'x' }, bindToTurn: false }),
      (e) => /工作流由面板选择/.test(e.message),
    )
    const jobs = await host.store.list()
    assert.equal(jobs.length, 0, 'no job may be persisted when the model tries to pick a workflow')
  })

  test('bindToTurn without gameId is rejected before acceptance', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch() })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-nogame', input: { model: 'demo', prompt: 'x' }, bindToTurn: true }),
      (e) => /绑定轮次需要当前游戏 ID/.test(e.message),
    )
    assert.equal((await host.store.list()).length, 0)
  })
})

// =====================================================================
describe('submit: concurrent requestId submits once; retry does not rebind turn', () => {
  test('two concurrent submits with same requestId hit the gateway exactly once', async () => {
    const gateway = makeGatewayFetch()
    const { host } = await makeHost({ configured: true, gateway })
    const [a, b] = await Promise.all([
      host.dispatch({ action: 'submit', requestId: 'req-dup', input: { model: 'demo', prompt: 'x' }, bindToTurn: false }),
      host.dispatch({ action: 'submit', requestId: 'req-dup', input: { model: 'demo', prompt: 'x' }, bindToTurn: false }),
    ])
    // submit returns a durable preparing job; remote acceptance is asynchronous.
    await waitForJob(host, a.id, job => Boolean(job.remoteTaskId))
    assert.equal(gateway.generations(), 1, 'gateway /v1/images/generations must be called exactly once')
    assert.equal(a.id, b.id, 'both calls must return the same job')
    const jobs = await host.store.list()
    assert.equal(jobs.length, 1, 'only one job may exist for a deduplicated requestId')
  })

  test('retry with same requestId does not re-run binding (no rebind to a new turn)', async () => {
    const gateway = makeGatewayFetch()
    let turnNow = 5
    const turnStateCalls = []
    const tavernImpl = {
      getTurnState: async ({ gameId }) => { turnStateCalls.push(gameId); return { settled: true, busy: false, turn: turnNow, textVersion: 'v1' } },
      getTurn: async ({ gameId, turn }) => ({ gameId, turn, textVersion: 'v1' }),
      list: async () => [],
      update: async () => {},
      attach: async () => {},
    }
    const { host } = await makeHost({ configured: true, gateway, tavernImpl })
    const first = await host.dispatch({ action: 'submit', requestId: 'req-bind', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-1' })
    assert.equal(turnStateCalls.length, 1, 'binding should call getTurnState once on first submit')
    // Game advances; a retry must not re-fetch turn state / rebind to turn 6.
    turnNow = 6
    const retry = await host.dispatch({ action: 'submit', requestId: 'req-bind', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-1' })
    assert.equal(turnStateCalls.length, 1, 'retry must NOT re-run bindingOf (getTurnState)')
    assert.equal(retry.id, first.id)
    assert.equal(retry.binding?.turn, 5, 'returned job must keep the original bound turn')
  })

  test('慢提交不占全局锁：另一条 jobs 查询不用等它', async () => {
    const gateway = makeGatewayFetch()
    // 让 describe 的节点请求卡住，提交就会停在锁外；此时 jobs 必须立刻返回。
    // 旧实现把整个 submit 包在全局串行锁里，jobs 会被一起卡住。
    let release
    const blocked = new Promise(resolve => { release = resolve })
    let entered
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const fetchImpl = async (url, opts = {}) => {
      if (/^\/api\/workflows\/[^/]+\/nodes$/.test(new URL(url).pathname)) {
        entered()
        await blocked
      }
      return gateway.fetchImpl(url, opts)
    }
    const { host } = await makeHost({ configured: true, gateway: { ...gateway, fetchImpl } })
    const pending = host.dispatch({ action: 'submit', requestId: 'slow-1', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await enteredPromise
    const result = await Promise.race([
      host.dispatch({ action: 'jobs' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('jobs 被提交挡住了：submit 仍占着全局锁')), 300)),
    ])
    assert.deepEqual(result.jobs, [], '还没有任务时 jobs 应返回空')
    release()
    const job = await pending
    assert.ok(job.id, '放开 describe 后提交应正常建任务')
  })
})

// =====================================================================
describe('jobs: lightweight status feed for the composer dock', () => {
  test('returns only this game’s jobs and never connects to the gateway', async () => {
    const gateway = makeGatewayFetch({ taskStatus: 'running' })
    const { host } = await makeHost({ configured: true, gateway })
    const bound = await host.dispatch({ action: 'submit', requestId: 'dock-bound', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-dock' })
    const free = await host.dispatch({ action: 'submit', requestId: 'dock-free', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    // Both submissions are accepted in the background; wait for both before counting,
    // so a still-in-flight acceptance cannot be mistaken for the `jobs` call connecting.
    await waitForJob(host, bound.id, job => Boolean(job.remoteTaskId))
    await waitForJob(host, free.id, job => Boolean(job.remoteTaskId))
    const generations = gateway.generations()
    const result = await host.dispatch({ action: 'jobs', gameId: 'game-dock' })
    assert.deepEqual(result.jobs.map(job => job.id), [bound.id], 'other games / unbound jobs must not leak into the dock')
    assert.equal(result.jobs[0].binding?.gameId, 'game-dock')
    assert.ok(['queued', 'running'].includes(result.jobs[0].status), 'the dock needs a live status while the video is running')
    assert.equal(gateway.generations(), generations, 'jobs stays local: no gateway call')
  })

  test('a bad gameId is rejected instead of listing every job', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch() })
    await assert.rejects(host.dispatch({ action: 'jobs', gameId: 42 }), (e) => e.code === 'VALIDATION_ERROR')
  })
})

// =====================================================================
describe('binding: getTurnState + getTurn version pinning', () => {
  test('mismatched textVersion is rejected before submit', async () => {
    const gateway = makeGatewayFetch()
    const tavernImpl = {
      getTurnState: async () => ({ settled: true, busy: false, turn: 5, textVersion: 'v1' }),
      getTurn: async () => ({ gameId: 'game-1', turn: 5, textVersion: 'v2' }),
      list: async () => [], update: async () => {}, attach: async () => {},
    }
    const { host } = await makeHost({ configured: true, gateway, tavernImpl })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-mismatch', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-1' }),
      (e) => /正文版本已变化/.test(e.message),
    )
    const jobs = await host.store.list()
    assert.equal(jobs.length, 0)
  })

  test('successful binding pins gameId/turn/textVersion', async () => {
    const gateway = makeGatewayFetch()
    const { host } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-pin', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-1' })
    assert.deepEqual(job.binding, { gameId: 'game-1', turn: 5, textVersion: 'v1' })
  })

  test('bindToTurn submit downloads and binds media via tavern.list/attach', async () => {
    const gateway = makeGatewayFetch({ kind: 'image' })
    const listCalls = []
    const attachCalls = []
    const tavernImpl = {
      getTurnState: async () => ({ settled: true, busy: false, turn: 5, textVersion: 'v1' }),
      getTurn: async ({ gameId, turn }) => ({ gameId, turn, textVersion: 'v1' }),
      list: async (q) => { listCalls.push(q); return [] },
      update: async () => {},
      attach: async (spec) => { attachCalls.push(spec); return { id: 'att-1' } },
    }
    const { host } = await makeHost({ configured: true, gateway, tavernImpl })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-bindfull', input: { model: 'demo', prompt: 'x' }, bindToTurn: true, gameId: 'game-1' })
    const ready = await waitForJob(host, job.id, j => j.status === 'ready')
    assert.equal(ready.binding?.turn, 5)
    assert.ok(listCalls.some(q => q.gameId === 'game-1' && q.turn === 5), 'bindMedia must query tavern.list for the bound turn')
    assert.ok(attachCalls.length >= 1, 'bindMedia must attach the media to the bound turn')
  })
})

// =====================================================================
describe('onMedia: image uses saveImage(with mediaType), video uses saveFile(without mediaType)', () => {
  test('image download calls saveImage with mediaType', async () => {
    const gateway = makeGatewayFetch({ kind: 'image' })
    const { host, calls } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-img', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await waitForJob(host, job.id, j => j.status === 'ready')
    assert.equal(calls.saveImage.length, 1, 'image must call saveImage')
    assert.equal(calls.saveFile.length, 0, 'image must not call saveFile')
    assert.equal(calls.saveImage[0].mediaType, 'image/png', 'saveImage must receive mediaType')
  })

  test('video download calls saveFile without mediaType', async () => {
    const gateway = makeGatewayFetch({ kind: 'video' })
    const { host, calls } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-vid', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await waitForJob(host, job.id, j => j.status === 'ready')
    assert.equal(calls.saveFile.length, 1, 'video must call saveFile')
    assert.equal(calls.saveImage.length, 0, 'video must not call saveImage')
    assert.equal('mediaType' in calls.saveFile[0], false, 'saveFile must NOT receive mediaType')
  })
})

// =====================================================================
describe('media serving via a real temporary HTTP server', () => {
  async function serveJob(host, jobId) {
    const server = createServer((req, res) => { host.route(req, res) })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`
    return {
      base,
      server,
      get: (qs) => fetch(`${base}${MEDIA}?${qs}`),
      head: (qs) => fetch(`${base}${MEDIA}?${qs}`, { method: 'HEAD' }),
      close: () => new Promise(r => server.close(r)),
    }
  }

  test('image: GET/HEAD/Range 206/416 all served correctly', async () => {
    const gateway = makeGatewayFetch({ kind: 'image' })
    const { host } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-serve-img', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await waitForJob(host, job.id, j => j.status === 'ready')
    const srv = await serveJob(host, job.id)
    try {
      const get = await srv.get(`id=${job.id}&index=0`)
      assert.equal(get.status, 200)
      assert.equal(get.headers.get('content-type'), 'image/png')
      assert.equal(get.headers.get('accept-ranges'), 'bytes')
      const buf = Buffer.from(await get.arrayBuffer())
      assert.equal(buf.length, PNG_BYTES.length)
      assert.ok(buf.equals(PNG_BYTES), 'served bytes must equal the stored image')

      const head = await srv.head(`id=${job.id}&index=0`)
      assert.equal(head.status, 200)
      assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD must not return a body')

      const ranged = await fetch(`${srv.base}${MEDIA}?id=${job.id}&index=0`, { headers: { range: 'bytes=0-3' } })
      assert.equal(ranged.status, 206, 'partial content expected')
      assert.match(ranged.headers.get('content-range'), /^bytes 0-3\//)
      const partial = Buffer.from(await ranged.arrayBuffer())
      assert.equal(partial.length, 4)
      assert.ok(partial.equals(PNG_BYTES.subarray(0, 4)))

      const badRange = await fetch(`${srv.base}${MEDIA}?id=${job.id}&index=0`, { headers: { range: 'bytes=999999-' } })
      assert.equal(badRange.status, 416, 'out-of-range request must be 416')
    } finally {
      await srv.close()
    }
  })

  test('video: GET with Range 206 served correctly', async () => {
    const gateway = makeGatewayFetch({ kind: 'video' })
    const { host } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-serve-vid', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await waitForJob(host, job.id, j => j.status === 'ready')
    const srv = await serveJob(host, job.id)
    try {
      const ranged = await fetch(`${srv.base}${MEDIA}?id=${job.id}&index=0`, { headers: { range: 'bytes=0-3' } })
      assert.equal(ranged.status, 206)
      assert.match(ranged.headers.get('content-range'), /^bytes 0-3\//)
      const partial = Buffer.from(await ranged.arrayBuffer())
      assert.equal(partial.length, 4)
      assert.ok(partial.equals(MP4_BYTES.subarray(0, 4)))
    } finally {
      await srv.close()
    }
  })

  test('unrecorded job / out-of-range index / non-UUID id cannot be read', async () => {
    const gateway = makeGatewayFetch({ kind: 'image' })
    const { host } = await makeHost({ configured: true, gateway })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-serve-secure', input: { model: 'demo', prompt: 'x' }, bindToTurn: false })
    await waitForJob(host, job.id, j => j.status === 'ready')
    const srv = await serveJob(host, job.id)
    try {
      const unrecorded = await srv.get(`id=${'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}&index=0`)
      assert.equal(unrecorded.status, 404, 'unrecorded job must not be readable')

      const outOfRange = await srv.get(`id=${job.id}&index=99`)
      assert.equal(outOfRange.status, 404, 'out-of-range index must not be readable')

      const badId = await srv.get(`id=not-a-uuid&index=0`)
      assert.equal(badId.status, 400, 'non-UUID id must be rejected')

      const badIndex = await srv.get(`id=${job.id}&index=abc`)
      assert.equal(badIndex.status, 400, 'invalid index must be rejected')
    } finally {
      await srv.close()
    }
  })
})

// =====================================================================
describe('summary: model follows server defaultModel then first usable, settings errors isolated', () => {
  function wfList(aliases, broken = []) {
    return aliases.map((alias) => broken.includes(alias)
      ? { alias, broken: true, brokenReason: 'x', capabilities: {} }
      : { alias, customFields: [], referenceSlots: [], capabilities: {}, defaults: { references: [], updatedAt: 'u' } })
  }

  test('model follows settings defaultModel when it matches a usable workflow', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch({ workflows: wfList(['img', 'vid']), settings: { defaultModel: 'vid' } }) })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    assert.equal(resBody(res).model, 'vid', 'summary.model 应为服务端默认 vid')
  })

  test('model falls back to first usable workflow when defaultModel missing or invalid', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch({ workflows: wfList(['img', 'vid']), settings: { defaultModel: 'nope' } }) })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    assert.equal(resBody(res).model, 'img', '应回落到第一个可用工作流')
  })

  test('broken workflow is never selected as model', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch({ workflows: wfList(['broken1', 'ok'], ['broken1']), settings: { defaultModel: 'broken1' } }) })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    assert.equal(resBody(res).model, 'ok', 'broken 工作流不得作为 model')
  })

  test('settings fetch failure surfaces settingsError but keeps workflows', async () => {
    const gateway = makeGatewayFetch({ workflows: wfList(['ok']) })
    const orig = gateway.fetchImpl
    gateway.fetchImpl = async (url, opts) => {
      if (new URL(url).pathname === '/api/settings') throw new Error('settings unavailable')
      return orig(url, opts)
    }
    const { host } = await makeHost({ configured: true, gateway })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    const body = resBody(res)
    assert.ok(body.settingsError, 'settings 失败应单独告知')
    assert.ok(Array.isArray(body.workflows) && body.workflows.length === 1, 'workflows 不得因 settings 失败丢失')
    assert.equal(body.model, 'ok', 'settings 失败时回落到第一个可用')
  })

  test('old clientFactory without getSettings degrades to first usable', async () => {
    const oldClient = { listWorkflows: async () => wfList(['img', 'vid']), describe: async (alias) => wfList(['img', 'vid']).find((w) => w.alias === alias) }
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch({ workflows: wfList(['img', 'vid']) }), clientFactory: () => oldClient })
    const res = fakeRes()
    await host.route(fakeReq({ method: 'GET', url: API }), res)
    assert.equal(resBody(res).model, 'img', '无 getSettings 时应回落到第一个可用')
  })
})

// =====================================================================
describe('workflow selection: panel state drives tools and prompt template', () => {
  const workflows = [
    { alias: 'demo', revision: 'r-demo', customFields: [], referenceSlots: [], capabilities: {}, defaults: {} },
    { alias: 'video', revision: 'r-video', defaultEnhanceMode: 't2i-h3', videoDuration: { seconds: 5 },
      pipeline: { kind: 'first-frame', imageWorkflowAlias: 'Krea2' },
      customFields: [{ key: 'image_prompt', label: '生图提示词', type: 'text' }], referenceSlots: [], capabilities: {}, defaults: {} },
  ]
  const template = '【模板】image### … ### / video### … ###\n\n（用法说明，这一段不用发给 LLM：不要发送）'

  test('select-model persists the choice and returns its template mode', async () => {
    const { host, dataDirectory } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    const selected = await host.dispatch({ action: 'select-model', model: 'video' })
    assert.equal(selected.model, 'video')
    assert.equal(selected.templateMode, 't2i-h3')
    assert.equal(selected.templateError, undefined)
    const saved = JSON.parse(await readFile(join(dataDirectory, 'selection.json'), 'utf8'))
    assert.equal(saved.model, 'video')
    const listed = await host.dispatch({ action: 'list' })
    assert.equal(listed.model, 'video', 'summary.model 应优先使用面板选择')
    assert.equal(listed.templateMode, 't2i-h3')
    assert.equal(listed.templateError, undefined)
  })

  test('first-frame Qwen pipeline sends image-side defaults so qwen-multi-h3 can build', async () => {
    const qwenPipe = {
      alias: 'qwen-pipe', revision: 'r-qwen-pipe', defaultEnhanceMode: 'qwen-multi-h3',
      videoDuration: { seconds: 5 },
      pipeline: { kind: 'first-frame', imageWorkflowAlias: 'QwenImage21-多图生图', videoWorkflowAlias: 'H3-图生视频' },
      customFields: [], referenceSlots: [], capabilities: {}, defaults: {},
    }
    const qwenImage = {
      alias: 'QwenImage21-多图生图', revision: 'r-qwen-img',
      customFields: [], capabilities: {},
      referenceSlots: [{ nodeId: '601', kind: 'image', label: '参考图 1', tag: '<Picture 1>', role: 'images.image_1' }],
      defaults: { references: [{ nodeId: '601', kind: 'image', name: 'a.png', mimeType: 'image/png', note: '女主外貌' }] },
    }
    const h3Video = {
      alias: 'H3-图生视频', revision: 'r-h3-video',
      customFields: [], capabilities: {},
      referenceSlots: [{ nodeId: '114', kind: 'image', label: '首帧', tag: '<Picture 1>', role: 'first_frame' }],
      defaults: {},
    }
    const gateway = makeGatewayFetch({ workflows: [qwenPipe, qwenImage, h3Video], settings: { defaultModel: 'qwen-pipe' }, portDirectiveText: template })
    const { host } = await makeHost({ configured: true, gateway })
    const selected = await host.dispatch({ action: 'select-model', model: 'qwen-pipe' })
    assert.equal(selected.templateMode, 'qwen-multi-h3')
    assert.equal(gateway.portDirectiveCalls.length, 1)
    const body = gateway.portDirectiveCalls[0].body
    assert.deepEqual(body.references, [{ kind: 'image', label: '生图·参考图 1', tag: '<image1>', note: '女主外貌' }])
    assert.deepEqual(body.mediaLimits, { picture: 1, video: 0, audio: 0 })
    assert.equal(body.durationSeconds, 5)
  })

  test('reference workflows inject the picture-binding rule and rewrite “只引用用户提到过的素材”', async () => {
    const refFlow = {
      alias: 'h3-ref', revision: 'r-ref', defaultEnhanceMode: 'h3-ref2va', videoDuration: { seconds: 7 },
      customFields: [], capabilities: {},
      referenceSlots: [{ nodeId: '37', kind: 'image', label: '参考图 1', role: 'ref_images.ref_image_0', tag: '<Picture 1>', bypassed: false }],
      defaults: { references: [{ nodeId: '37', kind: 'image', name: '人物设定.png', note: '女主身高1米7,外貌、身材' }] },
    }
    const directive = '【模板】\n- **只引用用户真的提到过的素材**，不要为了凑格式编出 <Picture 2>。\n模板正文。'
    const gateway = makeGatewayFetch({ workflows: [refFlow], settings: { defaultModel: 'h3-ref' }, portDirectiveText: directive })
    const { host } = await makeHost({ configured: true, gateway })
    await host.dispatch({ action: 'select-model', model: 'h3-ref' })
    const text = host.promptText()
    assert.match(text, /【参考素材 · 优先级最高】/)
    assert.match(text, /<Picture 1>：人物设定\.png，女主身高1米7,外貌、身材/)
    assert.match(text, /is the woman in <Picture 1>/)
    assert.match(text, /漏了参考图就不参与生成/)
    assert.equal(text.includes('只引用用户真的提到过的素材'), false, '这句会被模型读成“没提到就不用写”')
    assert.match(text, /默认素材清单里的标签要按用途写进提示词/)
  })

  test('a 400 template falls back to the next compatible mode', async () => {
    const qwenPipe = {
      alias: 'qwen-pipe-empty', revision: 'r-qwen-empty', defaultEnhanceMode: 'qwen-multi-h3',
      videoDuration: { seconds: 5 },
      pipeline: { kind: 'first-frame', imageWorkflowAlias: 'missing-image', videoWorkflowAlias: 'H3-图生视频' },
      customFields: [], referenceSlots: [], capabilities: {}, defaults: {},
    }
    const h3Video = { alias: 'H3-图生视频', customFields: [], capabilities: {}, referenceSlots: [], defaults: {} }
    const gateway = makeGatewayFetch({ workflows: [qwenPipe, h3Video], settings: { defaultModel: 'qwen-pipe-empty' },
      portDirectiveText: template, portDirectiveRejectModes: ['qwen-multi-h3'] })
    const { host } = await makeHost({ configured: true, gateway })
    const selected = await host.dispatch({ action: 'select-model', model: 'qwen-pipe-empty' })
    assert.equal(selected.templateMode, 'qwen-h3')
    assert.equal(selected.templateError, undefined)
    assert.deepEqual(gateway.portDirectiveCalls.map((call) => call.body.mode), ['qwen-multi-h3', 'qwen-h3'])
  })

  test('auto-insert injects the template and the current-turn generation flow', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'preferences', autoInsert: true })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const text = host.promptText()
    assert.match(text, /【模板】/)
    assert.match(text, /本回合生成 3 段视频/)
    assert.match(text, /提交 3 段（不要多也不要少）/)
    assert.match(text, /本轮正文/)
    assert.match(text, /不要重播上一轮已经写过的画面/)
    assert.match(text, /同一条回复里先调用 runninghub_generate/)
    assert.match(text, /紧接着在同一条回复里调用 submit_story/)
    assert.match(text, /submit_story 必须是这条回复的最后一个工具调用/)
    assert.equal(text.includes('全部提交后再调用'), false, '不能要求等工具结果再提交正文，否则会多一次模型请求')
    assert.equal(text.includes('只有玩家明确要求'), false)
    assert.equal(text.includes('玩家没要求'), false)
  })

  test('auto-insert off still injects the template but not the generation flow', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    assert.equal(host.autoInsert, false)
    const text = host.promptText()
    assert.match(text, /【模板】/)
    assert.equal(text.includes('本回合生成'), false, '自动插入关闭时不应注入自动插入流程')
    assert.equal(text.includes('只有玩家明确要求'), false, '不应再保留旧的玩家要求条件')
    assert.equal(text.includes('玩家没要求'), false)
  })

  test('videosPerTurn changes the count in both the prompt and the per-turn reminder', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'preferences', autoInsert: true })
    await host.dispatch({ action: 'select-model', model: 'video' })
    assert.match(host.turnReminder(), /挑 3 个瞬间/)
    assert.match(host.turnReminder(), /同一条回复里调用 runninghub_generate/)
    assert.match(host.turnReminder(), /submit_story/)
    assert.match(host.promptText(), /本回合生成 3 段视频/)
    const saved = await host.dispatch({ action: 'preferences', videosPerTurn: 5 })
    assert.equal(saved.videosPerTurn, 5)
    assert.match(host.turnReminder(), /挑 5 个瞬间/)
    assert.match(host.promptText(), /本回合生成 5 段视频/)
    for (const value of [0, 11, 2.5, '5']) {
      await assert.rejects(host.dispatch({ action: 'preferences', videosPerTurn: value }), /1–10 的整数/)
    }
    assert.equal((await host.dispatch({ action: 'list' })).videosPerTurn, 5)
    await host.dispatch({ action: 'preferences', autoInsert: false })
    assert.equal(host.turnReminder(), '', '自动插入关闭时不应每轮提醒')
  })

  test('describe reports the template is sent and no longer advertises a skill', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const described = await host.dispatch({ action: 'describe' })
    assert.equal('promptSkill' in described, false)
    assert.equal(described.promptTemplateReady, true)
    assert.equal(described.promptTemplateEnabled, true)
    assert.equal(described.promptTemplateSent, true)
    assert.equal(described.promptMode, 't2i-h3')
  })

  test('long templates are split into ordered prompt sections under the 8000-char limit', async () => {
    const bigTemplate = Array.from({ length: 600 }, (_, index) => `line ${String(index).padStart(3, '0')} ` + 'x'.repeat(48)).join('\n')
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: bigTemplate }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const full = host.promptText()
    assert.ok(full.length > 8000, 'fixture should exceed one prompt section')
    const sections = host.promptSections()
    assert.ok(sections.length > 1)
    for (const section of sections) assert.ok(section.length <= 7600, '每段必须低于 Tavern 的 8000 字上限')
    const joined = sections.join('\n')
    assert.match(joined, /line 000 /)
    assert.match(joined, /line 599 /)
    assert.ok(joined.indexOf('line 000 ') < joined.indexOf('line 599 '), '模板片段顺序不能乱')
  })

  test('switching the selected workflow updates the injected template on the next read', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: mode => `【模板】${mode}` }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    assert.match(host.promptText(), /【模板】t2i-h3/)
    await host.dispatch({ action: 'select-model', model: 'demo' })
    const text = host.promptText()
    assert.match(text, /【模板】krea2-image/)
    assert.equal(text.includes('【模板】t2i-h3'), false)
  })

  test('turning the prompt switch off stops injection and rejects model submissions, but the panel still works', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const saved = await host.dispatch({ action: 'preferences', alwaysSendPrompt: false })
    assert.equal(saved.alwaysSendPrompt, false)
    assert.equal((await host.dispatch({ action: 'list' })).alwaysSendPrompt, false)
    assert.equal(host.promptText(), '')
    assert.deepEqual(host.promptSections(), [])
    const described = await host.dispatch({ action: 'describe' })
    assert.equal(described.promptTemplateEnabled, false)
    assert.equal(described.promptTemplateSent, false)
    const toolExec = { agent: { session: { id: 'game-1' } } }
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-switch-off', bindToTurn: false,
        input: { prompt: 'B shot' } }, toolExec),
      /总是发送提示词模板/,
    )
    // 面板手动提交不经过 exec，仍然允许（玩家可能只想快速试参数）。
    const job = await host.dispatch({ action: 'submit', requestId: 'req-panel-off', bindToTurn: false,
      input: { prompt: 'B shot', image_prompt: 'A shot' } })
    await waitForJob(host, job.id, value => Boolean(value.remoteTaskId))
  })

  test('auto-insert off rejects model submissions at the host, but the panel still works', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    assert.equal(host.autoInsert, false)
    const toolExec = { agent: { session: { id: 'game-1' } } }
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-model-auto-off', bindToTurn: false,
        input: { prompt: 'B shot' } }, toolExec),
      /自动插入已关闭/,
    )
    const job = await host.dispatch({ action: 'submit', requestId: 'req-panel-auto-off', bindToTurn: false,
      input: { prompt: 'B shot', image_prompt: 'A shot' } })
    await waitForJob(host, job.id, value => Boolean(value.remoteTaskId))
  })

  test('submit uses the selected workflow and splits image### / video### into custom.image_prompt + prompt', async () => {
    let body
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template,
        onGenerations: (_url, opts) => { body = JSON.parse(opts.body) } }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-video', bindToTurn: false,
      input: { prompt: 'image###\nA《Picture 1》\n###\n\nvideo###\nB shot\n###' } })
    await waitForJob(host, job.id, value => Boolean(value.remoteTaskId))
    assert.equal(body.model, 'video')
    assert.equal(body.prompt, 'B shot')
    assert.equal(body.custom.image_prompt, 'A<Picture 1>')
  })

  test('submit accepts structured image_prompt + prompt without any fences', async () => {
    let body
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template,
        onGenerations: (_url, opts) => { body = JSON.parse(opts.body) } }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const job = await host.dispatch({ action: 'submit', requestId: 'req-structured', bindToTurn: false,
      input: { prompt: 'B shot', image_prompt: 'A《Picture 1》' } })
    await waitForJob(host, job.id, value => Boolean(value.remoteTaskId))
    assert.equal(body.model, 'video')
    assert.equal(body.prompt, 'B shot')
    assert.equal(body.custom.image_prompt, 'A<Picture 1>', '结构化字段也要把书名号还原成尖括号')
  })

  test('image_prompt is rejected for a non-pipeline workflow', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-no-pipe', bindToTurn: false,
        input: { prompt: 'x', image_prompt: 'y' } }),
      /不是管线/,
    )
    assert.equal((await host.store.list()).length, 0)
  })

  test('injected template is rewritten for native tool calls, without image### / video### fences', async () => {
    const gatewayTemplate = [
      '【提示词写法 · 测试】',
      '两段都要写。',
      '需要出视频时，按这些规则写好提示词。',
      '',
      '【输出格式】',
      '两段各自用末尾那节【输出包裹格式】给的标记包起来：image### 包住生图段，video### 包住视频段。',
      '',
      '【输出包裹格式 · 端口调用（本节优先级最高）】',
      'image###',
      '……',
      '###',
      'video###',
      '……',
      '###',
      '- 标记逐字写成 `image###`、`video###` 与 `###`。',
    ].join('\n')
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: gatewayTemplate }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    const injected = host.promptText()
    assert.match(injected, /生图段放进 input\.image_prompt/)
    assert.match(injected, /视频段放进 input\.prompt/)
    assert.equal(injected.includes('需要出视频时'), false, '条件句式应被删掉')
    assert.equal(injected.includes('输出包裹格式'), false, '原生工具不应再让模型看包裹格式')
    assert.equal(/image###|video###/.test(injected), false, '注入的模板不应再出现文本标记')
  })

  test('the model cannot override the panel selection', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' }, portDirectiveText: template }) })
    await host.dispatch({ action: 'select-model', model: 'video' })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-override', bindToTurn: false, input: { model: 'demo', prompt: 'x' } }),
      (error) => /工作流由面板选择/.test(error.message),
    )
    assert.equal((await host.store.list()).length, 0)
  })

  test('template fetch failure is surfaced but does not break selection', async () => {
    const { host } = await makeHost({ configured: true,
      gateway: makeGatewayFetch({ workflows, settings: { defaultModel: 'demo' } }) })
    const selected = await host.dispatch({ action: 'select-model', model: 'video' })
    assert.equal(selected.model, 'video')
    assert.ok(selected.templateError, '模板不可用时应给出错误')
    const text = host.promptText()
    assert.match(text, /当前工作流的提示词模板不可用/)
    assert.match(text, /不要调用 runninghub_generate/)
    assert.equal(text.includes('请让玩家'), false)
    assert.equal(text.includes('只有玩家'), false)
    assert.equal(text.includes('runninghub-current'), false)
  })
})

// =====================================================================
describe('workflow settings: save-settings writes the same gateway defaults as the admin console', () => {
  function settingsWorkflow() {
    return {
      alias: 'demo',
      primarySite: 'international',
      customFields: [{ key: 'quality', label: '质量', type: 'number', min: 1, max: 10 }],
      referenceSlots: [
        { nodeId: '9', kind: 'image', label: '参考图' },
        { nodeId: '10', kind: 'image', label: '旁路图', bypassed: true },
      ],
      seedTargets: [{ target: '5.seed', nodeId: '5', field: 'seed', classType: 'KSampler', templateValue: 1 }],
      modelFields: [{ target: '6.unet_name', nodeId: '6', field: 'unet_name', classType: 'UNETLoader', value: 'a', canvasValue: 'b' }],
      capabilities: { resolutionFields: ['aspect_ratio'] },
      defaults: {
        updatedAt: 'updated-1',
        resolution: { aspect_ratio: '16:9' },
        custom: { quality: 3 },
        references: [{ nodeId: '9', kind: 'image', name: 'a.png' }],
        referencePools: [],
        presetIds: [],
        promptSuffix: '',
      },
      videoDuration: { seconds: 5, fps: 24 },
    }
  }

  test('writes defaults, duration, seed, model field and reference slot, then re-describes', async () => {
    const gateway = makeGatewayFetch({ workflows: [settingsWorkflow()], settings: { defaultModel: 'demo' } })
    const { host } = await makeHost({ configured: true, gateway })
    const result = await host.dispatch({
      action: 'save-settings',
      model: 'demo',
      defaults: {
        presetIds: [],
        promptSuffix: '',
        resolution: { aspect_ratio: '9:16' },
        custom: { quality: 7 },
        references: [{ nodeId: '9', kind: 'image', note: '新备注' }],
        referencePools: [],
        baseUpdatedAt: 'updated-1',
      },
      duration: { seconds: 8 },
      seeds: [{ target: '5.seed', value: 42 }],
      modelFields: [{ target: '6.unet_name', value: 'c' }],
      referenceSlots: [{ nodeId: '10', enabled: true }],
    })
    assert.equal(result.model, 'demo')
    assert.equal(result.workflow.alias, 'demo')
    assert.deepEqual(gateway.settingsWrites.slots, [{ nodeId: '10', body: { enabled: true } }])
    assert.equal(gateway.settingsWrites.defaults.length, 1)
    assert.deepEqual(gateway.settingsWrites.defaults[0], {
      presetIds: [], promptSuffix: '', resolution: { aspect_ratio: '9:16' }, custom: { quality: 7 },
      references: [{ nodeId: '9', kind: 'image', note: '新备注' }], referencePools: [], baseUpdatedAt: 'updated-1',
    })
    assert.deepEqual(gateway.settingsWrites.duration, [{ body: { seconds: 8 }, site: 'international' }])
    assert.deepEqual(gateway.settingsWrites.seeds, [{ body: { target: '5.seed', value: 42 }, site: 'international' }])
    assert.deepEqual(gateway.settingsWrites.modelFields, [{ body: { target: '6.unet_name', value: 'c' }, site: 'international' }])
  })

  test('rejects a model that disagrees with the panel selection', async () => {
    const gateway = makeGatewayFetch({ workflows: [settingsWorkflow()], settings: { defaultModel: 'demo' } })
    const { host } = await makeHost({ configured: true, gateway })
    await assert.rejects(
      host.dispatch({ action: 'save-settings', model: 'other', defaults: {} }),
      /工作流由面板选择/,
    )
    assert.equal(gateway.settingsWrites.defaults.length, 0)
  })

  test('maps a gateway 409 to a conflict error instead of silently overwriting', async () => {
    const gateway = makeGatewayFetch({ workflows: [settingsWorkflow()], settings: { defaultModel: 'demo' }, defaultsConflict: true })
    const { host } = await makeHost({ configured: true, gateway })
    await assert.rejects(
      host.dispatch({ action: 'save-settings', defaults: { resolution: { aspect_ratio: '9:16' } } }),
      error => error.code === 'CONFLICT' && /别处更新/.test(error.message),
    )
  })

  test('option-groups action returns sanitized candidate groups', async () => {
    const gateway = makeGatewayFetch({ workflows: [settingsWorkflow()], settings: { defaultModel: 'demo' },
      optionGroups: [{ id: 'g1', label: '组一', values: ['a', 'b'] }] })
    const { host } = await makeHost({ configured: true, gateway })
    assert.deepEqual(await host.dispatch({ action: 'option-groups' }), { groups: [{ id: 'g1', label: '组一', values: ['a', 'b'] }] })
  })
})

describe('preferences: alwaysSendPrompt, videosPerTurn, applyDefaults and bindToTurn persist with connection.json', () => {
  test('saves booleans and the video count, rejects invalid values, and restores them after reboot', async () => {
    const gateway = makeGatewayFetch({ workflows: [{ alias: 'demo', customFields: [], referenceSlots: [], capabilities: {} }] })
    const { host, dataDirectory, ctx } = await makeHost({ configured: true, gateway })
    assert.deepEqual(await host.dispatch({ action: 'preferences', alwaysSendPrompt: false, videosPerTurn: 6, applyDefaults: false, bindToTurn: false }),
      { autoInsert: false, alwaysSendPrompt: false, videosPerTurn: 6, applyDefaults: false, bindToTurn: false })
    await assert.rejects(host.dispatch({ action: 'preferences', applyDefaults: 'false' }), /布尔/)
    await assert.rejects(host.dispatch({ action: 'preferences', alwaysSendPrompt: 'false' }), /布尔/)
    await assert.rejects(host.dispatch({ action: 'preferences', videosPerTurn: 0 }), /1–10 的整数/)
    const listed = await host.dispatch({ action: 'list' })
    assert.equal(listed.alwaysSendPrompt, false)
    assert.equal(listed.videosPerTurn, 6)
    assert.equal(listed.applyDefaults, false)
    assert.equal(listed.bindToTurn, false)
    host.dispose()
    const restored = await createRunningHubHost(ctx,
      { dataDirectory, baseURL: BASE }, { fetchImpl: gateway.fetchImpl, pollMs: 5 })
    try {
      const state = await restored.dispatch({ action: 'list' })
      assert.equal(state.alwaysSendPrompt, false)
      assert.equal(state.videosPerTurn, 6)
      assert.equal(state.applyDefaults, false)
      assert.equal(state.bindToTurn, false)
    } finally { restored.dispose() }
  })
})

// =====================================================================
describe('reference route: same-origin binary, no key/address leak', () => {
  function refWorkflows() {
    return [{
      alias: 'demo',
      customFields: [],
      referenceSlots: [{ nodeId: '9', kind: 'image' }],
      capabilities: {},
      defaults: { references: [{ nodeId: '9', kind: 'image', name: 'ref.png', fileName: 'SECRET.png', mimeType: 'image/png', size: 16, note: 'x' }], updatedAt: 'u' },
    }]
  }
  async function serveRef(host) {
    const server = createServer((req, res) => { host.route(req, res) })
    await new Promise((r) => server.listen(0, r))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`
    return { base, server, close: () => new Promise((r) => server.close(r)) }
  }

  test('GET 返回同源二进制、no-store、nosniff，且不泄露密钥/地址', async () => {
    const gateway = makeGatewayFetch({ workflows: refWorkflows(), referenceBytes: PNG_BYTES, referenceType: 'image/png' })
    const { host } = await makeHost({ configured: true, gateway })
    const srv = await serveRef(host)
    try {
      const res = await fetch(`${srv.base}${REFERENCE}?model=demo&nodeId=9`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('content-type'), 'image/png')
      const buf = Buffer.from(await res.arrayBuffer())
      assert.ok(buf.equals(PNG_BYTES), '返回的字节必须等于素材原文件')
      const text = buf.toString('latin1')
      assert.ok(!text.includes(DEFAULT_API_KEY), '响应体不得含网关密钥')
      assert.ok(!text.includes('127.0.0.1:6888'), '响应体不得含网关地址')
    } finally { await srv.close() }
  })

  test('HEAD 只回头部不回主体', async () => {
    const gateway = makeGatewayFetch({ workflows: refWorkflows(), referenceBytes: PNG_BYTES, referenceType: 'image/png' })
    const { host } = await makeHost({ configured: true, gateway })
    const srv = await serveRef(host)
    try {
      const res = await fetch(`${srv.base}${REFERENCE}?model=demo&nodeId=9`, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(Number(res.headers.get('content-length')), PNG_BYTES.length)
      assert.equal((await res.arrayBuffer()).byteLength, 0)
    } finally { await srv.close() }
  })

  test('缺少 model/nodeId 返回 400', async () => {
    const gateway = makeGatewayFetch({ workflows: refWorkflows(), referenceBytes: PNG_BYTES, referenceType: 'image/png' })
    const { host } = await makeHost({ configured: true, gateway })
    const srv = await serveRef(host)
    try {
      const res = await fetch(`${srv.base}${REFERENCE}?model=demo`)
      assert.equal(res.status, 400)
    } finally { await srv.close() }
  })

  test('网关对素材端点返回 401 时路由返回错误（沿用既有错误处理）', async () => {
    const gateway = makeGatewayFetch({ workflows: refWorkflows(), referenceStatus: 401 })
    const { host } = await makeHost({ configured: true, gateway })
    const srv = await serveRef(host)
    try {
      const res = await fetch(`${srv.base}${REFERENCE}?model=demo&nodeId=9`)
      assert.equal(res.status, 502)
      const body = await res.json()
      assert.ok(body.error, '错误应以 JSON 形式回传')
    } finally { await srv.close() }
  })

  test('缺槽（nodeId 不在默认素材）返回 400', async () => {
    const gateway = makeGatewayFetch({ workflows: refWorkflows(), referenceBytes: PNG_BYTES, referenceType: 'image/png' })
    const { host } = await makeHost({ configured: true, gateway })
    const srv = await serveRef(host)
    try {
      const res = await fetch(`${srv.base}${REFERENCE}?model=demo&nodeId=99`)
      assert.equal(res.status, 400)
    } finally { await srv.close() }
  })
})

// =====================================================================
describe('library route: 客户端常用图库 / 常用音频库的同源代理', () => {
  const IMAGE_ID = '11111111-1111-4111-8111-111111111111'
  const AUDIO_ID = '22222222-2222-4222-8222-222222222222'
  function galleryItems() {
    return [
      { id: IMAGE_ID, name: '女主设定.png', fileName: 'SECRET-FILE.png', mimeType: 'image/png', size: PNG_BYTES.length, createdAt: '2026-10-01T00:00:00.000Z', contentUrl: '/api/gallery/1/file' },
      { id: 'not-a-uuid', name: '坏 ID.png', mimeType: 'image/png', size: 4 },
      { id: '33333333-3333-4333-8333-333333333333', name: '矢量.svg', mimeType: 'image/svg+xml', size: 9 },
      { id: '44444444-4444-4444-8444-444444444444', name: '../路径穿越.png', mimeType: 'image/png', size: null },
    ]
  }
  function audioItems() {
    return [
      { id: AUDIO_ID, name: '女主声音.mp3', fileName: 'SECRET-AUDIO.mp3', mimeType: 'audio/mpeg', size: AUDIO_BYTES.length, createdAt: '2026-10-02T00:00:00.000Z' },
      { id: '55555555-5555-4555-8555-555555555555', name: '不是音频.png', mimeType: 'image/png', size: 8 },
    ]
  }
  async function serve(host) {
    const server = createServer((req, res) => { host.route(req, res) })
    await new Promise((r) => server.listen(0, r))
    const port = server.address().port
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
  }
  function gateway(extra = {}) {
    return makeGatewayFetch({ galleryItems: galleryItems(), audioLibraryItems: audioItems(), ...extra })
  }

  test('图片列表只回白名单字段，坏条目被过滤，且不泄露文件名/地址/Key', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway() })
    const srv = await serve(host)
    try {
      const res = await fetch(`${srv.base}${LIBRARY}?kind=image`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      const body = await res.json()
      assert.equal(body.kind, 'image')
      assert.equal(body.maxBytes, 10 * 1024 * 1024)
      assert.deepEqual(body.items, [
        { id: IMAGE_ID, name: '女主设定.png', mimeType: 'image/png', size: PNG_BYTES.length, createdAt: '2026-10-01T00:00:00.000Z' },
        { id: '44444444-4444-4444-8444-444444444444', name: '44444444-4444-4444-8444-444444444444', mimeType: 'image/png', size: null },
      ])
      const text = JSON.stringify(body)
      assert.equal(text.includes('SECRET-FILE'), false, '不得下发服务端文件名')
      assert.equal(text.includes('contentUrl'), false, '不得下发网关内部地址')
      assert.equal(text.includes(DEFAULT_API_KEY), false, '不得泄露网关密钥')
      assert.equal(text.includes('127.0.0.1:6888'), false, '不得泄露网关地址')
    } finally { await srv.close() }
  })

  test('音频列表与图片分开：只回音频库条目', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway() })
    const srv = await serve(host)
    try {
      const body = await (await fetch(`${srv.base}${LIBRARY}?kind=audio`)).json()
      assert.equal(body.kind, 'audio')
      assert.deepEqual(body.items, [
        { id: AUDIO_ID, name: '女主声音.mp3', mimeType: 'audio/mpeg', size: AUDIO_BYTES.length, createdAt: '2026-10-02T00:00:00.000Z' },
      ])
      assert.equal(JSON.stringify(body).includes('SECRET-AUDIO'), false)
    } finally { await srv.close() }
  })

  test('按 ID 取图片：同源二进制、私有缓存、nosniff，HEAD 不回主体', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway() })
    const srv = await serve(host)
    try {
      const res = await fetch(`${srv.base}${LIBRARY}?kind=image&id=${IMAGE_ID}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      assert.equal(res.headers.get('cache-control'), 'private, max-age=300')
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES))
      const head = await fetch(`${srv.base}${LIBRARY}?kind=image&id=${IMAGE_ID}`, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(Number(head.headers.get('content-length')), PNG_BYTES.length)
      assert.equal((await head.arrayBuffer()).byteLength, 0)
    } finally { await srv.close() }
  })

  test('按 ID 取音频：沿用音频库 MIME', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway() })
    const srv = await serve(host)
    try {
      const res = await fetch(`${srv.base}${LIBRARY}?kind=audio&id=${AUDIO_ID}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'audio/mpeg')
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(AUDIO_BYTES))
    } finally { await srv.close() }
  })

  test('kind 缺失/非法、id 不是 UUID、跨站请求都被拒', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway() })
    const srv = await serve(host)
    try {
      assert.equal((await fetch(`${srv.base}${LIBRARY}`)).status, 400)
      assert.equal((await fetch(`${srv.base}${LIBRARY}?kind=video`)).status, 400)
      assert.equal((await fetch(`${srv.base}${LIBRARY}?kind=image&id=../../etc/passwd`)).status, 400)
      const cross = await fetch(`${srv.base}${LIBRARY}?kind=image`, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(cross.status, 403)
    } finally { await srv.close() }
  })

  test('网关 401 时列表返回错误 JSON（沿用既有错误处理）', async () => {
    const { host } = await makeHost({ configured: true, gateway: gateway({ libraryStatus: 401 }) })
    const srv = await serve(host)
    try {
      const res = await fetch(`${srv.base}${LIBRARY}?kind=image`)
      assert.equal(res.status, 502)
      assert.ok((await res.json()).error)
    } finally { await srv.close() }
  })
})

// =====================================================================
describe('apply: registration and cleanup (apply 不再返回 host)', () => {
  test('apply 注册 4 HTTP 路由、3 callHost handler、4 工具，且不返回 host', async () => {
    const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
    liveHosts.push({ host: { dispose() {} }, dataDirectory })
    const effects = []
    const registered = []
    const handles = {}
    const tools = []
    let settledHandler, removedHandler, turnSectionSpec
    const promptSections = []
    const attachments = makeAttachments({ saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [] })
    const ctx = {
      attachments,
      credentials: { resolve: async () => undefined, set: async () => {}, describe: async () => undefined },
      tavern: {
        handle: (name, fn) => { handles[name] = fn },
        promptSection: spec => { promptSections.push(spec) },
        turnSection: spec => { turnSectionSpec = spec },
        onTurnSettled: handler => { settledHandler = handler },
        onGameRemoved: handler => { removedHandler = handler },
      },
      webServer: { register: (spec) => { registered.push(spec); return () => {} } },
      effect: (fn) => { const d = fn(); effects.push(d); return d },
      inject: (names, fn) => {
        if (names[0] === 'tools') fn({ tools: { register: (spec) => tools.push(spec) } })
        if (names[0] === 'llm') fn({ llm: { stream: async function* () {} } })
      },
    }
    // index.mjs 删除 apply 末尾 `return host` 后，apply 不再返回 host。
    const result = await apply(ctx, { dataDirectory, baseURL: BASE })
    assert.equal(result, undefined, 'apply 不再返回 host（交由真实 loader 处理 effect）')

    assert.equal(registered.length, 4, 'four HTTP routes must be registered (API, MEDIA, REFERENCE, LIBRARY)')
    assert.deepEqual(registered.map(r => r.path).sort(), [API, LIBRARY, MEDIA, REFERENCE].sort())
    for (const spec of registered) {
      assert.equal(spec.kind, 'exact')
      assert.equal(typeof spec.handler, 'function', 'route handler 须为函数（即 host.route）')
    }
    // apply exposes list/describe as callHost handlers; status is a tool, not a handle.
    assert.deepEqual(Object.keys(handles).sort(), ['dsh-runninghub/describe', 'dsh-runninghub/list'].sort())
    assert.equal(tools.length, 4)
    assert.deepEqual(tools.map(t => t.name).sort(), ['runninghub_describe', 'runninghub_generate', 'runninghub_send_pregenerated', 'runninghub_status'].sort())
    const generate = tools.find(t => t.name === 'runninghub_generate')
    assert.equal(/explicit player request|auto-insert off/i.test(generate.description), false, '关闭态保护应由宿主拒绝，不写进工具说明')
    // 提交/查询类工具只写本地任务库，慢在网关往返；声明并发安全后同一轮多段可以一起发。
    for (const name of ['runninghub_generate', 'runninghub_describe', 'runninghub_status']) {
      assert.equal(tools.find(t => t.name === name).isConcurrencySafe(), true, `${name} 须声明并发安全`)
    }
    assert.equal(tools.find(t => t.name === 'runninghub_send_pregenerated').isConcurrencySafe(), false,
      '发送预生成视频要认领池子条目，保持独占')
    assert.equal(promptSections.length, 8, '模板按 8 段注册，避开 Tavern 单段 8000 字上限')
    assert.deepEqual(promptSections.map(spec => spec.name),
      ['auto-insert', ...Array.from({ length: 7 }, (_, index) => 'auto-insert-' + String(index + 1).padStart(2, '0'))])
    for (const spec of promptSections) {
      assert.equal(typeof spec.text, 'function')
      assert.equal(spec.text({ gameId: 'fixture-game' }), '', '没有工作流、自动插入与预生成时不注入段落')
    }
    assert.equal(turnSectionSpec?.name, 'auto-insert-reminder')
    assert.equal(typeof turnSectionSpec?.text, 'function')
    assert.equal(turnSectionSpec.text({ gameId: 'fixture-game' }), '', '自动插入关闭时不注入每轮提醒')
    assert.equal(typeof settledHandler, 'function')
    assert.equal(typeof removedHandler, 'function')
    assert.equal(effects.length, 5, 'dispose + 4 route effects expected')
  })

  test('callHost handlers delegate to dispatch', async () => {
    const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
    liveHosts.push({ host: { dispose() {} }, dataDirectory })
    const handles = {}
    const ctx = {
      attachments: makeAttachments({ saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [] }),
      credentials: { resolve: async () => undefined, set: async () => {}, describe: async () => undefined },
      tavern: { handle: (name, fn) => { handles[name] = fn } },
      webServer: { register: () => () => {} },
      effect: () => () => {},
      inject: (names, fn) => { if (names[0] === 'tools') fn({ tools: { register: () => {} } }) },
    }
    await apply(ctx, { dataDirectory, baseURL: BASE })
    const listResult = await handles['dsh-runninghub/list']()
    assert.equal('configured' in listResult, true)
    // describe delegates to dispatch describe (will fail with NOT_CONFIGURED, proving delegation)
    await assert.rejects(handles['dsh-runninghub/describe']({ model: 'demo' }), (e) => e.code === 'NOT_CONFIGURED')
  })

  test('apply 注册的 dispose effect 拆除 host（无需 apply 返回 host）', async () => {
    const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
    liveHosts.push({ host: { dispose() {} }, dataDirectory })
    const effects = []
    const tools = []
    const ctx = {
      attachments: makeAttachments({ saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [] }),
      credentials: { resolve: async () => undefined, set: async () => {}, describe: async () => undefined },
      tavern: { handle: () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); effects.push(d); return d },
      inject: (names, fn) => { if (names[0] === 'tools') fn({ tools: { register: (spec) => tools.push(spec) } }) },
    }
    await apply(ctx, { dataDirectory, baseURL: BASE })
    assert.equal(effects.length, 5, 'dispose + 4 route effects expected')
    // The dispose effect is registered first; the four route effects return their own disposers.
    const disposeFn = effects[0]
    assert.equal(typeof disposeFn, 'function', 'apply must register a dispose effect (no Invalid return)')
    // host 由 apply 内部创建，经由已注册的 tool.execute 验证其已被拆除。
    disposeFn()
    await assert.rejects(tools[0].execute({ model: 'demo' }), (e) => e.code === 'DISPOSED')
  })

  test('factory: createRunningHubHost 仍返回完整 host 且 dispose 拆除（apply 不再返回 host 时仍可用）', async () => {
    const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
    liveHosts.push({ host: { dispose() {} }, dataDirectory })
    const calls = { saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [] }
    const attachments = makeAttachments(calls)
    const ctx = {
      attachments,
      credentials: { resolve: async () => undefined, set: async () => {}, describe: async () => undefined },
      tavern: { list: async () => [], update: async () => {}, attach: async () => {} },
    }
    const host = await createRunningHubHost(ctx, { dataDirectory, baseURL: BASE }, { pollMs: 5 })
    assert.ok(
      host && typeof host.dispatch === 'function' && typeof host.route === 'function' && typeof host.dispose === 'function',
      'factory 须返回完整 host',
    )
    await assert.rejects(host.dispatch({ action: 'describe', model: 'demo' }), (e) => e.code === 'NOT_CONFIGURED')
    host.dispose()
    // list→summary 不走 connect，不校验 disposed；用 describe（经 connect）验证拆除。
    await assert.rejects(host.dispatch({ action: 'describe', model: 'demo' }), (e) => e.code === 'DISPOSED')
  })
})

// =====================================================================
describe('regenerate: task history replays the saved prompt, params and references', () => {
  const workflows = [{
    alias: 'demo', revision: 'rev-demo',
    customFields: [{ key: 'quality', label: '质量', type: 'number', min: 1, max: 10 }],
    referenceSlots: [{ nodeId: 'image-ref', kind: 'image', label: '参考图' }],
    videoDuration: { seconds: 5, fps: 24 },
    capabilities: {}, defaults: {},
  }]

  test('重新生成按原输入新建任务；参考素材往返一致且不写进任务记录', async () => {
    const bodies = []
    const gateway = makeGatewayFetch({ workflows, onGenerations: (_url, opts) => bodies.push(JSON.parse(opts.body)) })
    const { host, calls, dataDirectory } = await makeHost({ configured: true, gateway })

    const original = await host.dispatch({ action: 'submit', requestId: 'req-replay-1', bindToTurn: false, input: {
      model: 'demo', prompt: '  原样提示词\n第二行  ', apply_defaults: true, duration_seconds: 5,
      resolution: { aspect_ratio: '9:16' }, custom: { quality: 2 },
      references: [{ nodeId: 'image-ref', name: '主角.png', mimeType: 'image/png', data: PNG_BYTES.toString('base64'), note: '主角参考' }],
    } })
    assert.equal(original.replayable, true, '提交响应应直接标记可重放')
    await waitForJob(host, original.id, job => job.status === 'ready')

    const listed = await host.dispatch({ action: 'list' })
    const stored = listed.jobs.find(job => job.id === original.id)
    assert.equal(stored.replayable, true)
    assert.equal('prompt' in stored, false, '提示词不能出现在任务列表/任务记录里')
    const taskFile = await readFile(join(dataDirectory, 'tasks', original.id + '.json'), 'utf8')
    assert.equal(taskFile.includes('原样提示词'), false, '任务记录不得包含提示词')
    assert.equal(taskFile.includes(PNG_BYTES.toString('base64')), false, '任务记录不得包含参考素材')

    const regenerated = await host.dispatch({ action: 'regenerate', id: original.id, requestId: 'req-replay-2', bindToTurn: false })
    assert.notEqual(regenerated.id, original.id, '重新生成必须新建任务')
    assert.equal(regenerated.replayable, true)
    await waitForJob(host, regenerated.id, job => job.status === 'ready')
    await waitForJob(host, original.id, job => job.status === 'ready')

    assert.equal(gateway.generations(), 2, '一键重新生成应恰好再提交一次')
    const { client_request_id: _first, ...firstBody } = bodies[0]
    const { client_request_id: _second, ...secondBody } = bodies[1]
    assert.deepEqual(secondBody, firstBody, '重新提交的提示词、参数与参考素材必须与首次一致')
    assert.equal(secondBody.references[0].data, PNG_BYTES.toString('base64'))

    const replayFile = await readFile(join(dataDirectory, 'replays', original.id, 'input.json'), 'utf8')
    assert.match(replayFile, /原样提示词/)
    assert.equal(replayFile.includes(PNG_BYTES.toString('base64')), false, '参考素材按二进制去重保存')
    assert.equal((await host.replays.load(regenerated.id)).prompt, '原样提示词\n第二行', 'validateInput 会去掉提示词首尾空白')
  })

  test('同一 requestId 重试重新生成只提交一次，并返回首次创建的新任务', async () => {
    const gateway = makeGatewayFetch({ workflows })
    const { host } = await makeHost({ configured: true, gateway })
    const original = await host.dispatch({ action: 'submit', requestId: 'req-replay-dedupe-1', bindToTurn: false,
      input: { model: 'demo', prompt: 'dedupe' } })
    await waitForJob(host, original.id, job => job.status === 'ready')

    const first = await host.dispatch({ action: 'regenerate', id: original.id, requestId: 'req-replay-dedupe-2', bindToTurn: false })
    const second = await host.dispatch({ action: 'regenerate', id: original.id, requestId: 'req-replay-dedupe-2', bindToTurn: false })
    assert.equal(second.id, first.id)
    await waitForJob(host, first.id, job => job.status === 'ready')
    assert.equal(gateway.generations(), 2, '原任务 1 次 + 重新生成 1 次，重试不得再提交')
  })

  test('运行中、结果未知或没有快照的任务拒绝重新生成', async () => {
    const gateway = makeGatewayFetch({ workflows, taskStatus: 'running' })
    const { host } = await makeHost({ configured: true, gateway })
    const active = await host.dispatch({ action: 'submit', requestId: 'req-replay-active', bindToTurn: false,
      input: { model: 'demo', prompt: 'still running' } })
    await waitForJob(host, active.id, job => Boolean(job.remoteTaskId))
    await assert.rejects(host.dispatch({ action: 'regenerate', id: active.id, requestId: 'req-replay-active-2', bindToTurn: false }),
      /只有已结束的任务/)

    const { randomUUID } = await import('node:crypto')
    const legacy = await host.store.write({
      id: randomUUID(), requestId: 'req-replay-legacy', status: 'ready', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    await assert.rejects(host.dispatch({ action: 'regenerate', id: legacy.id, requestId: 'req-replay-legacy-2', bindToTurn: false }),
      (error) => error.code === 'NOT_FOUND' && /没有保存可重放的输入/.test(error.message))

    const unknown = await host.store.write({
      id: randomUUID(), requestId: 'req-replay-unknown', status: 'submit_unknown', model: 'demo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      outputs: [], attachments: [], completedOutputs: [],
    })
    await assert.rejects(host.dispatch({ action: 'regenerate', id: unknown.id, requestId: 'req-replay-unknown-2', bindToTurn: false }),
      /只有已结束的任务/)
  })

  test('重启后快照仍在：历史任务继续可重放', async () => {
    const gateway = makeGatewayFetch({ workflows })
    const first = await makeHost({ configured: true, gateway })
    const original = await first.host.dispatch({ action: 'submit', requestId: 'req-replay-restart-1', bindToTurn: false,
      input: { model: 'demo', prompt: 'restart prompt' } })
    await waitForJob(first.host, original.id, job => job.status === 'ready')
    first.host.dispose()

    const restored = await createRunningHubHost(first.ctx, { dataDirectory: first.dataDirectory, baseURL: BASE }, { pollMs: 5, fetchImpl: gateway.fetchImpl })
    liveHosts.push({ host: restored, dataDirectory: first.dataDirectory })
    const listed = await restored.dispatch({ action: 'list' })
    assert.equal(listed.jobs.find(job => job.id === original.id).replayable, true, '重启扫描 replays/ 后仍标记可重放')

    const regenerated = await restored.dispatch({ action: 'regenerate', id: original.id, requestId: 'req-replay-restart-2', bindToTurn: false })
    await waitForJob(restored, regenerated.id, job => job.status === 'ready')
    assert.equal(gateway.generations(), 2, '重启后重新生成仍只提交一次')
    assert.equal((await restored.replays.load(regenerated.id)).prompt, 'restart prompt')
  })

  test('重新生成沿用原工作流，不要求它仍是面板当前选择，并可绑定当前对话轮次', async () => {
    const other = { alias: 'other', revision: 'rev-other', customFields: [], referenceSlots: [], capabilities: {}, defaults: {} }
    const gateway = makeGatewayFetch({ workflows: [...workflows, other], settings: { defaultModel: 'demo' } })
    const { host, calls } = await makeHost({ configured: true, gateway })
    const original = await host.dispatch({ action: 'submit', requestId: 'req-replay-model-1', bindToTurn: false,
      input: { model: 'demo', prompt: 'demo prompt' } })
    await waitForJob(host, original.id, job => job.status === 'ready')
    await host.dispatch({ action: 'select-model', model: 'other' })

    const regenerated = await host.dispatch({ action: 'regenerate', id: original.id, requestId: 'req-replay-model-2',
      bindToTurn: true, gameId: 'game-replay' })
    assert.equal(regenerated.model, 'demo', '重新生成必须使用原任务的工作流，而不是面板当前选择')
    assert.equal(calls.getTurnState.at(-1), 'game-replay', '绑定开关开启时重新绑定当前轮次')
    assert.equal(regenerated.binding.gameId, 'game-replay')
    await waitForJob(host, regenerated.id, job => Boolean(job.remoteTaskId))
  })
})
