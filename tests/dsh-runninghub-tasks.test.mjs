import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import test from 'node:test'
import { GatewayClient, GatewayError } from '../lib/client.mjs'
import { TaskStore, TaskEngine } from '../lib/tasks.mjs'

// ---------------------------------------------------------------------------
// 临时 mock 网关（fetchImpl 注入，绝不访问真实网络 / 真实 RunningHub）。
// ---------------------------------------------------------------------------
function makeResponse({ text, bytes, contentType = 'application/json', contentLength, status = 200, redirected = false } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(text ?? '')
  const len = contentLength != null ? contentLength : data.length
  const headers = {
    get(name) {
      const lower = String(name).toLowerCase()
      if (lower === 'content-type') return contentType
      if (lower === 'content-length') return String(len)
      return null
    },
  }
  const stream = new ReadableStream({ start(controller) { if (data.length) controller.enqueue(data); controller.close() } })
  return { ok: status >= 200 && status < 300, status, headers, body: stream, redirected, url: '' }
}

function engineWorkflow() {
  return {
    alias: 'h3参考',
    customFields: [{ key: 'subject', name: 'Subject', type: 'text', required: true }],
    referenceSlots: [
      { nodeId: '9', kind: 'image', label: 'Ref image' },
      { nodeId: '10', kind: 'audio', label: 'Ref audio' },
    ],
    defaults: {},
    capabilities: { resolutionSchema: { properties: {} }, durationSchema: { type: 'number', min: 0.5, max: 120 } },
    videoDuration: null,
  }
}

function makeGatewayClient({ tasks = {}, media = new Uint8Array(), onCall, workflows } = {}) {
  const calls = []
  const list = workflows ?? [engineWorkflow()]
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const record = { method, path: u.pathname, headers: options.headers, body: options.body }
    calls.push(record)
    onCall?.(record)
    if (u.pathname === '/api/workflows') return makeResponse({ text: JSON.stringify(list) })
    if (u.pathname === '/v1/images/generations') {
      const submitted = JSON.parse(options.body || '{}')
      const reply = typeof tasks.__submit__ === 'function' ? tasks.__submit__(submitted) : (tasks.__submit__ ?? { task_id: ['t1'], accepted: 1 })
      return makeResponse({ text: JSON.stringify(reply) })
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(u.pathname)
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1])
      const snapshot = typeof tasks[id] === 'function' ? tasks[id]() : (tasks[id] ?? { status: 'succeeded', outputs: [] })
      return makeResponse({ text: JSON.stringify(snapshot) })
    }
    if (u.pathname.startsWith('/files/')) {
      const result = typeof media === 'function' ? media(u.pathname) : media
      if (result instanceof Error) throw result
      return makeResponse({ bytes: result, contentType: 'application/octet-stream' })
    }
    return makeResponse({ status: 404, text: '{}' })
  }
  const client = new GatewayClient({ baseURL: 'http://127.0.0.1:6888', fetchImpl, timeoutMs: 2000, maxMediaBytes: 64 * 1024 * 1024 })
  return { client, calls }
}

function pngBytes() {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
}
const PNG_B64 = Buffer.from(pngBytes()).toString('base64')

async function until(read, predicate, attempts = 400) {
  for (let n = 0; n < attempts; n++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('未在预期时间内到达目标状态')
}

function baseJob(overrides = {}) {
  const id = overrides.id ?? randomUUID()
  return {
    id,
    requestId: overrides.requestId ?? randomUUID(),
    status: overrides.status ?? 'preparing',
    model: overrides.model ?? 'h3参考',
    remoteTaskId: overrides.remoteTaskId,
    binding: overrides.binding,
    error: overrides.error,
    queryError: overrides.queryError,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    outputs: overrides.outputs ?? [],
    attachments: overrides.attachments ?? [],
    completedOutputs: overrides.completedOutputs ?? [],
    ...overrides.extra,
  }
}

test('TaskEngine：同毫秒创建三单时仍按提交顺序排序', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-order-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const frozenNow = Date.now()
  t.mock.method(Date, 'now', () => frozenNow)
  const store = new TaskStore({ directory: dir })
  const engine = new TaskEngine({ store, onMedia: async () => ({}),
    client: { submit: async () => { throw new GatewayError('rejected', { rejected: true }) } } })
  t.after(() => engine.dispose())
  const jobs = []
  for (let index = 0; index < 3; index++) jobs.push(await engine.submit({ model: 'demo' }, { requestId: 'same-ms-' + index }))
  for (const job of jobs) await until(() => store.read(job.id), job => job.status === 'failed')
  assert.equal(new Set(jobs.map(job => job.createdAt)).size, 3)
  assert.deepEqual((await store.list()).reverse().map(job => job.id), jobs.map(job => job.id))
})

test('TaskEngine：恢复后即使系统时间回退，新任务仍排在已有任务后面', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-order-restore-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  const prior = baseJob({ status: 'failed', createdAt: new Date().toISOString() })
  await store.write(prior)
  t.mock.method(Date, 'now', () => Date.parse(prior.createdAt) - 1000)
  const engine = new TaskEngine({ store, onMedia: async () => ({}),
    client: { submit: async () => { throw new GatewayError('rejected', { rejected: true }) } } })
  t.after(() => engine.dispose())
  const next = await engine.submit({ model: 'demo' }, { requestId: 'after-restart' })
  await until(() => store.read(next.id), job => job.status === 'failed')
  assert.ok(next.createdAt > prior.createdAt)
  assert.deepEqual((await store.list()).reverse().map(job => job.id), [prior.id, next.id])
})

// ===========================================================================
// TaskStore 原子落盘与脱敏
// ===========================================================================
test('TaskStore：写入含私密字段的任务后，落盘文件与读取结果均不泄露凭据', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()

  const id = randomUUID()
  const secret = 'SECRET_PROMPT'
  const job = baseJob({
    id,
    requestId: 'sec-req',
    status: 'preparing',
    binding: { gameId: 'g1', turn: 1, prompt: secret },
    outputs: [{ path: 'files/x.png', data: `data:image/png;base64,${PNG_B64}` }],
    attachments: [{ url: 'https://user:pass@example.com/x.png' }],
    error: 'api_key=TOPSECRET apikey=ANOTHERSECRET',
    extra: {
      input: { prompt: secret, custom: { subject: secret }, references: [{ data: PNG_B64 }] },
      apiKey: 'leaked-key',
    },
  })
  await store.write(job)

  // 磁盘原始内容不得包含任何私密片段。
  const raw = await readFile(path.join(dir, `${id}.json`), 'utf8')
  for (const frag of [secret, 'TOPSECRET', 'ANOTHERSECRET', 'user:pass', PNG_B64, 'data:image', 'leaked-key', 'references', 'custom']) {
    assert.ok(!raw.includes(frag), `落盘文件不应包含私密片段：${frag}`)
  }

  // 结构化读取结果进一步确认脱敏。
  const saved = await store.read(id)
  assert.equal(saved.id, id)
  assert.equal(saved.binding.gameId, 'g1')
  assert.equal(saved.binding.prompt, undefined, 'binding.prompt 必须被剥离')
  assert.deepEqual(saved.outputs, [{ path: 'files/x.png' }], 'output.data 必须被剥离')
  assert.ok(!saved.attachments.some((a) => a && typeof a.url === 'string' && /user:pass/.test(a.url)), '带凭据的 URL 附件不得保留明文凭据')
  assert.ok(!saved.error.includes('TOPSECRET') && !saved.error.includes('ANOTHERSECRET'), 'error 必须被脱敏')
  assert.equal(saved.input, undefined, 'input 字段不得持久化')
  assert.equal(saved.apiKey, undefined, 'apiKey 字段不得持久化')
})

test('TaskStore：原子落盘——成功后只保留最终文件、无残留临时文件', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  const id = randomUUID()
  await store.write(baseJob({ id, requestId: 'atomic', status: 'queued' }))
  const files = await readdir(dir)
  assert.ok(files.includes(`${id}.json`), '应存在最终文件')
  assert.ok(!files.some((f) => f.includes('.tmp')), '不应残留临时文件')
  const saved = await store.read(id)
  assert.equal(saved.status, 'queued')
})

test('TaskStore：并发写入不同任务全部成功且文件完整（write 串行化临时文件）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  const ids = Array.from({ length: 25 }, () => randomUUID())
  await Promise.all(ids.map((id, i) => store.write(baseJob({ id, requestId: `r${i}`, status: 'preparing' }))))
  const files = await readdir(dir)
  assert.ok(!files.some((f) => f.includes('.tmp')), '并发写入不应残留临时文件')
  for (const id of ids) {
    const job = await store.read(id)
    assert.ok(job && job.id === id, '每个并发写入的任务都应可被完整读取')
  }
})

test('TaskStore：相同 id 并发写入不损坏文件且可读', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  const id = randomUUID()
  await Promise.all([
    store.write(baseJob({ id, requestId: 'same', status: 'preparing' })),
    store.write(baseJob({ id, requestId: 'same', status: 'queued' })),
  ])
  const job = await store.read(id)
  assert.ok(job && job.id === id, '相同 id 并发写入后文件仍有效')
  assert.ok(['preparing', 'queued'].includes(job.status))
})

test('TaskStore：非法状态或非 UUID id 的写入被拒绝', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  await assert.rejects(() => store.write(baseJob({ id: randomUUID(), status: 'bogus' })), GatewayError)
  await assert.rejects(() => store.write(baseJob({ id: 'not-a-uuid', requestId: 'x' })), GatewayError)
})

// ===========================================================================
// 并发同 requestId 一次提交
// ===========================================================================
test('并发同 requestId 一次提交：两并发 submit 返回同一任务且只向网关提交一次', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  const { client, calls } = makeGatewayClient({ tasks: { t1: { status: 'queued', outputs: [] } } })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()

  const input = { model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }
  const [a, b] = await Promise.all([
    engine.submit(input, { requestId: 'same-id' }),
    engine.submit(input, { requestId: 'same-id' }),
  ])
  assert.equal(a.id, b.id, '并发同 requestId 必须返回同一任务')
  await until(() => store.read(a.id), (j) => j && j.remoteTaskId)
  const posts = calls.filter((c) => c.path === '/v1/images/generations')
  assert.equal(posts.length, 1, '同 requestId 并发只应提交一次')
})

// ===========================================================================
// 恢复只查不重提
// ===========================================================================
test('恢复只查不重提：已知 remoteTaskId 的历史任务 init 时只查询状态、不重新提交', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  const job = baseJob({ requestId: 'prev-1', status: 'queued', remoteTaskId: 't1' })
  await store.write(job)

  const { client, calls } = makeGatewayClient({ tasks: { t1: { status: 'ready', outputs: [{ url: '/files/x.png' }] } }, media: pngBytes() })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()

  await until(() => store.read(job.id), (j) => j && (j.status === 'ready' || j.status === 'download_failed'))
  const posts = calls.filter((c) => c.path === '/v1/images/generations')
  assert.equal(posts.length, 0, '恢复不应重新提交')
  const tasks = calls.filter((c) => c.path === '/v1/tasks/t1')
  assert.ok(tasks.length >= 1, '恢复应查询任务状态')
})

test('恢复只查不重提：无 remoteTaskId 的 preparing 任务被标记为 submit_unknown 且不重提', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()
  const job = baseJob({ requestId: 'prev-2', status: 'preparing' })
  await store.write(job)

  const { client, calls } = makeGatewayClient({ tasks: { t1: { status: 'ready', outputs: [] } }, media: pngBytes() })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()

  const saved = await store.read(job.id)
  assert.equal(saved.status, 'submit_unknown', '无 remoteTaskId 的 preparing 应转 submit_unknown')
  assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 0, '不应重新提交')
})

test('恢复只查不重提：已终态（ready/failed/download_failed）任务 init 时不重新拉起', async (t) => {
  for (const status of ['ready', 'failed', 'download_failed']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const store = new TaskStore({ directory: dir })
    await store.init()
    const job = baseJob({ requestId: `prev-${status}`, status, remoteTaskId: 't1' })
    await store.write(job)

    const { client, calls } = makeGatewayClient({ tasks: { t1: { status: 'ready', outputs: [] } }, media: pngBytes() })
    const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
    t.after(() => engine.dispose())
    await engine.init()

    assert.equal(calls.filter((c) => c.path === '/v1/tasks/t1').length, 0, `${status} 任务不应再查询`)
  }
})

// ===========================================================================
// submit_unknown（engine 层）
// ===========================================================================
test('submit_unknown（engine）：网络不确定失败转为 submit_unknown，重启后不再重提', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()

  // 第一次引擎：submit 时网关直接报错（非 4xx 拒绝），结果未知。
  const { client, calls } = makeGatewayClient({ tasks: { __submit__: () => { throw new Error('network down') } } })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()
  const job = await engine.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, { requestId: 'uncertain' })
  await until(() => store.read(job.id), (j) => j && j.status === 'submit_unknown')
  assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 1, '首次只尝试提交一次')

  // 第二次引擎（模拟重启）：该 submit_unknown 任务不应被重新提交。
  const engine2 = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine2.dispose())
  await engine2.init()
  const saved = await store.read(job.id)
  assert.equal(saved.status, 'submit_unknown', '重启后仍是 submit_unknown')
  assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 1, '重启后不得重新提交')
})

// ===========================================================================
// 终止状态
// ===========================================================================
test('终止状态：网关 failed/canceled/timed_out/cancelled 均转本地 failed 且不下载不重提', async (t) => {
  for (const remote of ['failed', 'canceled', 'cancelled', 'timed_out']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const store = new TaskStore({ directory: dir })
    const { client, calls } = makeGatewayClient({ tasks: { t1: { status: remote, outputs: [] } } })
    const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
    t.after(() => engine.dispose())
    await engine.init()
    const job = await engine.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, { requestId: `term-${remote}` })
    await until(() => store.read(job.id), (j) => j && j.status === 'failed')
    assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 1, `${remote}：仅提交一次`)
    assert.equal(calls.filter((c) => c.path.startsWith('/files/')).length, 0, `${remote}：不应下载`)
  }
})

// ===========================================================================
// download_failed 仅重下载
// ===========================================================================
test('download_failed 仅重下载：失败后 retryDownload 只重下、绝不重新提交', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  await store.init()

  let downloads = 0
  const media = () => {
    downloads += 1
    if (downloads === 1) return new Error('network down on first attempt')
    return pngBytes()
  }
  const { client, calls } = makeGatewayClient({ tasks: { t1: { status: 'succeeded', outputs: [{ url: '/files/x.png' }] } }, media })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/dsh-runninghub/media?p=x', kind: 'image' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()

  const job = await engine.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, { requestId: 'dl-1' })
  await until(() => store.read(job.id), (j) => j && j.status === 'download_failed')
  assert.equal(downloads, 1, '首次下载应失败一次')
  assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 1, '只提交了一次')
  let saved = await store.read(job.id)
  assert.equal(saved.completedOutputs.length, 0)

  await engine.retryDownload(job.id)
  await until(() => store.read(job.id), (j) => j && j.status === 'ready')
  assert.equal(downloads, 2, '重试应再次下载')
  assert.equal(calls.filter((c) => c.path === '/v1/images/generations').length, 1, '重试下载不得重新提交')
  saved = await store.read(job.id)
  assert.equal(saved.completedOutputs.length, 1, '重试后附件应完成')
  assert.equal(saved.attachments.length, 1)
})

// ===========================================================================
// 凭据不泄露（engine 层）：输入绝不落盘
// ===========================================================================
test('凭据不泄露（engine）：submit 的输入（prompt/references base64）绝不持久化', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tavern-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TaskStore({ directory: dir })
  const { client } = makeGatewayClient({ tasks: { t1: { status: 'queued', outputs: [] } } })
  const engine = new TaskEngine({ client, store, onMedia: async () => ({ url: '/api/x' }), pollMs: 15 })
  t.after(() => engine.dispose())
  await engine.init()

  const secret = 'DO-NOT-PERSIST-PROMPT'
  const job = await engine.submit({
    model: 'h3参考',
    prompt: secret,
    custom: { subject: 'cat' },
    references: [{ nodeId: '9', data: PNG_B64, mimeType: 'image/png' }],
  }, { requestId: 'no-leak' })
  await until(() => store.read(job.id), (j) => j && j.remoteTaskId)

  const raw = await readFile(path.join(dir, `${job.id}.json`), 'utf8')
  for (const frag of [secret, PNG_B64, 'references', 'custom', 'prompt']) {
    assert.ok(!raw.includes(frag), `落盘文件不应包含：${frag}`)
  }
  const saved = await store.read(job.id)
  assert.equal(saved.model, 'h3参考', 'model 可保留')
  assert.equal(saved.custom, undefined, 'custom 不得持久化')
})
