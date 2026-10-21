import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import test from 'node:test'
import {
  GatewayClient,
  GatewayError,
  sanitizeMessage,
  splitPortPrompt,
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
  return { ok: status >= 200 && status < 300, status, headers, body: stream, redirected, url: '',
    text: async () => new TextDecoder().decode(data), json: async () => JSON.parse(new TextDecoder().decode(data)) }
}

// 默认网关行为可覆写。tasks 以 remoteTaskId 为键返回任务快照；media 返回字节或抛错。
function createGateway({
  baseURL = 'http://127.0.0.1:6888',
  apiKey,
  workflows = [],
  tasks = {},
  media = new Uint8Array(),
  settings,
  nodes,
  loraLibrary,
  referenceStatus = 200,
  referenceContentType = 'image/png',
  referenceBytes = pngBytes(),
  referenceContentLength,
  optionGroups,
  onCall,
} = {}) {
  const calls = []
  const writes = []
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const record = { method, path: u.pathname, headers: options.headers, body: options.body }
    calls.push(record)
    onCall?.(record)
    if (u.pathname === '/api/workflows') return makeResponse({ text: JSON.stringify(workflows) })
    if (u.pathname === '/api/settings') return makeResponse({ text: JSON.stringify(settings ?? { defaultModel: '' }) })
    if (u.pathname === '/api/option-groups') return makeResponse({ text: JSON.stringify({ groups: optionGroups ?? [] }) })
    if (/^\/api\/workflows\/[^/]+\/nodes$/.test(u.pathname)) return makeResponse({ text: JSON.stringify(nodes ?? []) })
    if (u.pathname === '/api/lora-library') return makeResponse({ text: JSON.stringify(loraLibrary ?? { loras: [], maxConcurrent: 1, enabled: true }) })
    if (method === 'PUT' && /^\/api\/workflows\/[^/]+\/(defaults|duration|seed|model-field)$/.test(u.pathname)) {
      const body = JSON.parse(options.body || '{}')
      writes.push({ path: u.pathname, method, body, search: u.search })
      return makeResponse({ text: JSON.stringify({ alias: decodeURIComponent(u.pathname.split('/')[3]), ...body, updatedAt: 'updated-2' }) })
    }
    if (method === 'PUT' && /^\/api\/workflows\/[^/]+\/reference-slots\/[^/]+$/.test(u.pathname)) {
      const body = JSON.parse(options.body || '{}')
      writes.push({ path: u.pathname, method, body, search: u.search })
      return makeResponse({ text: JSON.stringify({ alias: 'demo', referenceSlots: [] }) })
    }
    if (/^\/api\/workflows\/[^/]+\/defaults\/references\/[^/]+$/.test(u.pathname)) {
      const bytes = typeof referenceBytes === 'function' ? referenceBytes(u.pathname) : referenceBytes
      return makeResponse({ bytes, contentType: referenceContentType, status: referenceStatus, contentLength: referenceContentLength })
    }
    if (method === 'POST' && /^\/api\/workflows\/[^/]+\/port-directive$/.test(u.pathname)) {
      const body = JSON.parse(options.body || '{}')
      if (body.mode === 'bad') return makeResponse({ status: 400, text: JSON.stringify({ error: { message: '模板缺少参考图' } }) })
      return makeResponse({ text: JSON.stringify({ text: '模板正文', mode: body.mode }) })
    }
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
  return { client, calls, writes, apiKey }
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
  assert.ok(calls.length >= 2, '至少应有一次列表与一次提交')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, '/api/workflows')
  const post = calls.find((c) => c.path === '/v1/images/generations')
  assert.ok(post, '应有一次 POST /v1/images/generations')
  assert.equal(post.method, 'POST')
  const body = JSON.parse(post.body)
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
  const post = calls.find((c) => c.path === '/v1/images/generations')
  assert.ok(post, '应有一次 POST /v1/images/generations')
  const body = JSON.parse(post.body)
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

// ===========================================================================
// 既定契约：listWorkflows DTO 公开字段 / revision / referenceGroups
// ===========================================================================
function samplePipelineWorkflows() {
  const image = {
    alias: 'img-wf',
    customFields: [],
    referenceSlots: [{ nodeId: '3', kind: 'image', label: '首帧' }],
    defaults: { references: [{ nodeId: '3', kind: 'image', name: 'frame.png', fileName: 'secret-frame.png', mimeType: 'image/png', size: 12, note: '首帧' }], updatedAt: 'u-img' },
    capabilities: {},
  }
  const video = {
    alias: 'vid-wf',
    customFields: [],
    referenceSlots: [{ nodeId: '7', kind: 'image', label: '参考图' }],
    defaults: { references: [{ nodeId: '7', kind: 'image', name: 'ref.png', fileName: 'secret-ref.png', mimeType: 'image/png', size: 20, note: '参考' }], updatedAt: 'u-vid' },
    capabilities: {},
  }
  const pipeline = {
    alias: 'pipe-wf',
    customFields: [],
    referenceSlots: [],
    pipeline: { kind: 'first-frame', imageWorkflowAlias: 'img-wf', videoWorkflowAlias: 'vid-wf' },
    defaults: { references: [], updatedAt: 'u-pipe' },
    capabilities: {},
  }
  return [pipeline, image, video]
}

test('listWorkflows DTO：保留参考素材但绝不暴露 fileName，且含 defaults note/pools/updatedAt/promptSuffix/presetIds', async () => {
  const workflows = [{
    alias: 'h3参考',
    customFields: [{ key: 'lora', aiLora: true, loraLibrary: 'pose', strengthKey: 'strength', type: 'string' }],
    referenceSlots: [{ nodeId: '9', kind: 'image' }],
    defaults: {
      references: [{ nodeId: '9', kind: 'image', name: 'a.png', fileName: 'SECRET-a.png', mimeType: 'image/png', size: 10, note: '女主' }],
      referencePools: [{ nodeId: '9', galleryIds: ['g1', 'g2'], note: '池' }],
      note: '预设备注',
      promptSuffix: ' suffix',
      presetIds: ['p1', 'p2'],
      updatedAt: 'u1',
      custom: { seed: 1 },
    },
    capabilities: {},
    updatedAt: 'w1',
    primarySite: 'hailuo',
    resolutionNodeId: '30',
  }]
  const { client } = createGateway({ workflows })
  const list = await client.listWorkflows()
  const wf = list[0]
  assert.equal(wf.alias, 'h3参考')
  assert.equal(wf.primarySite, 'hailuo')
  assert.equal(wf.resolutionNodeId, '30')
  assert.equal(wf.defaults.references[0].nodeId, '9')
  assert.equal(wf.defaults.references[0].name, 'a.png')
  assert.equal(wf.defaults.references[0].mimeType, 'image/png')
  assert.equal(wf.defaults.references[0].size, 10)
  assert.equal(wf.defaults.references[0].note, '女主')
  assert.equal('fileName' in wf.defaults.references[0], false, '默认素材 fileName 不得暴露')
  assert.deepEqual(wf.defaults.referencePools[0], { nodeId: '9', galleryIds: ['g1', 'g2'], note: '池' })
  assert.equal(wf.defaults.note, '预设备注')
  assert.equal(wf.defaults.promptSuffix, ' suffix')
  assert.deepEqual(wf.defaults.presetIds, ['p1', 'p2'])
  assert.equal(wf.defaults.updatedAt, 'u1')
  // 敏感字段不泄露
  const json = JSON.stringify(wf)
  assert.ok(!json.includes('SECRET-a.png'), 'fileName 不得出现在序列化结果')
  // strengthKey / aiLora 保留
  const loraField = wf.customFields.find((f) => f.key === 'lora')
  assert.equal(loraField.strengthKey, 'strength')
  assert.equal(loraField.aiLora, true)
  // revision 存在且为短哈希
  assert.equal(typeof wf.revision, 'string')
  assert.ok(/^[0-9a-f]{16}$/.test(wf.revision))
})

test('listWorkflows DTO：管线带 referenceGroups（只读子工作流，避免把本体槽当上传槽）', async () => {
  const { client } = createGateway({ workflows: samplePipelineWorkflows() })
  const list = await client.listWorkflows()
  const pipe = list.find((w) => w.alias === 'pipe-wf')
  assert.ok(pipe, '管线应出现在列表')
  assert.ok(Array.isArray(pipe.referenceGroups))
  assert.equal(pipe.referenceGroups.length, 2)
  const imageGroup = pipe.referenceGroups.find((g) => g.alias === 'img-wf')
  const videoGroup = pipe.referenceGroups.find((g) => g.alias === 'vid-wf')
  assert.equal(imageGroup.title, '生图')
  assert.equal(videoGroup.title, '视频')
  assert.equal(imageGroup.referenceSlots[0].nodeId, '3')
  assert.equal(imageGroup.defaults.references[0].name, 'frame.png')
  assert.equal('fileName' in imageGroup.defaults.references[0], false)
  assert.equal(videoGroup.referenceSlots[0].nodeId, '7')
  assert.ok(typeof imageGroup.revision === 'string' && imageGroup.revision !== pipe.revision, '子工作流 revision 独立')
})

test('listWorkflows DTO：broken 工作流保留 broken 标记且不暴露 blobs', async () => {
  const { client } = createGateway({ workflows: [{ alias: 'broken-wf', broken: true, brokenReason: '模板损坏', defaults: null, updatedAt: 'x', primarySite: '', capabilities: {} }] })
  const list = await client.listWorkflows()
  assert.equal(list[0].broken, true)
  assert.equal(list[0].brokenReason, '模板损坏')
  // DTO 始终为对象；broken 工作流不应带任何素材 blob（fileName/参考图等）。
  assert.ok(list[0].defaults && typeof list[0].defaults === 'object')
  assert.equal('fileName' in list[0], false)
  assert.equal('credential' in list[0], false)
})

// ===========================================================================
// 既定契约：getSettings 仅回 defaultModel
// ===========================================================================
test('getSettings 仅返回 defaultModel，不暴露其它 settings 字段', async () => {
  const { client } = createGateway({ workflows: [sampleWorkflow()], settings: { defaultModel: 'h3参考', maxParallelGenerations: 8, defaultParallel: 2, apiConcurrency: 4 } })
  const settings = await client.getSettings()
  assert.deepEqual(settings, { defaultModel: 'h3参考' })
})

// ===========================================================================
// 既定契约：describe 补 capabilities.resolutionFields 与 aiLora 动态 options
// ===========================================================================
test('describe：节点 API 补 capabilities.resolutionFields（404 兼容旧 mock）', async () => {
  const { client } = createGateway({
    workflows: [{ alias: 'h3参考', resolutionNodeId: '30', customFields: [], referenceSlots: [], defaults: { references: [], updatedAt: 'u' }, capabilities: {}, primarySite: 'hailuo' }],
    nodes: [
      { id: '11', type: 'Note', fields: [], resolutionFields: [] },
      { id: '30', type: 'EmptyLatentImage', fields: ['width', 'height'], resolutionFields: ['width', 'height'] },
    ],
  })
  const described = await client.describe('h3参考')
  assert.deepEqual(described.capabilities.resolutionFields, ['width', 'height'])
})

test('describe：无 resolutionNodeId 时取第一个有 resolutionFields 的节点', async () => {
  const { client } = createGateway({
    workflows: [{ alias: 'h3参考', resolutionNodeId: '', customFields: [], referenceSlots: [], defaults: { references: [], updatedAt: 'u' }, capabilities: {}, primarySite: '' }],
    nodes: [{ id: '5', type: 'EmptyLatentImage', fields: ['width'], resolutionFields: ['width', 'height'] }],
  })
  const described = await client.describe('h3参考')
  assert.deepEqual(described.capabilities.resolutionFields, ['width', 'height'])
})

test('describe：节点 API 404 时 resolutionFields 不出现（兼容旧 mock，不瞎猜）', async () => {
  const { client } = createGateway({ workflows: [sampleWorkflow()] })
  const described = await client.describe('h3参考')
  assert.equal(described.capabilities.resolutionFields, undefined)
})

test('describe：aiLora 动态 options 来自 LoRA 库且关联 strengthKey', async () => {
  const wf = sampleWorkflow()
  wf.customFields = [
    { key: 'lora', aiLora: true, loraLibrary: 'pose', strengthKey: 'strength', type: 'string' },
    { key: 'strength', type: 'number' },
  ]
  const { client } = createGateway({
    workflows: [wf],
    loraLibrary: { loras: [{ name: 'poseA.safetensors', note: '姿势A', triggers: 'trigA', strength: 0.8 }], maxConcurrent: 1, enabled: true },
  })
  const described = await client.describe('h3参考')
  const loraField = described.customFields.find((f) => f.key === 'lora')
  assert.ok(Array.isArray(loraField.aiLoraOptions), 'aiLora 字段应有动态 options')
  assert.equal(loraField.aiLoraOptions[0].value, 'poseA.safetensors')
  assert.equal(loraField.aiLoraOptions[0].label, '姿势A')
  assert.equal(loraField.aiLoraOptions[0].triggers, 'trigA')
  assert.equal(loraField.aiLoraOptions[0].strength, 0.8)
  assert.equal(loraField.strengthKey, 'strength')
})

test('describe：LoRA 库为空时 aiLora 选项为空数组且不抛错', async () => {
  const wf = sampleWorkflow()
  wf.customFields = [{ key: 'lora', aiLora: true, loraLibrary: 'pose', type: 'string' }]
  const { client } = createGateway({ workflows: [wf], loraLibrary: { loras: [], maxConcurrent: 1, enabled: true } })
  const described = await client.describe('h3参考')
  const loraField = described.customFields.find((f) => f.key === 'lora')
  assert.ok(Array.isArray(loraField.aiLoraOptions), 'aiLora 选项应为数组（可为空）')
  assert.equal(loraField.aiLoraOptions.length, 0)
})

// ===========================================================================
// 既定契约：readReference 路径编码 / 大小 / 类型 / 缺槽 / 401
// ===========================================================================
function workflowWithReference(nodeId, kind = 'image') {
  return {
    alias: 'h3参考',
    customFields: [],
    referenceSlots: [{ nodeId, kind }],
    defaults: { references: [{ nodeId, kind, name: kind === 'audio' ? 'ref.mp3' : 'ref.png', fileName: 'secret.png', mimeType: kind === 'audio' ? 'audio/mpeg' : 'image/png', size: 16, note: 'x' }], updatedAt: 'u' },
    capabilities: {},
  }
}

test('readReference：拉固定原文件端点，路径编码正确，返回 data/mediaType/name/kind', async () => {
  const { client, calls } = createGateway({ workflows: [workflowWithReference('9')] })
  const ref = await client.readReference('h3参考', '9')
  assert.ok(calls.some((c) => c.path === '/api/workflows/h3%E5%8F%82%E8%80%83/defaults/references/9'), '应请求固定原文件端点且别名已编码')
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.kind, 'image')
  assert.equal(ref.name, 'ref.png')
  assert.ok(ref.data instanceof Uint8Array)
})

test('readReference：缺槽（nodeId 不存在）被拒', async () => {
  const { client } = createGateway({ workflows: [workflowWithReference('9')] })
  await assert.rejects(() => client.readReference('h3参考', '99'), GatewayError)
})

test('readReference：未确认工作流别名被拒', async () => {
  const { client } = createGateway({ workflows: [workflowWithReference('9')] })
  await assert.rejects(() => client.readReference('nope', '9'), GatewayError)
})

test('readReference：仅接受图片/音频 MIME，其它类型（HTML）被拒', async () => {
  const { client } = createGateway({ workflows: [workflowWithReference('9')], referenceContentType: 'text/html' })
  await assert.rejects(() => client.readReference('h3参考', '9'), (e) => e instanceof GatewayError && e.code === 'INVALID_MEDIA')
})

test('readReference：超 10MB 上限被拒（RESPONSE_TOO_LARGE）', async () => {
  const { client } = createGateway({ workflows: [workflowWithReference('9')], referenceBytes: pngBytes(), referenceContentLength: 11 * 1024 * 1024 })
  await assert.rejects(() => client.readReference('h3参考', '9'), (e) => e instanceof GatewayError && e.code === 'RESPONSE_TOO_LARGE')
})

test('readReference：网关返回 401 显式拒绝', async () => {
  const { client } = createGateway({ workflows: [workflowWithReference('9')], referenceStatus: 401 })
  await assert.rejects(() => client.readReference('h3参考', '9'), (e) => e instanceof GatewayError && e.status === 401)
})

test('readReference：音频 MIME 被接受', async () => {
  const { client } = createGateway({
    workflows: [workflowWithReference('10', 'audio')],
    referenceBytes: new Uint8Array([0xff, 0xfb, 0x10, 0, 1, 2]),
    referenceContentType: 'audio/mpeg',
  })
  const ref = await client.readReference('h3参考', '10')
  assert.equal(ref.kind, 'audio')
  assert.equal(ref.mediaType, 'audio/mpeg')
})

test('readReference：伪装图片 MIME 的 HTML 和 SVG 被拒', async () => {
  for (const [referenceContentType, referenceBytes] of [
    ['image/png', Buffer.from('  <!doctype html><script>alert(1)</script>')],
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ]) {
    const { client } = createGateway({ workflows: [workflowWithReference('9')], referenceContentType, referenceBytes })
    await assert.rejects(() => client.readReference('h3参考', '9'), error => error.code === 'INVALID_MEDIA')
  }
})

test('revision 随参数与槽位变化，管线分辨率和素材源遵循客户端', async () => {
  const raw = samplePipelineWorkflows()
  const pipe = raw.find(item => item.alias === 'pipe-wf')
  pipe.pipeline.kind = 'first-frame'
  pipe.pipelineImageResolutionFields = ['width', 'height']
  const { client } = createGateway({ workflows: raw })
  assert.deepEqual((await client.describe('pipe-wf')).capabilities.resolutionFields, ['width', 'height'])
  const before = (await client.listWorkflows()).find(item => item.alias === 'pipe-wf').revision
  pipe.customFields.push({ key: 'new-field', type: 'number', min: 0, max: 1 })
  const after = (await client.listWorkflows()).find(item => item.alias === 'pipe-wf').revision
  assert.notEqual(before, after)
  pipe.pipeline.kind = 'grid'
  pipe.pipeline.videoRefSource = 'image'
  assert.equal((await client.describe('pipe-wf')).referenceGroups.length, 1)
})

test('broken 工作流必须拒绝提交（validateInput 拦截）', async () => {
  const broken = { alias: 'broken-wf', broken: true, brokenReason: '模板损坏', customFields: [], referenceSlots: [], capabilities: {}, defaults: { references: [], updatedAt: 'u' } }
  const { client } = createGateway({ workflows: [broken] })
  const description = (await client.listWorkflows()).find((w) => w.alias === 'broken-wf')
  assert.throws(() => validateInput({ model: 'broken-wf', prompt: 'x', custom: {} }, description), GatewayError)
})

test('splitPortPrompt：单段标记、管线双段、书名号还原与非法输入', () => {
  assert.deepEqual(splitPortPrompt('image###\n《Picture 1》 镜头\n###'), { prompt: '<Picture 1> 镜头', imagePrompt: '' })
  assert.deepEqual(splitPortPrompt('image###\n生图\n###\n\nvideo###\n视频\n###', 'first-frame'), { prompt: '视频', imagePrompt: '生图' })
  assert.deepEqual(splitPortPrompt('纯手写提示词'), { prompt: '纯手写提示词', imagePrompt: '' })
  assert.throws(() => splitPortPrompt('image###\n只有生图\n###', 'first-frame'), /两段提示词/)
  assert.throws(() => splitPortPrompt('没有标记', 'first-frame'), /两段提示词/)
  assert.throws(() => splitPortPrompt('   '), /不能为空/)
})

test('getOptionGroups：只回 id/label/values，丢弃非法项和私有字段', async () => {
  const { client } = createGateway({ optionGroups: [
    { id: 'g1', label: ' 组一 ', values: ['a', 'b', '', 'x'.repeat(600)], apiKey: 'SECRET' },
    { id: '', label: '坏组', values: ['x'] },
    { id: 'g2', label: '', values: 'not-array', account: 'SECRET' },
  ] })
  assert.deepEqual(await client.getOptionGroups(), [
    { id: 'g1', label: '组一', values: ['a', 'b'] },
    { id: 'g2', label: 'g2', values: [] },
  ])
})

test('saveDefaults：整组提交预设/分辨率/自定义/素材/随机池，并带 baseUpdatedAt', async () => {
  const { client, writes } = createGateway()
  const data = Buffer.from(pngBytes()).toString('base64')
  const result = await client.saveDefaults('h3参考', {
    presetIds: ['cinematic'],
    promptSuffix: '电影感',
    resolution: { aspect_ratio: '16:9', megapixels: 1.5 },
    custom: { quality: 2, stabilize: false },
    references: [{ nodeId: '9', kind: 'image', name: 'a.png', mimeType: 'image/png', data, note: '女主' }],
    referencePools: [{ nodeId: '9', galleryIds: ['00000000-0000-4000-8000-000000000001'], note: '池' }],
    baseUpdatedAt: 'updated-1',
  })
  assert.equal(result.alias, 'h3参考')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/workflows/h3%E5%8F%82%E8%80%83/defaults')
  assert.deepEqual(writes[0].body, {
    presetIds: ['cinematic'], promptSuffix: '电影感', resolution: { aspect_ratio: '16:9', megapixels: 1.5 },
    custom: { quality: 2, stabilize: false },
    references: [{ nodeId: '9', kind: 'image', note: '女主', name: 'a.png', mimeType: 'image/png', data }],
    referencePools: [{ nodeId: '9', galleryIds: ['00000000-0000-4000-8000-000000000001'], note: '池' }],
    baseUpdatedAt: 'updated-1',
  })
})

test('saveDefaults：拒绝未知字段、非标准 base64 和 fileName 泄漏', async () => {
  const { client, writes } = createGateway()
  await assert.rejects(client.saveDefaults('demo', { nope: true }), /未知参数/)
  await assert.rejects(client.saveDefaults('demo', { references: [{ nodeId: '9', name: 'a.png', mimeType: 'image/png', data: 'not base64 !' }] }), /base64/)
  await assert.rejects(client.saveDefaults('demo', { references: [{ nodeId: '9', fileName: 'SECRET.png', kind: 'image' }] }), /未知参数/)
  assert.equal(writes.length, 0)
})

test('saveDuration / saveSeed / saveModelField / setReferenceSlot：路径、站点与 body 精确', async () => {
  const { client, writes } = createGateway()
  await client.saveDuration('demo', 'international', 8)
  await client.saveDuration('demo', '', null)
  await client.saveSeed('demo', 'international', '9.noise_seed', 42)
  await client.saveSeed('demo', 'international', '9.noise_seed', null)
  await client.saveModelField('demo', 'international', '95.unet_name', { value: 'b.safetensors' })
  await client.saveModelField('demo', 'international', '95.unet_name', { groupId: 'g1' })
  await client.setReferenceSlot('demo', '10', true)
  assert.deepEqual(writes.map(item => ({ path: item.path, search: item.search, body: item.body })), [
    { path: '/api/workflows/demo/duration', search: '?site=international', body: { seconds: 8 } },
    { path: '/api/workflows/demo/duration', search: '', body: { seconds: null } },
    { path: '/api/workflows/demo/seed', search: '?site=international', body: { target: '9.noise_seed', value: 42 } },
    { path: '/api/workflows/demo/seed', search: '?site=international', body: { target: '9.noise_seed', value: null } },
    { path: '/api/workflows/demo/model-field', search: '?site=international', body: { target: '95.unet_name', value: 'b.safetensors' } },
    { path: '/api/workflows/demo/model-field', search: '?site=international', body: { target: '95.unet_name', groupId: 'g1' } },
    { path: '/api/workflows/demo/reference-slots/10', search: '', body: { enabled: true } },
  ])
})

test('settings helpers：参数非法时在网络请求前拒绝', async () => {
  const { client, writes } = createGateway()
  await assert.rejects(client.saveDuration('demo', 'bad site', 8), /站点/)
  await assert.rejects(client.saveDuration('demo', '', 0), /片长/)
  await assert.rejects(client.saveSeed('demo', '', 'bad target', 1), /字段/)
  await assert.rejects(client.saveSeed('demo', '', '9.seed', -1), /整数/)
  await assert.rejects(client.saveModelField('demo', '', '9.seed', {}), /没有要保存/)
  await assert.rejects(client.setReferenceSlot('demo', '../9', true), /槽位/)
  await assert.rejects(client.saveDefaults('', {}), /别名/)
  assert.equal(writes.length, 0)
})

test('portDirective：带参考素材清单/mediaLimits/片长，并校验标签与未知字段', async () => {
  const { client, calls } = createGateway()
  const result = await client.portDirective('demo', 'qwen-multi-h3', undefined, {
    references: [{ kind: 'image', label: '生图·参考图 1', tag: '<image1>', note: '女主外貌' }],
    mediaLimits: { picture: 1, video: 0, audio: 0 },
    durationSeconds: 5,
    aspectRatio: '16:9',
  })
  assert.deepEqual(result, { text: '模板正文', mode: 'qwen-multi-h3' })
  const call = calls.at(-1)
  assert.equal(call.path, '/api/workflows/demo/port-directive')
  assert.deepEqual(JSON.parse(call.body), {
    mode: 'qwen-multi-h3', prompt: '',
    references: [{ kind: 'image', label: '生图·参考图 1', tag: '<image1>', note: '女主外貌' }],
    mediaLimits: { picture: 1, video: 0, audio: 0 },
    durationSeconds: 5,
    aspectRatio: '16:9',
  })
  const before = calls.length
  await assert.rejects(client.portDirective('demo', 'qwen-h3', undefined, { nope: true }), /未知参数/)
  await assert.rejects(client.portDirective('demo', 'qwen-h3', undefined, {
    references: [{ kind: 'image', label: 'x', tag: '<Bad 1>' }],
  }), /标签/)
  await assert.rejects(client.portDirective('demo', 'qwen-h3', undefined, { mediaLimits: { picture: -1 } }), /上限/)
  assert.equal(calls.length, before, '非法参数必须在请求前拒绝')
})

test('portDirective：网关 400 的 error.message 会带进异常文本', async () => {
  const { client } = createGateway()
  await assert.rejects(client.portDirective('demo', 'bad'), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /模板缺少参考图/)
    return true
  })
})

test('splitPortPrompt：模型把标记写在同一行（image###正文###）也能拆成两段', () => {
  const inline = 'image###真人照片感，女性躺在床上###\nvideo###The woman lies on the bed, breathing slowly.###'
  assert.deepEqual(splitPortPrompt(inline, 'first-frame'), {
    prompt: 'The woman lies on the bed, breathing slowly.',
    imagePrompt: '真人照片感，女性躺在床上',
  })
  const sameLine = 'image###A shot### video###B shot###'
  assert.deepEqual(splitPortPrompt(sameLine, 'first-frame'), { prompt: 'B shot', imagePrompt: 'A shot' })
  assert.throws(() => splitPortPrompt('image###只有生图###', 'first-frame'), /两段提示词/)
})
