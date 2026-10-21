import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { GatewayClient, GatewayError, sanitizeMessage, validateBaseURL, validateInput, validateRequestId } from './lib/client.mjs'
import { TaskStore, TaskEngine, validateJobId } from './lib/tasks.mjs'

export const name = 'dsh-runninghub'
export const inject = ['tavern', 'attachments', 'credentials', 'webServer']
export const API = '/api/dsh-runninghub'
export const MEDIA = API + '/media'
export const REFERENCE = API + '/reference'
const DEFAULT_BASE = 'http://127.0.0.1:6888'
const ACTIVE = new Set(['preparing', 'submitting', 'submit_unknown', 'queued', 'running', 'downloading'])
const fail = (message, code = 'VALIDATION_ERROR') => new GatewayError(message, { code, rejected: true })

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('包含未知参数或请求格式无效')
}
function credentialName(baseURL) {
  return 'DSH_RUNNINGHUB_' + createHash('sha256').update(baseURL).digest('hex').slice(0, 24).toUpperCase() + '_KEY'
}
async function atomicJSON(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp'
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value) + '\n')
    await handle.sync()
    await handle.close(); handle = undefined
    await rename(temp, file)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temp).catch(() => {})
  }
}
function sameOrigin(req) {
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false
  const origin = req.headers.origin, host = req.headers.host
  return origin === undefined || typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`)
}
function json(res, status, body) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function bodyJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('请求必须是 JSON', 'UNSUPPORTED_TYPE')
  const chunks = []; let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 25 * 1024 * 1024) throw fail('请求超过 25MB', 'TOO_LARGE')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail('JSON 格式无效') }
}

/** Zero-dependency host bridge. Configuration contains no key; DSH credentials own secrets. */
export async function createRunningHubHost(ctx, config = {}, options = {}) {
  const directory = path.resolve(config.dataDirectory || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'profile-data', 'tavern', 'data', 'runninghub'))
  const store = new TaskStore({ directory: path.join(directory, 'tasks') })
  await store.init()
  const settingsFile = path.join(directory, 'connection.json')
  let settings
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw fail('RunningHub 连接配置损坏', 'STORE_ERROR') }
  let baseURL = validateBaseURL(settings?.baseURL ?? config.baseURL ?? DEFAULT_BASE).href.replace(/\/$/, '')
  let autoInsert = settings?.autoInsert === true
  const linksDirectory = path.join(directory, 'bindings')
  await mkdir(linksDirectory, { recursive: true, mode: 0o700 })
  const insertionErrors = new Map()
  let reconcileTimer
  let engine, client, clientIdentity, disposed = false, workflows = [], workflowError = ''
  let queue = Promise.resolve()
  const serial = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result }
  const clientFactory = options.clientFactory ?? (value => new GatewayClient(value))
  const fetchImpl = options.fetchImpl ?? fetch
  const bindingQueues = new Map()
  function bindingSerial(job, operation) {
    const previous = bindingQueues.get(job.id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    bindingQueues.set(job.id, next)
    return next.finally(() => { if (bindingQueues.get(job.id) === next) bindingQueues.delete(job.id) })
  }
  async function resolvedBinding(job, resolutions) {
    if (!job.binding?.generationId) return job.binding
    const file = path.join(linksDirectory, job.id + '.json')
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const generationKey = JSON.stringify([job.binding.gameId, job.binding.generationId])
    let value
    if (resolutions?.has(generationKey)) value = resolutions.get(generationKey)
    else {
      value = await ctx.tavern.resolveGeneration(job.binding)
      // Freeze even a null result for this pass. A generation settling halfway
      // through reconciliation must not let later submissions overtake the first.
      resolutions?.set(generationKey, value ?? null)
    }
    if (!value) return null
    const binding = { ...value, anchor: job.binding.anchor || '' }
    await atomicJSON(file, binding)
    return binding
  }
  async function insert(job, media, outputIndex = 0, resolutions) {
    const binding = await resolvedBinding(job, resolutions)
    if (!binding?.gameId) return
    const items = await ctx.tavern.list({ gameId: binding.gameId, turn: binding.turn })
    const existing = items.find(item => item.textVersion === binding.textVersion && item.data?.runninghubJob === job.id && item.data?.outputIndex === outputIndex)
    const failed = ['failed', 'submit_unknown', 'download_failed'].includes(job.status)
    const changes = { kind: media?.kind || 'video', status: media ? 'ready' : failed ? 'failed' : 'pending',
      ...(media ? { attachment: media.attachment } : {}), error: media ? '' : failed ? job.error || '生成未完成' : '',
      anchor: binding.anchor || '', caption: `RunningHub · ${job.model}` }
    if (existing) {
      if (existing.status !== 'ready' || media && existing.attachment?.attachmentId !== media.attachment?.attachmentId) await ctx.tavern.update(existing.id, changes)
    } else await ctx.tavern.attach({ ...binding, item: { ...changes, data: { runninghubJob: job.id, outputIndex } } })
  }
  async function reconcileJob(job, resolutions) {
    if (!job.binding?.gameId || disposed) return
    return bindingSerial(job, async () => {
      try {
        if (job.attachments?.length) {
          for (let index = 0; index < job.attachments.length; index++) await insert(job, job.attachments[index], index, resolutions)
        } else if (job.binding.generationId) await insert(job, undefined, 0, resolutions)
        insertionErrors.delete(job.id)
      } catch (error) { insertionErrors.set(job.id, sanitizeMessage(error.message)) }
    })
  }
  let reconcileQueue = Promise.resolve()
  function reconcile() {
    const next = reconcileQueue.catch(() => {}).then(async () => {
      if (disposed) return
      // Submission order, not download completion order, establishes media order.
      const resolutions = new Map()
      for (const job of (await store.list()).reverse()) await reconcileJob(job, resolutions)
    })
    reconcileQueue = next
    return next
  }
  async function bindMedia(job, media) {
    if (!job.binding?.gameId || job.binding.generationId) return
    return bindingSerial(job, () => insert(job, media, job.outputIndex)).catch(error => {
      insertionErrors.set(job.id, sanitizeMessage(error.message))
    })
  }
  async function onMedia(job, media) {
    const attachment = media.kind === 'image'
      ? await ctx.attachments.saveImage({ data: media.data, mediaType: media.mediaType, name: media.name })
      : await ctx.attachments.saveFile({ data: media.data, name: media.name })
    // Video refs deliberately have no mediaType: Tavern validates that field as an image.
    const ref = media.kind === 'image' ? attachment : { attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes }
    const saved = { kind: media.kind, name: media.name, mediaType: media.mediaType, attachment: ref,
      url: `${MEDIA}?id=${job.id}&index=${job.outputIndex}` }
    await bindMedia(job, saved)
    return saved
  }
  async function onChange(job) {
    if (job.binding?.generationId) await reconcile()
    else await reconcileJob(job)
  }
  async function connect() {
    if (disposed) throw fail('插件已停止', 'DISPOSED')
    const credential = await ctx.credentials.resolve(credentialName(baseURL))
    const apiKey = credential?.value || ''
    if (!apiKey) throw fail('请先在 RunningHub 面板保存网关 Key', 'NOT_CONFIGURED')
    const identity = createHash('sha256').update(baseURL + '\n' + apiKey).digest('hex')
    if (!engine || identity !== clientIdentity) {
      engine?.dispose()
      client = clientFactory({ baseURL, apiKey, fetchImpl })
      engine = new TaskEngine({ client, store, onMedia, onChange, pollMs: options.pollMs ?? 5000 })
      clientIdentity = identity
      await engine.init()
    }
    return { client, engine }
  }
  async function summary() {
    let configured = Boolean((await ctx.credentials.resolve(credentialName(baseURL)))?.value)
    let settingsError = ''
    let model = ''
    if (configured) {
      try {
        const active = await connect()
        workflows = await active.client.listWorkflows()
        workflowError = ''
        let defaultModel = ''
        // 模型取服务端默认；获取失败不让工作流列表丢失，单独记录同步错误。
        try {
          if (typeof active.client.getSettings === 'function') {
            const settings = await active.client.getSettings()
            defaultModel = settings?.defaultModel ?? ''
          }
        } catch (error) { settingsError = sanitizeMessage(error.message) }
        const usable = workflows.filter((w) => !w.broken)
        if (defaultModel && usable.some((w) => w.alias === defaultModel)) model = defaultModel
        else if (usable[0]) model = usable[0].alias
      }
      catch (error) { workflowError = sanitizeMessage(error.message) }
    }
    await reconcile()
    return { configured, baseURL, autoInsert, adapter: 'gateway', model, jobs: (await store.list()).map(job => ({ ...job,
      ...(insertionErrors.has(job.id) ? { insertionError: insertionErrors.get(job.id) } : {}) })), workflows, ...(workflowError ? { gatewayError: workflowError } : {}), ...(settingsError ? { settingsError } : {}) }
  }
  async function configure(input) {
    keys(input, ['action', 'baseURL', 'apiKey'])
    const nextBase = validateBaseURL(input.baseURL).href.replace(/\/$/, '')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || /[\r\n]/.test(input.apiKey) || input.apiKey.length > 4096)) throw fail('网关 Key 格式无效')
    if ((await store.list()).some(job => ACTIVE.has(job.status))) throw fail('仍有运行中或待对账任务，连接设置暂时锁定')
    const supplied = input.apiKey?.trim()
    const ref = credentialName(nextBase), previous = await ctx.credentials.resolve(ref)
    if (!supplied && !previous?.value) throw fail('新网关地址需要填写 Key；旧地址的 Key 不会发送到新地址')
    if (supplied && supplied !== previous?.value) {
      const info = await ctx.credentials.describe?.(ref)
      if (previous?.source === 'env' || info?.source === 'env' || info?.writable === false) throw fail('网关 Key 来自只读凭据，请修改凭据来源')
      await ctx.credentials.set(ref, supplied)
    }
    await atomicJSON(settingsFile, { baseURL: nextBase, autoInsert })
    engine?.dispose(); engine = undefined; client = undefined; clientIdentity = undefined
    baseURL = nextBase; workflows = []; workflowError = ''
    return { configured: true, baseURL, adapter: 'gateway' }
  }
  async function bindingOf(input) {
    if (input.bindToTurn !== undefined && typeof input.bindToTurn !== 'boolean') throw fail('bindToTurn 必须是布尔值')
    if (!input.bindToTurn) return undefined
    if (typeof input.gameId !== 'string' || !input.gameId) throw fail('绑定轮次需要当前游戏 ID')
    const state = await ctx.tavern.getTurnState({ gameId: input.gameId })
    if (!state.settled || state.busy || !Number.isInteger(state.turn) || state.turn < 1) throw fail('当前轮次尚未结算，请稍后提交或取消绑定')
    const turn = await ctx.tavern.getTurn({ gameId: input.gameId, turn: state.turn })
    if (!turn || turn.textVersion !== state.textVersion) throw fail('当前正文版本已变化，请刷新后提交')
    return { gameId: turn.gameId, turn: turn.turn, textVersion: turn.textVersion }
  }
  async function dispatch(input = { action: 'list' }, exec) {
    return serial(async () => {
      if (!object(input)) throw fail('请求格式无效')
      if (disposed) throw fail('插件已停止', 'DISPOSED')
      if (input.action === 'preferences') {
        keys(input, ['action', 'autoInsert'])
        if (typeof input.autoInsert !== 'boolean') throw fail('autoInsert 必须是布尔值')
        await atomicJSON(settingsFile, { baseURL, autoInsert: input.autoInsert })
        autoInsert = input.autoInsert
        return { autoInsert }
      }
      if (input.action === 'configure') return configure(input)
      if (input.action === 'list') { keys(input, ['action']); return summary() }
      const active = await connect()
      if (input.action === 'describe') {
        keys(input, ['action', 'model'])
        return active.client.describe(input.model)
      }
      if (input.action === 'retry-download') {
        keys(input, ['action', 'id'])
        return active.engine.retryDownload(input.id)
      }
      if (input.action === 'submit') {
        keys(input, ['action', 'input', 'gameId', 'bindToTurn', 'requestId', 'anchor'])
        validateRequestId(input.requestId)
        // Deduplicate before looking at the now-current turn or schema: an uncertain browser retry
        // must return the original job even if the game moved on since it was accepted.
        const existing = (await store.list()).find(job => job.requestId === input.requestId)
        if (existing) return existing
        const description = await active.client.describe(input.input?.model)
        const clean = validateInput(input.input, description)
        if (input.anchor !== undefined && (typeof input.anchor !== 'string' || input.anchor.length > 500)) throw fail('anchor 必须是最多 500 字的正文原句')
        let binding
        const sessionId = exec?.agent?.session?.id
        if (autoInsert && sessionId) {
          exec.signal?.throwIfAborted()
          if (input.gameId && input.gameId !== sessionId) throw fail('game_id 与当前工具调用会话不一致')
          const generation = await ctx.tavern.captureGeneration?.({ gameId: sessionId })
          exec.signal?.throwIfAborted()
          if (!generation?.generationId) throw fail('当前宿主尚未就绪或不是前台正文生成，请重启 Tavern 后再试')
          binding = { ...generation, anchor: input.anchor || '' }
        } else binding = await bindingOf(input)
        return active.engine.submit(clean, { binding, requestId: input.requestId })
      }
      throw fail('未知 RunningHub 操作')
    })
  }
  async function readMedia(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail('仅支持 GET 或 HEAD', 'METHOD_NOT_ALLOWED')
    const query = new URL(req.url, 'http://localhost').searchParams
    const id = validateJobId(query.get('id'))
    const raw = query.get('index')
    if (!/^(?:0|[1-9]\d{0,3})$/.test(raw ?? '')) throw fail('附件索引无效')
    const item = (await store.read(id))?.attachments?.[Number(raw)]
    if (!item?.attachment || !['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp'].includes(item.mediaType)) throw fail('媒体不存在', 'NOT_FOUND')
    let bytes, handle, file
    if (item.kind === 'image') bytes = (await ctx.attachments.readImage(item.attachment)).data
    else {
      // Only host-resolved paths of references actually owned by a persisted job are served.
      file = await ctx.attachments.fileHostPath(item.attachment)
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    }
    try {
      const size = bytes?.byteLength ?? (await handle.stat()).size
      let start = 0, end = size - 1, status = 200
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end() }
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end()
        }
        status = 206
      }
      res.writeHead(status, { 'content-type': item.mediaType, 'content-length': end - start + 1,
        'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
      if (req.method === 'HEAD') return res.end()
      if (bytes) return res.end(bytes.subarray(start, end + 1))
      await pipeline(createReadStream(file, { fd: handle.fd, autoClose: false, start, end }), res)
    } finally { await handle?.close() }
  }
  async function readReferenceRoute(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail('仅支持 GET 或 HEAD', 'METHOD_NOT_ALLOWED')
    const query = new URL(req.url, 'http://localhost').searchParams
    const alias = query.get('model')
    const nodeId = query.get('nodeId')
    if (typeof alias !== 'string' || !alias.trim()) throw fail('缺少 model 参数', 'VALIDATION_ERROR')
    if (typeof nodeId !== 'string' || !nodeId.trim()) throw fail('缺少 nodeId 参数', 'VALIDATION_ERROR')
    const active = await connect()
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.on?.('close', abort)
    // 密钥与网关地址只在服务端持有，绝不经由本路由下发到浏览器。
    let media
    try { media = await active.client.readReference(alias, nodeId, controller.signal) }
    finally { res.off?.('close', abort) }
    const headers = {
      'content-type': media.mediaType,
      'content-length': String(media.data.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end() }
    res.writeHead(200, headers)
    res.end(Buffer.from(media.data))
  }
  async function route(req, res) {
    try {
      if (!sameOrigin(req)) return json(res, 403, { error: '拒绝跨站请求' })
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (pathname === MEDIA) return await readMedia(req, res)
      if (pathname === REFERENCE) return await readReferenceRoute(req, res)
      if (pathname !== API) return json(res, 404, { error: '接口不存在' })
      if (req.method === 'GET') return json(res, 200, await dispatch({ action: 'list' }))
      if (req.method !== 'POST') return json(res, 405, { error: '请求方法不支持' })
      json(res, 200, await dispatch(await bodyJSON(req)))
    } catch (error) {
      const status = { VALIDATION_ERROR: 400, UNSUPPORTED_TYPE: 415, TOO_LARGE: 413, NOT_CONFIGURED: 409, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405 }[error.code] ?? 502
      json(res, status, { error: error instanceof GatewayError ? sanitizeMessage(error.message) : 'RunningHub 宿主操作失败' })
      if (res.headersSent && !res.writableEnded) res.destroy()
    }
  }
  async function resume() {
    return serial(async () => {
      if ((await ctx.credentials.resolve(credentialName(baseURL)))?.value) await connect()
    })
  }
  function dispose() { disposed = true; clearInterval(reconcileTimer); engine?.dispose() }
  reconcileTimer = setInterval(() => { void reconcile().catch(() => {}) }, options.reconcileMs ?? 5000)
  reconcileTimer.unref?.()
  return { dispatch, route, store, resume, dispose, reconcile, get autoInsert() { return autoInsert } }
}

export async function apply(ctx, config = {}) {
  const host = await createRunningHubHost(ctx, config)
  ctx.effect(() => () => host.dispose())
  for (const route of [API, MEDIA, REFERENCE]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler: host.route }))
  ctx.tavern.handle('dsh-runninghub/list', () => host.dispatch({ action: 'list' }))
  ctx.tavern.handle('dsh-runninghub/describe', ({ model }) => host.dispatch({ action: 'describe', model }))
  if (ctx.tavern.onTurnSettled) ctx.tavern.onTurnSettled(() => host.reconcile())
  if (ctx.tavern.promptSection) ctx.tavern.promptSection({ name: 'auto-insert', text: () => host.autoInsert ? [
    'RunningHub 自动插入已开启。仅在玩家要求生成视频时：先构思完整正文并拆成三个分镜，读取 runninghub_describe 后分别调用 runninghub_generate 提交三个任务，再提交正文（开启正文工具时最后调用 submit_story）。',
    '每段使用独立 request_id，重试保持原 ID；可用 anchor 指定该段正文中的原句，成片插在原句之后，省略则附在正文末尾。game_id 可省略，由宿主取得当前会话；bind_to_turn=false 不会阻止此自动插入选项。',
    '只需提交，不等待出片，不循环等待状态；视频后台完成后自动补入本次正文。preparing 仅表示本地受理，不代表远端已接收；不明提交先查询，禁止重新生成。'
  ].join('\n') : '' })
  // Large base64 inputs use the bounded same-origin HTTP route, not the 256KB callHost RPC.
  ctx.inject(['tools'], toolsCtx => {
    const specs = [
      ['runninghub_describe', 'Read imported RunningHub workflow parameters and reference slots before generating. Does not submit a task.',
        { type: 'object', properties: { model: { type: 'string' } }, required: ['model'], additionalProperties: false },
        args => host.dispatch({ action: 'describe', model: args.model })],
      ['runninghub_generate', 'Submit ONE image/video job only when the user asks for generation. Uses the local RunningHub gateway. Read runninghub_describe first. Keep the same request_id on uncertain retries; never automatically regenerate failed/unknown jobs. Returns immediately; query runninghub_status for the downloaded result. Does not rewrite the prompt.',
        { type: 'object', properties: {
          request_id: { type: 'string' }, input: { type: 'object', additionalProperties: true },
          game_id: { type: 'string' }, bind_to_turn: { type: 'boolean' },
          anchor: { type: 'string', description: 'Exact sentence in the forthcoming story; insert video after it. Omit to append below the story.', maxLength: 500 },
        }, required: ['request_id', 'input'], additionalProperties: false },
        (args, exec) => host.dispatch({ action: 'submit', requestId: args.request_id, input: args.input, gameId: args.game_id,
          bindToTurn: args.bind_to_turn ?? false, anchor: args.anchor }, exec)],
      ['runninghub_status', 'Read local RunningHub job history; only queries state, never submits or regenerates.',
        { type: 'object', properties: {}, additionalProperties: false }, () => host.dispatch({ action: 'list' })],
    ]
    for (const [toolName, description, parameters, execute] of specs) toolsCtx.tools.register({
      name: toolName, description, parameters, execute,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    })
  })
  await host.resume()
}
