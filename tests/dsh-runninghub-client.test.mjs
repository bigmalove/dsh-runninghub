import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import test from 'node:test'
import {
  GatewayClient,
  GatewayError,
  sanitizeMessage,
  validateBaseURL,
  validateInput,
  validateReferences,
  validateRequestId,
} from '../lib/client.mjs'

// ---------------------------------------------------------------------------
// 临时 mock HTTP 层：用注入的 fetchImpl 取代真实网关，绝不访问真实网络。
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
  const stream = new ReadableStream({
    start(controller) {
      if (data.length) controller.enqueue(data)
      controller.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, headers, body: stream, redirected, url: '' }
}

// 默认网关行为可覆写。tasks 以 remoteTaskId 为键返回任务快照；media 返回字节或抛错。
function createGateway({ baseURL = 'http://127.0.0.1:6888', apiKey, workflows = [], tasks = {}, media = new Uint8Array(), onCall } = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const record = { method, path: u.pathname, headers: options.headers, body: options.body }
    calls.push(record)
    onCall?.(record)
    if (u.pathname === '/api/workflows') return makeResponse({ text: JSON.stringify(workflows) })
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
  const client = new GatewayClient({ baseURL, apiKey, fetchImpl, timeoutMs: 2000, maxMediaBytes: 64 * 1024 * 1024 })
  return { client, calls, apiKey }
}

// 构造一个合法网关工作流，并附带可触发各类校验的字段。
function sampleWorkflow() {
  return {
    alias: 'h3参考',
    customFields: [
      { key: 'seed', name: 'Seed', type: 'integer', min: 0, max: 100, defaultValue: 5 },
      { key: 'style', name: 'Style', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'subject', name: 'Subject', type: 'text', required: true },
      { key: 'apikey', name: 'Leak', type: 'text' },
    ],
    referenceSlots: [
      { nodeId: '9', kind: 'image', label: 'Ref image' },
      { nodeId: '10', kind: 'audio', label: 'Ref audio' },
    ],
    defaults: { custom: { seed: 7 }, resolution: { aspect_ratio: '16:9' } },
    capabilities: {
      resolutionSchema: { properties: { aspect_ratio: { type: 'string' }, megapixels: { type: 'number', min: 0.1, max: 16 } } },
      durationSchema: { type: 'number', min: 0.5, max: 120 },
    },
    videoDuration: { seconds: 5, frames: 120, fps: 24 },
  }
}

function pngBytes() {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
}
function jpegBytes() {
  return new Uint8Array([255, 216, 255, 0, 1, 2, 3, 4, 5])
}
function webpBytes() {
  return new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 0, 0, 0, 0])
}
function mp4Bytes() {
  return new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 0, 0, 0, 0])
}
function webmBytes() {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 119, 101, 98, 109, 0, 0])
}

const PNG_B64 = Buffer.from(pngBytes()).toString('base64')
const MP3_B64 = Buffer.from([0xff, 0xfb, 0x10, 0x00, 0x01, 0x02]).toString('base64')

// ===========================================================================
// 真实协议映射
// ===========================================================================
test('真实协议映射：listWorkflows 走 GET /api/workflows 且不带 body', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()] })
  const list = await client.listWorkflows()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, '/api/workflows')
  assert.equal(calls[0].body, undefined)
  assert.equal(list[0].alias, 'h3参考')
})

test('真实协议映射：submit 先 GET /api/workflows 再 POST /v1/images/generations，body 含 client_request_id 与固定字段', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()] })
  const input = { model: 'h3参考', prompt: 'hi', custom: { seed: 10, style: 'a', subject: 'cat' } }
  const result = await client.submit(input, 'req-1')
  assert.equal(result.taskId, 't1')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, '/api/workflows')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].path, '/v1/images/generations')
  const body = JSON.parse(calls[1].body)
  assert.equal(body.client_request_id, 'req-1')
  assert.equal(body.n, 1)
  assert.equal(body.parallel, 1)
  assert.equal(body.concurrency, 1)
  assert.equal(body.async, true)
  assert.equal(body.model, 'h3参考')
  assert.equal(body.prompt, 'hi')
  assert.deepEqual(body.custom, { seed: 10, style: 'a', subject: 'cat' })
})

test('真实协议映射：task 走 GET /v1/tasks/:id（requestId 编码）', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()], tasks: { t1: { status: 'running', outputs: [] } } })
  const snapshot = await client.task('t1')
  assert.equal(snapshot.taskId, 't1')
  assert.equal(snapshot.status, 'running')
  const taskCall = calls.find((c) => c.path === '/v1/tasks/t1')
  assert.ok(taskCall, '应有一次 GET /v1/tasks/t1')
  assert.equal(taskCall.method, 'GET')
})

test('真实协议映射：download 走 GET /files/...', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()], media: pngBytes() })
  const output = { url: '/files/abc.png' }
  const media = await client.download(output)
  assert.equal(media.mediaType, 'image/png')
  const dl = calls.find((c) => c.path.startsWith('/files/'))
  assert.ok(dl, '应有一次 GET /files/...')
  assert.equal(dl.method, 'GET')
})

// ===========================================================================
// 参数 / schema
// ===========================================================================
function describeOnly() {
  return createGateway({ workflows: [sampleWorkflow()] })
}

test('参数/schema：枚举外的值被拒绝', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  assert.throws(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { seed: 10, style: 'zzz', subject: 'cat' } }, description), GatewayError)
})

test('参数/schema：数值越界被拒绝', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  assert.throws(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { seed: 999, style: 'a', subject: 'cat' } }, description), GatewayError)
})

test('参数/schema：必填 custom 缺失且无可套用默认值被拒绝', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  assert.throws(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { seed: 10, style: 'a' } }, description), GatewayError)
})

test('参数/schema：resolution 与 duration_seconds 走 schema 校验', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  assert.throws(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' }, resolution: { megapixels: 99 } }, description), GatewayError)
  assert.throws(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' }, duration_seconds: 999 }, description), GatewayError)
  assert.doesNotThrow(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' }, resolution: { aspect_ratio: '16:9', megapixels: 8 }, duration_seconds: 5 }, description))
})

// ===========================================================================
// defaults
// ===========================================================================
test('defaults：describe 仅暴露公开 schema，且 defaults.custom 仅保留已声明字段', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  const keys = description.customFields.map((f) => f.key)
  assert.ok(keys.includes('seed'))
  assert.ok(keys.includes('style'))
  assert.ok(keys.includes('subject'))
  // 含私有字段名的 customField 不应进入公开描述。
  assert.ok(!keys.includes('apikey'), '包含 apikey 的私有字段必须被剥离')
  assert.deepEqual(description.defaults.custom, { seed: 7 })
  assert.deepEqual(description.defaults.resolution, { aspect_ratio: '16:9' })
})

test('defaults：应用默认值后，缺失的可默认必填项仍被允许', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  // seed 有默认值 7，apply_defaults 默认 true，因此不显式给 seed 也通过。
  assert.doesNotThrow(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { style: 'a', subject: 'cat' } }, description))
  // 关闭默认值且未给 seed（seed 非 required）不应因 defaults 报错。
  assert.doesNotThrow(() => validateInput({ model: 'h3参考', prompt: 'x', custom: { style: 'a', subject: 'cat' }, apply_defaults: false }, description))
})

// ===========================================================================
// 图片 / 音频 base64
// ===========================================================================
test('图片音频base64：原始 base64 与 data URL 都被接受且提取 mimeType', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  const raw = validateReferences([{ nodeId: '9', data: PNG_B64, mimeType: 'image/png' }], description)
  assert.equal(raw[0].mimeType, 'image/png')
  assert.equal(raw[0].data, PNG_B64)
  const viaUrl = validateReferences([{ nodeId: '9', data: `data:image/png;base64,${PNG_B64}` }], description)
  assert.equal(viaUrl[0].mimeType, 'image/png')
  assert.equal(viaUrl[0].data, PNG_B64)
  const audio = validateReferences([{ nodeId: '10', data: MP3_B64, mimeType: 'audio/mpeg' }], description)
  assert.equal(audio[0].mimeType, 'audio/mpeg')
})

test('图片音频base64：类型与槽位不匹配被拒绝', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  // 把音频塞进 image 槽位
  assert.throws(() => validateReferences([{ nodeId: '9', data: MP3_B64, mimeType: 'audio/mpeg' }], description), GatewayError)
  // 把图片塞进 audio 槽位
  assert.throws(() => validateReferences([{ nodeId: '10', data: PNG_B64, mimeType: 'image/png' }], description), GatewayError)
})

test('图片音频base64：非标准 base64（路径/URL）被拒绝', async () => {
  const { client } = describeOnly()
  const description = await client.describe('h3参考')
  assert.throws(() => validateReferences([{ nodeId: '9', data: '/etc/passwd', mimeType: 'image/png' }], description), GatewayError)
  assert.throws(() => validateReferences([{ nodeId: '9', data: 'data:image/png;base64,!!!!notbase64', mimeType: 'image/png' }], description), GatewayError)
})

test('图片音频base64：端到端 submit 时 references 以 base64 形式进入请求体（非路径）', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()] })
  await client.submit({
    model: 'h3参考',
    prompt: 'x',
    custom: { seed: 10, style: 'a', subject: 'cat' },
    references: [{ nodeId: '9', data: PNG_B64, mimeType: 'image/png' }],
  }, 'req-ref')
  const body = JSON.parse(calls[1].body)
  assert.ok(body.references[0].data === PNG_B64)
  assert.ok(!body.references[0].data.includes('/'))
})

// ===========================================================================
// 凭据不泄露
// ===========================================================================
test('凭据不泄露：sanitizeMessage 遮蔽密钥/地址/Bearer/base64/长令牌', () => {
  assert.equal(sanitizeMessage('Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN', ['k']), 'Bearer [已脱敏]')
  assert.equal(sanitizeMessage('see http://evil.example/x now'), 'see [地址已隐藏] now')
  assert.equal(sanitizeMessage('payload data:image/png;base64,AAAA'), 'payload [素材已隐藏]')
  assert.equal(sanitizeMessage('api_key=supersecretvalue'), '[凭据已隐藏]')
  assert.match(sanitizeMessage('token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /\[已脱敏\]/)
  assert.equal(sanitizeMessage('my secret is myrealkey', ['myrealkey']), 'my secret is [已脱敏]')
})

test('凭据不泄露：含 apiKey 的任务错误被脱敏，且 apiKey 不作为可见错误回显', async () => {
  const secret = 'sk-secret-1234567890'
  const { client } = createGateway({
    workflows: [sampleWorkflow()],
    apiKey: secret,
    tasks: { t1: { status: 'failed', outputs: [], error: `boom ${secret} boom` } },
  })
  const snapshot = await client.task('t1')
  assert.equal(snapshot.status, 'failed')
  assert.ok(snapshot.error, '应有错误文案')
  assert.ok(!snapshot.error.includes(secret), '错误不得包含 apiKey 明文')
})

test('凭据不泄露：validateBaseURL 拒绝 URL 内嵌凭据与私网发送 key', () => {
  assert.throws(() => validateBaseURL('http://user:pw@127.0.0.1:6888'), GatewayError)
  assert.throws(() => validateBaseURL('http://127.0.0.1:6888/?x=1'), GatewayError)
  assert.throws(() => validateBaseURL('http://192.168.1.1:6888', 'somekey'), GatewayError)
  assert.doesNotThrow(() => validateBaseURL('http://127.0.0.1:6888'))
})

test('凭据不泄露：请求头携带 Authorization 但仅用于鉴权，调用记录里仍可见（由宿主负责不落盘）', async () => {
  const { client, calls } = createGateway({ workflows: [sampleWorkflow()], apiKey: 'k-123' })
  await client.listWorkflows()
  assert.equal(calls[0].headers.authorization, 'Bearer k-123')
})

// ===========================================================================
// 安全下载限制 / 魔数
// ===========================================================================
test('安全下载限制：content-length 超过上限立即拒绝（RESPONSE_TOO_LARGE）', async () => {
  // 用较小的 maxMediaBytes，并构造一个声明超大 content-length 的响应。
  const overSized = makeResponse({ bytes: pngBytes(), contentType: 'application/octet-stream', contentLength: 1000 })
  const fetchImpl = async () => overSized
  const limited = new GatewayClient({ baseURL: 'http://127.0.0.1:6888', fetchImpl, timeoutMs: 2000, maxMediaBytes: 50 })
  await assert.rejects(() => limited.download({ url: '/files/abc.png' }), (error) => error instanceof GatewayError && error.code === 'RESPONSE_TOO_LARGE')
})

test('安全下载限制/魔数：扩展名与真实魔数不一致被拒绝（INVALID_MEDIA）', async () => {
  const { client } = createGateway({ workflows: [sampleWorkflow()], media: jpegBytes() })
  await assert.rejects(() => client.download({ url: '/files/abc.png' }), (error) => error instanceof GatewayError && error.code === 'INVALID_MEDIA')
})

test('安全下载限制/魔数：魔数正确则按扩展名放行并给出 mediaType', async () => {
  const cases = [
    ['/files/a.png', pngBytes(), 'image/png'],
    ['/files/a.jpeg', jpegBytes(), 'image/jpeg'],
    ['/files/a.webp', webpBytes(), 'image/webp'],
    ['/files/a.mp4', mp4Bytes(), 'video/mp4'],
    ['/files/a.webm', webmBytes(), 'video/webm'],
  ]
  for (const [url, bytes, expected] of cases) {
    const { client } = createGateway({ workflows: [sampleWorkflow()], media: bytes })
    const media = await client.download({ url })
    assert.equal(media.mediaType, expected, `魔数识别错误：${url}`)
    assert.equal(media.kind, expected.startsWith('image') ? 'image' : 'video')
  }
})

// ===========================================================================
// submit_unknown（client 层）
// ===========================================================================
test('submit_unknown：网关未返回唯一 task_id 数组时抛 SUBMIT_UNKNOWN', async () => {
  const { client } = createGateway({ workflows: [sampleWorkflow()], tasks: { __submit__: { task_id: 'not-array' } } })
  await assert.rejects(() => client.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, 'r1'), (error) => error instanceof GatewayError && error.code === 'SUBMIT_UNKNOWN')
})

test('submit_unknown：返回多个 task_id 或非法的 task_id 也抛 SUBMIT_UNKNOWN', async () => {
  const two = createGateway({ workflows: [sampleWorkflow()], tasks: { __submit__: { task_id: ['a', 'b'] } } })
  await assert.rejects(() => two.client.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, 'r2'), (error) => error.code === 'SUBMIT_UNKNOWN')
  const bad = createGateway({ workflows: [sampleWorkflow()], tasks: { __submit__: { task_id: [''] } } })
  await assert.rejects(() => bad.client.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, 'r3'), (error) => error.code === 'SUBMIT_UNKNOWN')
})

test('validateRequestId 与正常 submit 返回唯一任务', async () => {
  assert.equal(validateRequestId('abc.def-_:1'), 'abc.def-_:1')
  assert.throws(() => validateRequestId('../evil'), GatewayError)
  const { client } = createGateway({ workflows: [sampleWorkflow()] })
  const result = await client.submit({ model: 'h3参考', prompt: 'x', custom: { subject: 'cat' } }, 'r4')
  assert.equal(result.taskId, 't1')
  assert.equal(result.accepted, 1)
  assert.equal(result.deduplicated, false)
})
