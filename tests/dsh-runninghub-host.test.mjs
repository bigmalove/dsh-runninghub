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

import { createRunningHubHost, apply, API, MEDIA, REFERENCE } from '../index.mjs'

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
} = {}) {
  const ext = kind === 'video' ? 'mp4' : 'png'
  const fileBytes = kind === 'video' ? MP4_BYTES : PNG_BYTES
  const fileType = kind === 'video' ? 'video/mp4' : 'image/png'
  const outPath = `/files/out/result.${ext}`
  const list = workflows ?? [{ alias: 'demo', customFields: [], referenceSlots: [], capabilities: {} }]
  let generations = 0
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url)
    if (u.pathname === '/api/workflows') {
      return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/settings') {
      return new Response(JSON.stringify(settings ?? { defaultModel: 'demo' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/nodes$/.test(u.pathname)) {
      return new Response(JSON.stringify(nodes ?? []), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.pathname === '/api/lora-library') {
      return new Response(JSON.stringify(loraLibrary ?? { loras: [], maxConcurrent: 1, enabled: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (/^\/api\/workflows\/[^/]+\/defaults\/references\/[^/]+$/.test(u.pathname)) {
      const bytes = referenceBytes ?? fileBytes
      return new Response(bytes, { status: referenceStatus, headers: { 'content-type': referenceType ?? fileType } })
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
  return { fetchImpl, generations: () => generations, outPath }
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

  test('unknown model rejected (describe fails) before job acceptance', async () => {
    const { host } = await makeHost({ configured: true, gateway: makeGatewayFetch() })
    await assert.rejects(
      host.dispatch({ action: 'submit', requestId: 'req-unknown-model', input: { model: 'nope', prompt: 'x' }, bindToTurn: false }),
      (e) => /未找到工作流别名/.test(e.message),
    )
    const jobs = await host.store.list()
    assert.equal(jobs.length, 0, 'no job may be persisted when describe fails')
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
describe('apply: registration and cleanup (apply 不再返回 host)', () => {
  test('apply 注册 2 HTTP 路由、3 callHost handler、3 工具，且不返回 host', async () => {
    const dataDirectory = await mkdtemp(join(tmpRoot, 'rh-test-'))
    liveHosts.push({ host: { dispose() {} }, dataDirectory })
    const effects = []
    const registered = []
    const handles = {}
    const tools = []
    const attachments = makeAttachments({ saveImage: [], saveFile: [], getTurnState: [], getTurn: [], credentialsSet: [] })
    const ctx = {
      attachments,
      credentials: { resolve: async () => undefined, set: async () => {}, describe: async () => undefined },
      tavern: { handle: (name, fn) => { handles[name] = fn } },
      webServer: { register: (spec) => { registered.push(spec); return () => {} } },
      effect: (fn) => { const d = fn(); effects.push(d); return d },
      inject: (names, fn) => { if (names[0] === 'tools') fn({ tools: { register: (spec) => tools.push(spec) } }) },
    }
    // index.mjs 删除 apply 末尾 `return host` 后，apply 不再返回 host。
    const result = await apply(ctx, { dataDirectory, baseURL: BASE })
    assert.equal(result, undefined, 'apply 不再返回 host（交由真实 loader 处理 effect）')

    assert.equal(registered.length, 3, 'three HTTP routes must be registered (API, MEDIA, REFERENCE)')
    assert.deepEqual(registered.map(r => r.path).sort(), [API, MEDIA, REFERENCE].sort())
    for (const spec of registered) {
      assert.equal(spec.kind, 'exact')
      assert.equal(typeof spec.handler, 'function', 'route handler 须为函数（即 host.route）')
    }
    // apply exposes list/describe as callHost handlers; status is a tool, not a handle.
    assert.deepEqual(Object.keys(handles).sort(), ['dsh-runninghub/describe', 'dsh-runninghub/list'].sort())
    assert.equal(tools.length, 3)
    assert.deepEqual(tools.map(t => t.name).sort(), ['runninghub_describe', 'runninghub_generate', 'runninghub_status'].sort())
    assert.equal(effects.length, 4, 'dispose + 3 route effects expected')
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
    assert.equal(effects.length, 4, 'dispose + 3 route effects expected')
    // The dispose effect is registered first; the three route effects return their own disposers.
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
