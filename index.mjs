import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, open, unlink } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { GatewayClient, GatewayError, REFERENCE_LIMIT, sanitizeMessage, splitPortPrompt, validateBaseURL, validateInput, validateRequestId } from './lib/client.mjs'
import { TaskStore, TaskEngine, validateJobId } from './lib/tasks.mjs'
import { ReplayStore } from './lib/replay.mjs'
import {
  PREGEN_FAILURE_COOLDOWN_MS,
  PREGEN_MAX_AGE,
  PREGEN_MAX_COUNT,
  PREGEN_MAX_PER_TURN,
  PREGEN_PLAN_BATCH,
  PREGEN_REVIEW_REASONS,
  buildPlannerPrompt,
  buildPlannerUserMessage,
  expireStaleEntries,
  filterDuplicateVideos,
  livePregenEntries,
  normalizePlanVideos,
  normalizePregenSettings,
  normalizePregenState,
  normalizeRetire,
  parsePlanObject,
  pregenEntryAge,
  pregenNeed,
  pregenStatusText,
  publicPregenState,
  reviewableEntries,
  serializePregenState,
  trimEntries,
} from './lib/pregen.mjs'

export const name = 'dsh-runninghub'
export const inject = ['tavern', 'attachments', 'credentials', 'webServer']
export const API = '/api/dsh-runninghub'
export const MEDIA = API + '/media'
export const REFERENCE = API + '/reference'
// 客户端常用图库 / 常用音频库的同源代理：列表与按 ID 取原图/原音频。
export const LIBRARY = API + '/library'
const DEFAULT_BASE = 'http://127.0.0.1:6888'
const ACTIVE = new Set(['preparing', 'submitting', 'submit_unknown', 'queued', 'running', 'downloading'])
const fail = (message, code = 'VALIDATION_ERROR') => new GatewayError(message, { code, rejected: true })
// 提示词模板直接进入正文提示词：不开 skill、不让模型自己决定读不读。
// Tavern 的 promptSection 单段最多 8000 字，模板通常超过 1.5 万字，因此按段切分注入。
const PROMPT_SECTION_COUNT = 8
const PROMPT_SECTION_LIMIT = 7600
// 自动插入时每回合提交几段视频；默认沿用原来的三个分镜。
const VIDEOS_PER_TURN_DEFAULT = 3
const VIDEOS_PER_TURN_MAX = 10
// H3 全参考模式（Ref2VA / hybrid）必须的六段；缺了 H3 会把参考图当无主体素材。
const REFERENCE_PROMPT_SECTIONS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
]

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function normalizeVideosPerTurn(value) {
  return Number.isInteger(value) && value >= 1 && value <= VIDEOS_PER_TURN_MAX ? value : VIDEOS_PER_TURN_DEFAULT
}
function restoreTags(value) { return typeof value === 'string' ? value.replaceAll('《', '<').replaceAll('》', '>') : value }
/** 按换行切成不超过 limit 的段，避免 Tavern 的 8000 字上限把模板截断。 */
function splitPromptText(text, limit = PROMPT_SECTION_LIMIT) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return []
  const parts = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(' ', limit)
    if (cut < Math.floor(limit / 2)) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}
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
  // 「重新生成」需要可重放的提示词、参数与参考素材；单独落盘，不写进任务记录。
  const replays = new ReplayStore({ directory: path.join(directory, 'replays') })
  await replays.init()
  const settingsFile = path.join(directory, 'connection.json')
  const selectionFile = path.join(directory, 'selection.json')
  let settings
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw fail('RunningHub 连接配置损坏', 'STORE_ERROR') }
  let selection
  try { selection = JSON.parse(await readFile(selectionFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') selection = undefined }
  let baseURL = validateBaseURL(settings?.baseURL ?? config.baseURL ?? DEFAULT_BASE).href.replace(/\/$/, '')
  let autoInsert = settings?.autoInsert === true
  // 默认开启：选中工作流后，插件每轮直接把完整模板发进正文提示词，不再让模型读 Skill。
  let alwaysSendPrompt = settings?.alwaysSendPrompt !== false
  // 自动插入时一回合提交几段视频；提示词按这个数量要求模型拆分镜。
  let videosPerTurn = normalizeVideosPerTurn(settings?.videosPerTurn)
  const linksDirectory = path.join(directory, 'bindings')
  await mkdir(linksDirectory, { recursive: true, mode: 0o700 })
  // 预生成视频池按局保存；文件名用 gameId 的哈希，避免会话编号直接变成路径。
  const pregenDirectory = path.join(directory, 'pregen')
  await mkdir(pregenDirectory, { recursive: true, mode: 0o700 })
  const insertionErrors = new Map()
  const pregenStates = new Map()
  const pregenPlanners = new Map()
  const pregenDirty = new Map()
  const pregenWrites = new Map()
  function clientJobs(jobs) {
    return jobs.map(job => ({ ...job,
      ...(replays.has(job.id) ? { replayable: true } : {}),
      ...(insertionErrors.has(job.id) ? { insertionError: insertionErrors.get(job.id) } : {}) }))
  }
  let reconcileTimer
  let engine, client, clientIdentity, disposed = false, workflows = [], workflowError = ''
  // 工作流由面板决定，模型只写提示词。selectedModel 是玩家显式选中的别名；
  // model 是本次实际生效的别名（选中项失效时回落到网关默认/第一个可用项）。
  let selectedModel = typeof selection?.model === 'string' ? selection.model : ''
  let model = ''
  let defaultModel = ''
  // 面板里的生成行为偏好：和连接配置一起放在 connection.json，刷新/重启后仍生效。
  let applyDefaultsPref = settings?.applyDefaults !== false
  let bindToTurnPref = settings?.bindToTurn !== false
  const promptDirective = { model: '', mode: '', text: '', error: '' }
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
    // A pending binding only has a gameId until the host settles the turn that was
    // being written. onTurnSettled writes the frozen turn/textVersion below; until
    // then there is nowhere to attach yet, and inserting into the previous turn
    // would put the video under the wrong text.
    if (!job.binding?.generationId && !job.binding?.pending) return job.binding
    const file = path.join(linksDirectory, job.id + '.json')
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (job.binding.pending && !job.binding.generationId) return null
    if (typeof ctx.tavern.resolveGeneration !== 'function') return null
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
  // Older task records lost the attachment byte count during sanitizing. Tavern uses
  // it as Content-Length, so a missing count turns the video into an empty 0:00 player.
  // Resolve it from the host-owned file once and reuse it for every reconcile.
  const attachmentSizes = new Map()
  async function attachmentWithBytes(attachment) {
    if (!attachment || typeof attachment.attachmentId !== 'string') return attachment
    if (Number.isSafeInteger(attachment.bytes) && attachment.bytes > 0) return attachment
    if (attachmentSizes.has(attachment.attachmentId)) {
      return { ...attachment, bytes: attachmentSizes.get(attachment.attachmentId) }
    }
    if (typeof ctx.attachments?.fileHostPath !== 'function') return attachment
    try {
      const file = await ctx.attachments.fileHostPath(attachment)
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) return attachment
        attachmentSizes.set(attachment.attachmentId, stat.size)
        return { ...attachment, bytes: stat.size }
      } finally { await handle.close() }
    } catch { return attachment }
  }
  async function insert(job, media, outputIndex = 0, resolutions) {
    const binding = await resolvedBinding(job, resolutions)
    if (!binding?.gameId) return
    const items = await ctx.tavern.list({ gameId: binding.gameId, turn: binding.turn })
    const existing = items.find(item => item.textVersion === binding.textVersion && item.data?.runninghubJob === job.id && item.data?.outputIndex === outputIndex)
    const failed = ['failed', 'submit_unknown', 'download_failed'].includes(job.status)
    const attachment = media?.attachment ? await attachmentWithBytes(media.attachment) : undefined
    const changes = { kind: media?.kind || 'video', status: media ? 'ready' : failed ? 'failed' : 'pending',
      ...(attachment ? { attachment } : {}), error: media ? '' : failed ? job.error || '生成未完成' : '',
      anchor: binding.anchor || '', caption: `RunningHub · ${job.model}` }
    if (existing) {
      const previous = existing.attachment
      const sizeChanged = Boolean(attachment && previous?.attachmentId === attachment.attachmentId
        && Number(previous.bytes) !== attachment.bytes)
      if (existing.status !== 'ready'
        || (attachment && previous?.attachmentId !== attachment.attachmentId)
        || sizeChanged) await ctx.tavern.update(existing.id, changes)
    } else await ctx.tavern.attach({ ...binding, item: { ...changes, data: { runninghubJob: job.id, outputIndex } } })
  }
  async function reconcileJob(job, resolutions) {
    if (!job.binding?.gameId || disposed) return
    return bindingSerial(job, async () => {
      try {
        if (job.attachments?.length) {
          for (let index = 0; index < job.attachments.length; index++) await insert(job, job.attachments[index], index, resolutions)
        } else if (job.binding.generationId || job.binding.pending) await insert(job, undefined, 0, resolutions)
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
    await syncPregenJob(job)
    if (job.binding?.generationId) await reconcile()
    else await reconcileJob(job)
  }
  // 面板轮询与预生成规划会并发 connect；必须串行建引擎，否则后一个调用会
  // dispose 掉前一个刚建好、还在 init 的引擎，正在提交的任务会凭空消失。
  let connectQueue = Promise.resolve()
  function connect() {
    const next = connectQueue.catch(() => {}).then(() => connectOnce())
    connectQueue = next.catch(() => {})
    return next
  }
  async function connectOnce() {
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
  // 工作流自带的提示词模板模式；没有显式绑定就按管线/视频/图片特征回落。
  function templateMode(description) {
    if (typeof description?.defaultEnhanceMode === 'string' && description.defaultEnhanceMode) return description.defaultEnhanceMode
    const pipeline = description?.pipeline
    const imageAlias = pipeline?.imageWorkflowAlias || ''
    if (pipeline?.kind === 'first-frame') return /qwen/i.test(imageAlias) ? 'qwen-h3' : 't2i-h3'
    if (pipeline?.kind === 'grid-storyboard') {
      if (/qwen/i.test(imageAlias)) return /多图/.test(imageAlias) ? 'qwen-multigrid-h3' : 'qwengrid-h3'
      return 'krea2grid-h3'
    }
    if (description?.videoDuration) {
      if (description.alias.includes('参考') || /ref/i.test(description.alias)) return 'h3-ref2va'
      if ((description.referenceSlots || []).some((slot) => /first_frame/i.test(slot.role || ''))) return 'h3-i2va'
      return 'h3-t2va'
    }
    return /qwen/i.test(description?.alias || '') ? 'qwen-image' : 'krea2-image'
  }
  /**
   * 当前工作流实际会附上的默认参考素材：只看没停用的槽位，且槽位在默认值里有素材。
   * tag 就是提示词里的编号（<Picture 1> / <Audio 1>），备注是给模型看的事实。
   */
  function attachedReferences(description, { qwenTags = false } = {}) {
    const byAlias = new Map(workflows.map((item) => [item.alias, item]))
    const references = []
    const addSide = (workflow, side, options = {}) => {
      if (!workflow) return
      const defaults = new Map((workflow.defaults?.references || []).map((asset) => [String(asset.nodeId), asset]))
      for (const slot of workflow.referenceSlots || []) {
        if (slot.bypassed) continue
        if (options.video && options.firstFrame && slot.kind === 'image' && /first_frame/i.test(slot.role || '')) continue
        const asset = defaults.get(String(slot.nodeId))
        if (!asset) continue
        let tag = slot.tag || ''
        if (options.qwenTags) tag = tag.replace(/^<Picture (\d{1,2})>$/, '<image$1>')
        references.push({ side, kind: slot.kind, label: slot.label || slot.nodeId, tag,
          ...(asset.name ? { name: asset.name } : {}), ...(asset.note ? { note: asset.note } : {}) })
      }
    }
    if (description.pipeline) {
      addSide(byAlias.get(description.pipeline.imageWorkflowAlias), '生图', { qwenTags })
      addSide(byAlias.get(description.pipeline.videoWorkflowAlias), '视频', { video: true, firstFrame: description.pipeline.kind === 'first-frame' })
    } else addSide(description, '参考', { qwenTags })
    return references
  }
  /**
   * 全参考模板里「参考图写进 <Subject N> 定义」是必须做的，不是可选项：
   * 网关只在缺标签时补一句 “is referenced from <Picture N>”，补不出主体绑定。
   * 模型一旦按「用户没提到素材」把标签全省了，图就白附了——10/22 20:19 的三单。
   */
  function referencePromptRule(description, mode = description ? templateMode(description) : '') {
    if (!description) return ''
    if (mode !== 'h3-ref2va' && mode !== 'h3-hybrid') return ''
    const items = attachedReferences(description).filter((item) => item.tag)
    if (!items.length) return ''
    const brief = (item) => {
      const detail = [item.name, item.note].filter(Boolean).join('，') || item.label
      const carried = item.kind === 'audio'
        ? '音频内容你听不到，只能按这句说明理解，不要编造具体音色或台词'
        : '图片没有附上，只能按这句说明理解，不要编造图里的细节'
      return `- ${item.tag}：${detail}（${carried}）`
    }
    const audio = items.find((item) => item.kind === 'audio' && /^<Audio \d+>$/.test(item.tag))
    const lines = [
      '用户为这条工作流准备好的参考素材，引用它们时就用下面的标签与编号：',
      ...items.map(brief),
      '写 subject_definitions 时把人/物写进主体定义并引用对应标签，例如：<Subject 1> is the woman in <Picture 1>, 1.7 meters tall, with her facial features, dark hair and fair-skinned figure serving as the visual reference.',
      '不要只把 <Picture N> 单独列成一条，也不能漏：漏了参考图就不参与生成，只写外貌描述不算引用参考图。',
      '外貌、身材等细节只写备注给的信息，备注没说的用标签指代、不要编造。',
    ]
    if (audio) lines.push(`有台词、需要音色时写：${audio.tag} is the voice-timbre reference for <Subject 1>.`)
    return lines.join('\n')
  }
  // 端口指令末尾的「用法说明」是给人看的，模板正文只保留上面给模型的部分。
  function nativeDirectiveText(text, description, mode) {
    const pipeline = Boolean(description?.pipeline)
    // 网关模板是给「只能回文本」的外部 LLM 写的，末尾要求 image### / video### 包裹。
    // 插件是原生工具调用，直接给结构化字段；把这段标记说明从 Skill 里摘掉，避免模型多包一层。
    let body = text
    const section = body.search(/^[ \t]*【输出包裹格式[^】]*】[ \t]*$/m)
    if (section >= 0) body = body.slice(0, section).trim()
    body = body.replace(/再照末尾【输出包裹格式】包上标记/g, '再分别放进工具参数')
    body = body.replace(/两段各自用末尾那节【输出包裹格式】给的标记包起来：[^\n]*/g,
      '把两段提示词分别放进工具参数：生图段 input.image_prompt、视频段 input.prompt，不要包标记。')
    body = body.replace(/[^\n]*【输出包裹格式】[^\n]*(?:\n|$)/g,
      pipeline ? '把两段提示词分别放进 input.image_prompt 与 input.prompt，不要包标记。' : '把提示词直接放进 input.prompt，不要包标记。')
    // 网关模板里「需要出视频时」这类条件会被模型理解成“没要求就不做”，统一改成直接写法。
    body = body.replace(/需要出视频时[，,]?\s*/g, '')
    body = body.replace(/如果需要(?:生成|出)视频[，,]?\s*/g, '')
    body = body.replace(/下面是给「[^」]+」这条工作流写提示词的完整规则。\s*/g, '')
    body = body.replace(/按这些规则写好提示词[，,]\s*再分别放进工具参数。\s*/g, '')
    body = body.replace(/规则里说的「用户的需求」[^。]*。\s*/g, '')
    // 「只引用用户真的提到过的素材」会被模型读成「没提到就不用写」：默认素材明明附上了，
    // 提示词里却一条 <Picture N> 都没有，10/22 20:19 的三单就是这样丢的参考图。
    body = body.replace(/[^\n]*只引用用户真的提到过的素材[^\n]*(?:\n|$)/g,
      '- 这条工作流接的是参考素材，官方上限为 9 张参考图、3 段参考音频。默认素材清单里的标签要按用途写进提示词，清单外的编号不要编——多写不存在的标签会被 H3 节点拒绝。\n')
    const override = pipeline
      ? '生图段放进 input.image_prompt，视频段放进 input.prompt；不要包文本标记。'
      : '提示词直接放进 input.prompt；不要包文本标记。'
    const referenceRule = description ? referencePromptRule(description, mode) : ''
    return [override, referenceRule ? `【参考素材 · 优先级最高】\n${referenceRule}` : '', body.trim()].filter(Boolean).join('\n\n')
  }
  function directiveText(text, description, mode) {
    if (typeof text !== 'string') return ''
    const marker = text.search(/（用法说明[^）]*不用发给\s*LLM/)
    const body = (marker >= 0 ? text.slice(0, marker) : text).trim()
    return description ? nativeDirectiveText(body, description, mode) : body
  }
  /**
   * 端口指令里的素材清单：管线要把生图侧、视频侧的默认素材一起给网关，
   * 否则 qwen-multi-h3 这类模板会因为「一条 <imageN> 都没有」直接 400。
   * 只发标签/备注/名称，不发图片内容。
   */
  function portDirectiveExtras(description) {
    const mode = templateMode(description)
    const qwenTags = /^qwen-multi/.test(mode) || mode === 'qwen-multigrid-h3'
    const references = attachedReferences(description, { qwenTags }).map((item) => ({
      kind: item.kind, label: `${item.side}·${item.label}`,
      ...(item.tag ? { tag: item.tag } : {}), ...(item.note ? { note: item.note } : {}),
    }))
    const extras = {}
    if (references.length) {
      extras.references = references
      extras.mediaLimits = {
        picture: references.filter((item) => item.kind === 'image' && /^<(?:Picture \d+|image\d+)>$/.test(item.tag || '')).length,
        video: 0,
        audio: references.filter((item) => item.kind === 'audio' && /^<Audio \d+>$/.test(item.tag || '')).length,
      }
    }
    const seconds = description.videoDuration?.seconds
    if (Number.isFinite(seconds) && seconds > 0) extras.durationSeconds = seconds
    const aspect = description.videoAspect?.ratio || description.defaults?.resolution?.aspect_ratio
    if (typeof aspect === 'string' && aspect && aspect !== 'auto') extras.aspectRatio = aspect
    return extras
  }
  // 模板要求的参考图不够时，换一份同媒介、但不依赖参考图的模板；只回退这一次，不缓存错误。
  function templateFallbacks(mode) {
    const fallbacks = []
    if (mode === 'qwen-multi-h3') fallbacks.push('qwen-h3')
    if (mode === 'qwen-multigrid-h3') fallbacks.push('qwengrid-h3')
    if (mode === 'qwen-multi') fallbacks.push('qwen-image')
    if (mode === 'krea2-h3') fallbacks.push('t2i-h3')
    if (mode === 'h3-ref2va' || mode === 'h3-hybrid') fallbacks.push('h3-i2va', 'h3-t2va')
    return [...new Set(fallbacks)].filter((item) => item !== mode)
  }
  /**
   * 全参考模式的提示词必须带六段、<Subject N>，并把默认附上的参考图写进提示词。
   * 插件直接走网关端口，绕过了网关 agent 的 validateH3Format；不在这里拦，模型会拿
   * 散文 prompt 直接提交（10/21），或者只写外貌描述、一条 <Picture N> 都不提（10/22）。
   * 网关自己补的 “is referenced from <Picture N>” 没有主体绑定，补不出参考效果。
   * 只在当前模板确实是全参考模板时校验；模板已回退到 i2va/t2va 时不误伤。
   */
  function assertReferencePrompt(prompt, mode, references = []) {
    if (mode !== 'h3-ref2va' && mode !== 'h3-hybrid') return
    const text = typeof prompt === 'string' ? prompt : ''
    const missing = REFERENCE_PROMPT_SECTIONS.filter((name) => !new RegExp(`^[ \\t]*${name}[ \\t]*:`, 'm').test(text))
    if (missing.length) {
      throw fail(`全参考工作流要求六段提示词，当前缺少 ${missing.join('、')}。按已经发来的当前工作流提示词模板重写六段后再提交；不要直接提交散文。`)
    }
    if (!/<Subject\s+\d+>/i.test(text)) {
      throw fail('全参考工作流的正文要用 <Subject N> 指代人物（例如 <Subject 1> is the woman in <Picture 1>）；只写 <Picture N> 会被当成帧锚点。按当前工作流提示词模板重写。')
    }
    const pictures = references.filter((item) => item.kind === 'image' && item.tag)
    const absent = pictures.filter((item) => !text.toLowerCase().includes(item.tag.toLowerCase()))
    if (absent.length) {
      const list = absent.map((item) => `${item.tag}（${[item.name, item.note].filter(Boolean).join('，') || item.label}）`).join('、')
      throw fail(`参考图没有写进提示词：${list} 一条都没出现。全参考工作流必须在 subject_definitions 里把图源写进主体定义，例如 <Subject 1> is the woman in <Picture 1>, ...；只描述外貌不算引用参考图，网关补的“is referenced from”也补不出主体绑定。按模板重写后再提交。`)
    }
  }
  function referencePromptMode(description) {
    const mode = templateMode(description)
    if (mode !== 'h3-ref2va' && mode !== 'h3-hybrid') return ''
    // 模板取不到或已经回退到别的模式时不拦：那是网关侧的降级路径，提示词本来就不按全参考写。
    return promptDirective.model === description.alias && promptDirective.mode === mode ? mode : ''
  }
  async function saveSelection(value) {
    if (value) await atomicJSON(selectionFile, { model: value })
    else await unlink(selectionFile).catch(() => {})
  }
  async function refreshDirective(active, description) {
    if (!description) {
      promptDirective.model = ''; promptDirective.mode = ''; promptDirective.text = ''; promptDirective.error = ''
      return promptDirective
    }
    const mode = templateMode(description)
    const key = [description.alias, description.revision || '', mode].join('|')
    if (promptDirective.key === key) return promptDirective
    const extras = portDirectiveExtras(description)
    let lastError
    for (const candidate of [mode, ...templateFallbacks(mode)]) {
      try {
        const result = await active.client.portDirective(description.alias, candidate, undefined, extras)
        promptDirective.key = key
        promptDirective.model = description.alias
        promptDirective.mode = result.mode || candidate
        promptDirective.text = directiveText(result.text, description, result.mode || candidate)
        promptDirective.error = ''
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        // 只有模板校验失败（400）才换模式；网络/鉴权/404 立即记下，不阻断生成。
        if (!(error instanceof GatewayError) || error.status !== 400) break
      }
    }
    if (lastError) {
      promptDirective.key = key
      promptDirective.model = description.alias
      promptDirective.mode = mode
      promptDirective.text = ''
      promptDirective.error = sanitizeMessage(lastError.message)
    }
    return promptDirective
  }
  // 同一轮并行提交时只拉一次工作流列表：三段视频不该各打一次网关，
  // 也不能让后到的调用看到半空的 workflows 再拉一遍。
  let workflowsLoading = null
  async function ensureModel(active) {
    if (!workflows.length) {
      if (!workflowsLoading) {
        workflowsLoading = active.client.listWorkflows()
          .then(list => { workflows = list; return list })
          .finally(() => { workflowsLoading = null })
      }
      await workflowsLoading
    }
    const usable = workflows.filter((w) => !w.broken)
    let next = ''
    if (selectedModel && usable.some((w) => w.alias === selectedModel)) next = selectedModel
    else {
      if (!defaultModel) {
        try { defaultModel = (await active.client.getSettings()).defaultModel ?? '' }
        catch { defaultModel = '' }
      }
      if (defaultModel && usable.some((w) => w.alias === defaultModel)) next = defaultModel
      else if (usable[0]) next = usable[0].alias
    }
    if (!next) throw fail('请先在 RunningHub 面板选择工作流')
    model = next
    await refreshDirective(active, usable.find((w) => w.alias === next))
    return model
  }
  /* ---------- 预生成视频池 ---------- */

  function pregenGameId(value) {
    if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw fail('游戏 ID 无效')
    return value
  }
  function pregenFile(gameId) {
    return path.join(pregenDirectory, createHash('sha256').update(gameId).digest('hex').slice(0, 40) + '.json')
  }
  async function loadPregen(gameId) {
    const id = pregenGameId(gameId)
    let state = pregenStates.get(id)
    if (state) return state
    try {
      const raw = JSON.parse(await readFile(pregenFile(id), 'utf8'))
      state = normalizePregenState(raw, id)
      if (!state.gameId) state.gameId = id
      if (state.gameId !== id) state = normalizePregenState(undefined, id)
    } catch (error) {
      state = normalizePregenState(undefined, id)
      if (error.code !== 'ENOENT') state.lastError = '预生成池文件损坏，已按空池继续'
    }
    pregenStates.set(id, state)
    return state
  }
  function persistPregen(gameId) {
    const state = pregenStates.get(gameId)
    if (!state) return Promise.resolve()
    const snapshot = serializePregenState(state)
    const previous = pregenWrites.get(gameId) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(() => atomicJSON(pregenFile(gameId), snapshot))
    const tracked = write.catch(() => {})
    pregenWrites.set(gameId, tracked)
    return write.finally(() => { if (pregenWrites.get(gameId) === tracked) pregenWrites.delete(gameId) })
  }
  async function initPregen() {
    let names = []
    try { names = await readdir(pregenDirectory) } catch { return }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await readFile(path.join(pregenDirectory, name), 'utf8'))
        if (!raw || typeof raw.gameId !== 'string' || !raw.gameId) continue
        const state = normalizePregenState(raw, raw.gameId)
        // 服务重启时还在「提交中」但没有任务号的：结果不明，宁可标失败也不重提。
        for (const entry of state.entries) {
          if (entry.status !== 'generating' || entry.jobId) continue
          entry.status = 'failed'
          entry.error = '服务重启时正在提交，结果不明'
          entry.summary = '失败'
        }
        pregenStates.set(raw.gameId, state)
      } catch { /* 单个损坏文件不阻断插件加载 */ }
    }
    // 有任务号的「生成中」在重启后先对一遍本地任务记录，避免提示词把已就绪的条目当成生成中。
    for (const gameId of pregenStates.keys()) {
      try { await reconcilePregen(gameId) } catch { /* 网关/宿主暂时不可用不阻断插件加载 */ }
    }
  }

  function applyJobToPregenEntry(entry, job) {
    if (!entry || !['generating', 'failed'].includes(entry.status)) return false
    const attachments = (Array.isArray(job.attachments) ? job.attachments : []).map(item => {
      if (!item || typeof item !== 'object' || !['video', 'image', 'audio'].includes(item.kind)) return undefined
      const saved = { kind: item.kind }
      for (const key of ['name', 'mediaType', 'url']) if (typeof item[key] === 'string' && item[key]) saved[key] = item[key]
      if (item.attachment && typeof item.attachment === 'object' && typeof item.attachment.attachmentId === 'string') saved.attachment = item.attachment
      return saved
    }).filter(Boolean)
    if (attachments.length) entry.attachments = attachments
    if (Number.isFinite(job.progress)) entry.progress = job.progress
    if (job.status === 'ready') {
      if (attachments.some(item => item.kind === 'video')) {
        entry.status = 'ready'
        entry.summary = '就绪'
        delete entry.error
        delete entry.progress
      } else {
        entry.status = 'failed'
        entry.summary = '失败'
        entry.error = '任务成功但没有视频产物'
      }
    } else if (['failed', 'download_failed', 'submit_unknown'].includes(job.status)) {
      entry.status = 'failed'
      entry.summary = '失败'
      entry.error = job.error || (job.status === 'submit_unknown' ? '提交结果未知，需要人工核对' : '生成失败')
      delete entry.progress
    } else {
      entry.summary = { preparing: '提交中…', submitting: '提交中…', queued: '排队中', running: '生成中', downloading: '下载中' }[job.status]
        || pregenStatusText(job.status)
    }
    return true
  }

  async function syncPregenJob(job) {
    if (!job?.id) return false
    for (const [gameId, state] of pregenStates) {
      const entry = state.entries.find(item => item.jobId === job.id)
      if (!entry || !['generating', 'failed'].includes(entry.status)) continue
      if (!applyJobToPregenEntry(entry, job)) return false
      trimEntries(state)
      await persistPregen(gameId).catch(() => {})
      return true
    }
    return false
  }

  async function attachPregenItem({ gameId, turn, textVersion, item, entryId }) {
    // 落盘与 attach 之间失败重试时，先看这一版是否已经挂过同一条池子视频，避免重复。
    if (typeof ctx.tavern.list === 'function') {
      try {
        const items = await ctx.tavern.list({ gameId, turn })
        if (Array.isArray(items) && items.some(existing => existing.textVersion === textVersion && existing.data?.runninghubPregen === entryId)) return false
      } catch { /* list 不可用时直接尝试 attach */ }
    }
    await ctx.tavern.attach({ gameId, turn, textVersion, item })
    return true
  }

  async function flushPregenSends(gameId, existing, settledTurn) {
    const state = existing ?? await loadPregen(gameId)
    if (!state.sends?.length) return false
    let changed = false
    for (const send of [...state.sends]) {
      const entry = state.entries.find(item => item.id === send.entryId)
      if (!entry) {
        state.sends = state.sends.filter(item => item !== send)
        changed = true
        continue
      }
      const video = entry.attachments?.find(item => item.kind === 'video' && item.attachment)
      if (!video) {
        entry.status = 'failed'
        entry.summary = '失败'
        entry.error = '没有可发送的视频产物'
        state.sends = state.sends.filter(item => item !== send)
        changed = true
        continue
      }
      let binding = null
      if (send.pending && !send.generationId) {
        // 等到了提交时那一轮结算：直接挂上它的正文版本。
        const after = Number.isInteger(send.afterTurn) ? send.afterTurn : 0
        if (settledTurn?.gameId === gameId && Number.isInteger(settledTurn.turn) && settledTurn.turn > after
          && typeof settledTurn.textVersion === 'string' && settledTurn.textVersion) {
          binding = { turn: settledTurn.turn, textVersion: settledTurn.textVersion }
        }
      } else if (typeof ctx.tavern.resolveGeneration === 'function' && typeof ctx.tavern.attach === 'function') {
        try { binding = await ctx.tavern.resolveGeneration({ gameId, generationId: send.generationId }) }
        catch { binding = null }
      }
      // 正文还在写、或还没有可落位的版本：留到下一次对账再试；超过十分钟多半是回退/重写了，还回池子。
      if (!binding) {
        const created = Date.parse(send.createdAt || '')
        if (Number.isFinite(created) && Date.now() - created > 10 * 60 * 1000) {
          entry.status = 'ready'
          entry.summary = '就绪'
          entry.error = '正文版本已失效，视频已退回池子'
          state.sends = state.sends.filter(item => item !== send)
          changed = true
        }
        continue
      }
      try {
        const attachment = await attachmentWithBytes(video.attachment)
        await attachPregenItem({
          gameId,
          turn: binding.turn,
          textVersion: binding.textVersion,
          entryId: entry.id,
          item: {
            kind: 'video',
            status: 'ready',
            attachment,
            ...(send.anchor ? { anchor: send.anchor } : {}),
            caption: send.caption || `RunningHub · ${entry.description}`,
            data: { runninghubPregen: entry.id },
          },
        })
        entry.status = 'used'
        entry.usedAt = new Date().toISOString()
        entry.usedTurn = binding.turn
        entry.summary = '已发送'
        delete entry.error
      } catch (error) {
        // 落位失败就把这条还回池子，玩家还可以手动再发；不重复挂同一版。
        entry.status = 'ready'
        entry.summary = '就绪'
        entry.error = '发送落位失败：' + sanitizeMessage(error.message)
      }
      state.sends = state.sends.filter(item => item !== send)
      changed = true
    }
    if (changed) await persistPregen(gameId).catch(() => {})
    return changed
  }

  async function reconcilePregen(gameId) {
    const state = await loadPregen(gameId)
    let changed = false
    for (const entry of state.entries) {
      if (entry.status !== 'generating') continue
      if (entry.submitting) continue
      if (!entry.jobId) {
        entry.status = 'failed'
        entry.summary = '失败'
        entry.error = '服务重启时正在提交，结果不明'
        changed = true
        continue
      }
      let job = null
      try { job = await store.read(entry.jobId) } catch { job = null }
      if (!job) {
        entry.status = 'failed'
        entry.summary = '失败'
        entry.error = '本地任务记录不存在'
        changed = true
        continue
      }
      if (applyJobToPregenEntry(entry, job)) changed = true
    }
    if (changed) { trimEntries(state); await persistPregen(gameId).catch(() => {}) }
    await flushPregenSends(gameId, state)
    return state
  }

  async function pregenTurnInfo(gameId) {
    try {
      const value = await ctx.tavern.getTurnState?.({ gameId })
      if (value && Number.isInteger(value.turn)) return value
    } catch { /* 旧宿主没有 getTurnState */ }
    const state = await loadPregen(gameId)
    return { turn: state.lastTurn ?? 0, settled: Boolean(state.lastTurn), generating: false, busy: false }
  }

  async function pregenHistory(gameId, turn, currentText) {
    const rows = []
    if (turn > 0 && typeof ctx.tavern.getHistory === 'function') {
      try {
        const items = await ctx.tavern.getHistory({ gameId, from: Math.max(1, turn - 5), to: turn })
        if (Array.isArray(items)) rows.push(...items)
      } catch { /* 旧宿主没有历史接口 */ }
    }
    if (turn > 0 && !rows.some(item => item.turn === turn) && typeof ctx.tavern.getTurn === 'function') {
      try {
        const item = await ctx.tavern.getTurn({ gameId, turn })
        if (item) rows.push({ turn, input: '', text: item.text })
      } catch { /* 还没写完 */ }
    }
    if (turn > 0 && !rows.some(item => item.turn === turn) && currentText) rows.push({ turn, input: '', text: currentText })
    return rows.slice(-6).map(item => {
      const text = String(item.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 700)
      const input = String(item.input ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return `第 ${item.turn ?? '?'} 轮${input ? `\n玩家：${input}` : ''}\n正文：${text || '（空）'}`
    }).join('\n\n')
  }

  async function pregenCard(gameId, turn) {
    if (typeof ctx.tavern.getCardContext === 'function') {
      try {
        const card = await ctx.tavern.getCardContext({ gameId, turn })
        if (card) {
          const lore = (Array.isArray(card.lore) ? card.lore : []).slice(0, 6)
            .map(item => `【${item.title || '设定'}】${String(item.content ?? '').slice(0, 300)}`).join('\n')
          return [
            card.description && `人物卡：${card.description}`,
            card.personality && `性格：${card.personality}`,
            card.scenario && `情境：${card.scenario}`,
            lore,
          ].filter(Boolean).join('\n').slice(0, 4000)
        }
      } catch { /* 旧宿主没有 getCardContext */ }
    }
    if (typeof ctx.tavern.getCard === 'function') {
      try {
        const card = await ctx.tavern.getCard({ gameId })
        if (card) return [card.name, card.description, card.personality, card.scenario].filter(Boolean).join('\n').slice(0, 4000)
      } catch { /* 没有卡就按剧情来 */ }
    }
    return ''
  }

  function pregenLLM() {
    try {
      const scoped = options.getLLM?.()
      if (scoped) return scoped
    } catch { /* 服务还没注入 */ }
    return options.llm ?? ctx.llm ?? null
  }

  async function callPregenPlanner({ gameId, system, user, signal }) {
    const llm = pregenLLM()
    if (!llm || typeof llm.stream !== 'function') throw fail('DSH 没有可用的 llm 服务，无法规划视频', 'NOT_CONFIGURED')
    let selected = null
    if (typeof options.backgroundModel === 'function') selected = await options.backgroundModel({ gameId })
    else if (typeof ctx.tavern.backgroundModel === 'function') selected = await ctx.tavern.backgroundModel({ gameId })
    if (!selected?.provider || !selected?.model) throw fail('Tavern 没有配置后台模型，无法规划视频', 'NOT_CONFIGURED')
    signal?.throwIfAborted()
    let output = ''
    let failure = ''
    const chunks = llm.stream({
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      system,
      temperature: 0.9,
      maxTokens: 12000,
      signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user ?? '') }] }],
    })
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason?.failure?.message || '规划调用失败'
    }
    signal?.throwIfAborted()
    if (failure && !output.trim()) throw fail(failure, 'GATEWAY_ERROR')
    if (!output.trim()) throw fail('规划模型没有返回内容', 'GATEWAY_ERROR')
    return output.trim()
  }

  function preparePregenVideo(video, alias, description) {
    const split = splitPortPrompt(video.prompt, description.pipeline?.kind || '')
    assertReferencePrompt(split.prompt, referencePromptMode(description), attachedReferences(description))
    const prepared = { model: alias, prompt: split.prompt, apply_defaults: true }
    if (split.imagePrompt) {
      const imagePromptKey = description.pipeline?.kind === 'grid-storyboard' ? 'grid_prompt' : 'image_prompt'
      prepared.custom = { [imagePromptKey]: split.imagePrompt }
    }
    return validateInput(prepared, description)
  }

  async function submitPregenVideo({ gameId, state, active, alias, description, video, turn, clean }) {
    const id = 'pg-' + randomUUID().replace(/-/g, '').slice(0, 8)
    const entry = {
      id,
      status: 'generating',
      description: video.description,
      argPrompt: video.prompt,
      args: clean,
      createdAt: new Date().toISOString(),
      createdTurn: Number.isInteger(turn) && turn > 0 ? turn : 0,
      workflow: alias,
      summary: '提交中…',
      requestId: 'pregen:' + id,
      submitting: true,
    }
    state.entries.push(entry)
    await persistPregen(gameId)
    try {
      const job = await active.engine.submit(clean, { requestId: entry.requestId })
      try { await replays.save(job.id, clean) } catch { /* 预生成任务不强制可重放 */ }
      delete entry.submitting
      entry.jobId = job.id
      entry.submittedAt = new Date().toISOString()
      applyJobToPregenEntry(entry, job)
      await persistPregen(gameId)
      return entry
    } catch (error) {
      delete entry.submitting
      entry.status = 'failed'
      entry.summary = '失败'
      entry.error = sanitizeMessage(error.message)
      await persistPregen(gameId).catch(() => {})
      throw error
    }
  }

  async function runPregenPlan({ gameId, state, handle, reason, turn, currentText, review, need }) {
    const active = await connect()
    const alias = await ensureModel(active)
    if (promptDirective.model !== alias || !promptDirective.text) {
      throw fail('当前工作流没有可用的提示词模板，预生成没有提交', 'NOT_CONFIGURED')
    }
    const description = await active.client.describe(alias)
    const [history, card] = await Promise.all([pregenHistory(gameId, turn, currentText), pregenCard(gameId, turn)])
    const live = livePregenEntries(state)
    const reviewEntries = review.filter(entry => entry.status === 'ready')
    const budget = handle.budget
    const maxNew = Math.max(0, Math.min(PREGEN_PLAN_BATCH, need + reviewEntries.length, budget))
    if (maxNew <= 0 && !reviewEntries.length) return
    const system = buildPlannerPrompt({ alias, template: promptDirective.text })
    const user = buildPlannerUserMessage({
      history, card,
      existing: live.map(entry => ({ description: entry.description, status: entry.status, age: pregenEntryAge(entry, turn) })),
      review: reviewEntries.map(entry => ({ id: entry.id, description: entry.description, age: pregenEntryAge(entry, turn) })),
      need, maxNew, target: state.settings.count, turn,
      reviewOn: PREGEN_REVIEW_REASONS.has(reason) && state.settings.review !== false,
      maxAge: state.settings.maxAge,
    })
    let text = await callPregenPlanner({ gameId, system, user, signal: handle.controller.signal })
    let parsed = parsePlanObject(text)
    let videos = normalizePlanVideos(parsed?.videos, maxNew)
    let retired = normalizeRetire(parsed?.retire, reviewEntries)
    // 模型偶尔只回文字 / 空清单：池子还差时再问一次，仍不行就留给下一轮。
    if (!videos.length && maxNew > 0 && !retired.length) {
      const retryUser = `${user}\n\n[系统提醒] 上一次没有给出可解析的 videos。请严格只输出 JSON，按上面要求的数量写。`
      text = await callPregenPlanner({ gameId, system, user: retryUser, signal: handle.controller.signal })
      parsed = parsePlanObject(text)
      videos = normalizePlanVideos(parsed?.videos, maxNew)
      retired = normalizeRetire(parsed?.retire, reviewEntries)
    }
    if (handle.controller.signal.aborted) throw new Error('规划已取消')
    let changed = false
    for (const item of retired) {
      if (item.entry.status !== 'ready') continue
      item.entry.status = 'stale'
      item.entry.staleAt = new Date().toISOString()
      item.entry.staleReason = 'planner'
      item.entry.staleNote = item.reason
      changed = true
    }
    if (changed) await persistPregen(gameId).catch(() => {})
    const retiredIds = new Set(retired.map(item => item.entry.id))
    const prompts = live.filter(entry => !retiredIds.has(entry.id)).map(entry => entry.argPrompt).filter(Boolean)
    videos = filterDuplicateVideos(videos, prompts)
    const room = Math.max(0, state.settings.count - livePregenEntries(state).length)
    videos = videos.slice(0, Math.min(PREGEN_PLAN_BATCH, room, Math.max(0, budget)))
    if (!videos.length) {
      if (need > 0 && !retired.length) state.lastError = '规划器没有给出可用的视频'
      else if (retired.length || !need) delete state.lastError
      await persistPregen(gameId).catch(() => {})
      return
    }
    // 先过本地校验；整批都没过时把校验原文还给规划器重写一次（模板/管线格式最常见的错）。
    let preparedVideos = []
    const rejected = []
    for (const video of videos) {
      try { preparedVideos.push({ video, clean: preparePregenVideo(video, alias, description) }) }
      catch (error) { rejected.push({ video, detail: sanitizeMessage(error.message) }) }
    }
    if (!preparedVideos.length && rejected.length) {
      handle.controller.signal.throwIfAborted()
      const feedback = rejected.map((item, index) => `${index + 1}. 描述：${item.video.description}\n   校验：${item.detail}`).join('\n')
      const retryUser = `${user}\n\n[系统提醒] 下面这些提示词没有通过本地校验：\n${feedback}\n请按校验说明重写这几条，只输出 JSON（videos），不要解释。`
      const retryText = await callPregenPlanner({ gameId, system, user: retryUser, signal: handle.controller.signal })
      const retryVideos = filterDuplicateVideos(normalizePlanVideos(parsePlanObject(retryText)?.videos, videos.length), prompts)
      for (const video of retryVideos) {
        try { preparedVideos.push({ video, clean: preparePregenVideo(video, alias, description) }) }
        catch (error) { rejected.push({ video, detail: sanitizeMessage(error.message) }) }
      }
    }
    let submitted = 0
    for (const prepared of preparedVideos) {
      if (handle.controller.signal.aborted) break
      try {
        await submitPregenVideo({ gameId, state, active, alias, description, video: prepared.video, turn, clean: prepared.clean })
        submitted += 1
      } catch (error) {
        state.lastError = '提交预生成视频失败：' + sanitizeMessage(error.message)
      }
    }
    if (!submitted && rejected.length) state.lastError = '规划出的提示词没有通过校验：' + rejected[0].detail
    handle.budget = Math.max(0, handle.budget - submitted)
    if (submitted > 0) delete state.lastError
    trimEntries(state)
    await persistPregen(gameId).catch(() => {})
    // 目标比一批大时，这一轮再续一批（最多三批），剩下的下一轮补。
    if (submitted > 0 && handle.batches < 3 && pregenNeed(state) > 0 && handle.budget > 0 && !handle.dirty) {
      handle.batches += 1
      handle.dirty = true
      handle.dirtyReason = 'refill'
    }
  }

  async function planPregen(gameId, reason = 'turn', current = {}) {
    if (disposed) return null
    const state = await loadPregen(gameId)
    if (state.settings.count <= 0) return null
    if (pregenPlanners.has(gameId)) {
      pregenDirty.set(gameId, reason)
      return { planning: true }
    }
    const now = new Date().toISOString()
    if (reason !== 'manual' && state.lastError && state.lastAttemptAt
      && Date.now() - Date.parse(state.lastAttemptAt) < PREGEN_FAILURE_COOLDOWN_MS) {
      return { cooldown: true }
    }
    const info = Number.isInteger(current.turn) ? current : await pregenTurnInfo(gameId)
    const turn = Number.isInteger(info?.turn) && info.turn > 0 ? info.turn : (state.lastTurn ?? 0)
    const expired = expireStaleEntries(state, turn, now)
    if (expired.length) await persistPregen(gameId).catch(() => {})
    const reviewOn = PREGEN_REVIEW_REASONS.has(reason) && state.settings.review !== false
    const review = reviewOn ? reviewableEntries(state, turn) : []
    const need = pregenNeed(state)
    if (need <= 0 && !review.length) return { need: 0 }
    const budget = reason === 'manual' || state.settings.perTurn <= 0 ? Number.POSITIVE_INFINITY : state.settings.perTurn
    if (budget <= 0) return null
    const handle = { controller: new AbortController(), dirty: false, dirtyReason: reason, budget, batches: 1, startedAt: now }
    pregenPlanners.set(gameId, handle)
    state.planning = {
      startedAt: now,
      need: Math.min(need, Number.isFinite(budget) ? budget : need),
      ...(review.length ? { review: review.length } : {}),
    }
    await persistPregen(gameId).catch(() => {})
    void (async () => {
      try {
        await runPregenPlan({ gameId, state, handle, reason, turn, currentText: current.text, review, need })
      } catch (error) {
        if (!handle.controller.signal.aborted && !disposed) state.lastError = sanitizeMessage(error.message)
      } finally {
        delete state.planning
        state.lastAttemptAt = new Date().toISOString()
        trimEntries(state)
        await persistPregen(gameId).catch(() => {})
        if (pregenPlanners.get(gameId) === handle) pregenPlanners.delete(gameId)
        if (handle.controller.signal.aborted) pregenDirty.delete(gameId)
        const dirty = pregenDirty.get(gameId)
        pregenDirty.delete(gameId)
        if (dirty && !disposed && !handle.controller.signal.aborted) {
          void planPregen(gameId, dirty === 'manual' ? 'turn' : dirty).catch(() => {})
        }
      }
    })()
    return { planning: true }
  }

  async function pregenSettings(input) {
    keys(input, ['action', 'gameId', 'count', 'perTurn', 'maxAge', 'review'])
    const gameId = pregenGameId(input.gameId)
    const state = await loadPregen(gameId)
    const next = { ...state.settings }
    if (input.count !== undefined) {
      if (!Number.isInteger(input.count) || input.count < 0 || input.count > PREGEN_MAX_COUNT) throw fail(`预生成数量必须是 0–${PREGEN_MAX_COUNT} 的整数`)
      next.count = input.count
    }
    if (input.perTurn !== undefined) {
      if (!Number.isInteger(input.perTurn) || input.perTurn < 0 || input.perTurn > PREGEN_MAX_PER_TURN) throw fail(`每轮最多预生成数量必须是 0–${PREGEN_MAX_PER_TURN} 的整数`)
      next.perTurn = input.perTurn
    }
    if (input.maxAge !== undefined) {
      if (!Number.isInteger(input.maxAge) || input.maxAge < 0 || input.maxAge > PREGEN_MAX_AGE) throw fail(`自动退出轮数必须是 0–${PREGEN_MAX_AGE} 的整数`)
      next.maxAge = input.maxAge
    }
    if (input.review !== undefined) {
      if (typeof input.review !== 'boolean') throw fail('每轮复审必须是布尔值')
      next.review = input.review
    }
    state.settings = normalizePregenSettings(next)
    if (state.settings.count <= 0) {
      const planner = pregenPlanners.get(gameId)
      if (planner) planner.controller.abort()
      pregenDirty.delete(gameId)
      delete state.planning
    }
    await persistPregen(gameId)
    if (state.settings.count > 0) void planPregen(gameId, 'settings').catch(() => {})
    return { pregen: publicPregenState(state) }
  }

  async function pregenRefill(input) {
    keys(input, ['action', 'gameId'])
    const gameId = pregenGameId(input.gameId)
    const state = await reconcilePregen(gameId)
    if (state.settings.count <= 0) throw fail('先把预生成数量设为大于 0')
    const result = await planPregen(gameId, 'manual')
    return { pregen: publicPregenState(state), ...(result?.cooldown ? { cooldown: true } : {}) }
  }

  async function pregenDelete(input) {
    keys(input, ['action', 'gameId', 'id'])
    const gameId = pregenGameId(input.gameId)
    const state = await loadPregen(gameId)
    const entry = state.entries.find(item => item.id === input.id)
    if (!entry) throw fail('池子里没有这条视频', 'NOT_FOUND')
    const generating = entry.status === 'generating'
    entry.status = 'discarded'
    entry.summary = generating ? '已删除（后台任务结果会被忽略）' : '已删除'
    delete entry.error
    state.sends = (state.sends ?? []).filter(item => item.entryId !== entry.id)
    await persistPregen(gameId)
    return { pregen: publicPregenState(state) }
  }

  async function sendPregen({ gameId, id, anchor, caption, allowStale = true }) {
    const state = await loadPregen(gameId)
    const entry = state.entries.find(item => item.id === id)
    if (!entry) throw fail('池子里没有这条视频', 'NOT_FOUND')
    if (entry.status === 'stale' && !allowStale) throw fail('这条视频已经退出池子，不能再由模型发送')
    if (!['ready', 'stale'].includes(entry.status)) {
      throw fail(entry.status === 'used' ? '这条视频已经发过了' : entry.status === 'generating' ? '这条视频还在生成中' : '这条视频不能发送')
    }
    if (anchor !== undefined && (typeof anchor !== 'string' || anchor.length > 500)) throw fail('anchor 必须是最多 500 字的正文原句')
    if (caption !== undefined && (typeof caption !== 'string' || caption.length > 500)) throw fail('caption 必须是最多 500 字')
    const video = entry.attachments?.find(item => item.kind === 'video' && item.attachment)
    if (!video) throw fail('这条视频还没有可发送的产物')
    const item = {
      kind: 'video',
      status: 'ready',
      attachment: await attachmentWithBytes(video.attachment),
      ...(anchor ? { anchor } : {}),
      caption: caption || `RunningHub · ${entry.description}`,
      data: { runninghubPregen: entry.id },
    }
    const info = await pregenTurnInfo(gameId)
    let queued = false
    // 正在写、或刚开始结算：优先挂到这次生成上，等正文版本确定后落位。
    const canCapture = typeof ctx.tavern.captureGeneration === 'function'
    const generation = !info.settled && canCapture ? await ctx.tavern.captureGeneration({ gameId }) : null
    if (generation?.generationId) {
      state.sends = state.sends ?? []
      state.sends.push({
        entryId: entry.id,
        generationId: generation.generationId,
        ...(anchor ? { anchor } : {}),
        ...(caption ? { caption } : {}),
        createdAt: new Date().toISOString(),
      })
      queued = true
    } else if (!info.settled && !canCapture && typeof ctx.tavern.onTurnSettled === 'function' && typeof ctx.tavern.attach === 'function') {
      // 旧宿主没有生成身份接口：等这一轮结算的 onTurnSettled 再挂，不能猜上一轮。
      const afterTurn = Number.isInteger(info.turn) ? Math.max(0, info.turn - 1) : 0
      state.sends = state.sends ?? []
      state.sends.push({
        entryId: entry.id,
        pending: true,
        afterTurn,
        ...(anchor ? { anchor } : {}),
        ...(caption ? { caption } : {}),
        createdAt: new Date().toISOString(),
      })
      queued = true
    } else if (info.settled && Number.isInteger(info.turn) && info.turn > 0) {
      const turn = await ctx.tavern.getTurn({ gameId, turn: info.turn })
      if (!turn) throw fail('当前正文还没写完，请稍后再发送')
      await attachPregenItem({ gameId, turn: turn.turn, textVersion: turn.textVersion, item, entryId: entry.id })
    } else {
      throw fail(canCapture && !info.settled
        ? '当前不是前台正文生成，不能把视频绑到正文；请等正文生成时再发送'
        : '当前没有可发送的正文轮次')
    }
    entry.status = 'used'
    entry.usedAt = new Date().toISOString()
    entry.summary = queued ? '已发送（等本轮写完落位）' : '已发送'
    delete entry.error
    await persistPregen(gameId)
    return {
      sent: true,
      queued,
      pool_id: entry.id,
      description: entry.description,
      pregen: publicPregenState(state),
      ...(queued ? { note: '视频会在本轮正文写完、版本确定后自动补入。' } : {}),
    }
  }

  // 没有生成身份接口的宿主：把提交期间还没结算的自动插入任务，绑到这一轮
  // 刚写完的正文版本上。写文件和插入都排在该任务自己的 bindingSerial 里，
  // 避免和下载完成后的 bindMedia 抢同一个落位文件。
  async function resolvePendingBindings(value) {
    if (typeof value?.gameId !== 'string' || !Number.isInteger(value.turn) || value.turn < 1
      || typeof value.textVersion !== 'string' || !value.textVersion) return false
    let changed = false
    for (const job of await store.list()) {
      if (!job.binding?.pending || job.binding.generationId || job.binding.gameId !== value.gameId) continue
      const after = Number.isInteger(job.binding.afterTurn) ? job.binding.afterTurn : 0
      if (value.turn <= after) continue
      try {
        const written = await bindingSerial(job, async () => {
          const file = path.join(linksDirectory, job.id + '.json')
          try { await readFile(file); return false }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          await atomicJSON(file, {
            gameId: value.gameId, turn: value.turn, textVersion: value.textVersion,
            anchor: job.binding.anchor || '',
          })
          return true
        })
        if (written) changed = true
      } catch (error) { insertionErrors.set(job.id, sanitizeMessage(error.message)) }
    }
    return changed
  }

  async function handleTurn(value = {}) {
    if (disposed) return
    if (await resolvePendingBindings(value)) await reconcile()
    const gameId = pregenGameId(value.gameId)
    // 不依赖 onChange 一定送达：每轮先把任务状态对一遍，再补过期与发送落位。
    try { await reconcilePregen(gameId) } catch { /* 池子出错不阻断正文 */ }
    const state = await loadPregen(gameId)
    const turn = Number.isInteger(value.turn) ? value.turn : (state.lastTurn ?? 0)
    state.lastTurn = Math.max(state.lastTurn ?? 0, turn)
    const shouldPersist = state.settings.count > 0 || state.entries.length > 0 || state.sends?.length > 0
    if (shouldPersist) {
      expireStaleEntries(state, turn, new Date().toISOString())
      await persistPregen(gameId).catch(() => {})
    }
    await flushPregenSends(gameId, state, value).catch(() => {})
    if (state.settings.count > 0) await planPregen(gameId, 'turn', { turn, text: value.text })
  }

  function pregenPromptText(gameId) {
    if (typeof gameId !== 'string' || !gameId) return ''
    const state = pregenStates.get(gameId)
    if (!state) return ''
    const count = state.settings.count
    const live = livePregenEntries(state)
    if (count <= 0 && !live.length) return ''
    const lines = ['## 预生成视频池（后台按剧情预先出好的备用视频；发送不花积分、立刻到）']
    if (!live.length) {
      lines.push(`（池子暂时是空的${count > 0 ? `，目标 ${count} 段，后台会补` : ''}。）`)
    } else {
      live.slice(0, 20).forEach((entry, index) => {
        lines.push(`- #${index + 1} [${entry.status === 'ready' ? '就绪' : '生成中'}] ${entry.description}${entry.status === 'ready' ? `（pool_id: ${entry.id}）` : '（还不能发）'}`)
      })
    }
    lines.push('发视频前先看这里：有一条与当前剧情、人物状态、衣着、地点相符的，就调用 runninghub_send_pregenerated（pool_id 填它的 id；可用 anchor 指定插在哪句正文之后）；没有贴合的就照常调用 runninghub_generate。不要为了用池子改剧情，不要把不符的硬发；一条只能发一次，生成中的暂时不能发。用掉的后台会自动补。')
    return lines.join('\n')
  }

  async function removePregenGame(gameId) {
    const id = pregenGameId(gameId)
    const planner = pregenPlanners.get(id)
    if (planner) planner.controller.abort()
    pregenPlanners.delete(id)
    pregenStates.delete(id)
    await unlink(pregenFile(id)).catch(() => {})
  }

  async function summary(gameId) {
    let configured = Boolean((await ctx.credentials.resolve(credentialName(baseURL)))?.value)
    let settingsError = ''
    if (!configured) {
      model = ''; workflows = []; promptDirective.model = ''; promptDirective.text = ''; promptDirective.error = ''
    }
    if (configured) {
      try {
        const active = await connect()
        workflows = await active.client.listWorkflows()
        workflowError = ''
        // 默认模型取服务端默认；获取失败不让工作流列表丢失，单独记录同步错误。
        try {
          if (typeof active.client.getSettings === 'function') {
            defaultModel = (await active.client.getSettings())?.defaultModel ?? ''
          }
        } catch (error) { settingsError = sanitizeMessage(error.message) }
        const usable = workflows.filter((w) => !w.broken)
        if (selectedModel && usable.some((w) => w.alias === selectedModel)) model = selectedModel
        else if (defaultModel && usable.some((w) => w.alias === defaultModel)) model = defaultModel
        else if (usable[0]) model = usable[0].alias
        else model = ''
        // 显式选择已失效：清掉，回到网关默认，避免面板一直指着一个不存在的工作流。
        if (selectedModel && model !== selectedModel) {
          selectedModel = ''
          await saveSelection('')
        }
        if (model) await refreshDirective(active, usable.find((w) => w.alias === model))
      }
      catch (error) { workflowError = sanitizeMessage(error.message) }
    }
    await reconcile()
    const directive = promptDirective.model === model ? promptDirective : null
    let pregen
    if (typeof gameId === 'string' && gameId) {
      try {
        const state = await reconcilePregen(gameId)
        pregen = publicPregenState(state)
      } catch (error) {
        pregen = { ...publicPregenState(normalizePregenState(undefined, gameId)), lastError: sanitizeMessage(error.message) }
      }
    }
    return { configured, baseURL, autoInsert, alwaysSendPrompt, videosPerTurn,
      applyDefaults: applyDefaultsPref, bindToTurn: bindToTurnPref,
      workflowSettings: true,
      adapter: 'gateway', model, defaultModel, jobs: clientJobs(await store.list()), workflows,
      ...(pregen ? { pregen } : {}),
      ...(directive ? { templateMode: directive.mode, ...(directive.error ? { templateError: directive.error } : {}) } : {}),
      ...(workflowError ? { gatewayError: workflowError } : {}), ...(settingsError ? { settingsError } : {}) }
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
    await atomicJSON(settingsFile, { baseURL: nextBase, autoInsert, alwaysSendPrompt, videosPerTurn, applyDefaults: applyDefaultsPref, bindToTurn: bindToTurnPref })
    engine?.dispose(); engine = undefined; client = undefined; clientIdentity = undefined
    baseURL = nextBase; workflows = []; workflowError = ''
    selectedModel = ''; model = ''; defaultModel = ''
    promptDirective.key = ''; promptDirective.model = ''; promptDirective.mode = ''; promptDirective.text = ''; promptDirective.error = ''
    await saveSelection('')
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
  // 自动插入优先绑定「生成 attempt」：视频要等正文写完才落位，仅凭当前轮次不够。
  // 旧宿主没有 captureGeneration 时退回结算绑定：正文正在写就等这一轮结算
  // （onTurnSettled 再写死 turn/textVersion），已经结算则直接绑当前轮。
  async function autoInsertBinding(gameId, anchor = '') {
    if (typeof ctx.tavern.captureGeneration === 'function') {
      const generation = await ctx.tavern.captureGeneration({ gameId })
      if (!generation?.generationId) {
        throw fail('当前不是前台正文生成（生成候选或后台任务不能自动插入），请关闭自动插入后重试')
      }
      return { ...generation, anchor }
    }
    if (typeof ctx.tavern.onTurnSettled !== 'function' || typeof ctx.tavern.attach !== 'function') {
      throw fail('当前 Tavern 宿主不支持自动插入，请更新 DSH Tavern 或关闭自动插入')
    }
    let state
    try { state = await ctx.tavern.getTurnState?.({ gameId }) } catch { state = null }
    if (state && !state.busy && state.settled && Number.isInteger(state.turn) && state.turn > 0) {
      try {
        const turn = await ctx.tavern.getTurn({ gameId, turn: state.turn })
        if (turn && turn.textVersion === state.textVersion) {
          return { gameId, turn: turn.turn, textVersion: turn.textVersion, anchor }
        }
      } catch { /* 读不到这一轮就按未结算处理 */ }
    }
    let afterTurn = 0
    if (state && Number.isInteger(state.turn)) {
      // 正在写时，state.turn 可能已经是这一轮（占位正文已存在），也可能是上一轮；
      // 能读到就说明它已经结算，只需等更晚的轮次。
      let readable = null
      if (state.busy) {
        try { readable = await ctx.tavern.getTurn({ gameId, turn: state.turn }) } catch { readable = null }
      }
      afterTurn = readable ? state.turn : Math.max(0, state.turn - (state.busy ? 1 : 0))
    }
    return { gameId, pending: true, afterTurn, anchor }
  }
  async function dispatch(input = { action: 'list' }, exec) {
    if (!object(input)) throw fail('请求格式无效')
    if (disposed) throw fail('插件已停止', 'DISPOSED')
    // 提交不进全局串行锁：校验、describe 往返和绑定都要等网关或宿主，
    // 同一轮的三段视频不该一段一段排队，面板轮询也不该追在它们后面。
    if (input.action === 'submit') return submitJob(input, exec)
    return serial(async () => {
      if (input.action === 'preferences') {
        keys(input, ['action', 'autoInsert', 'alwaysSendPrompt', 'videosPerTurn', 'applyDefaults', 'bindToTurn'])
        if (input.autoInsert === undefined && input.alwaysSendPrompt === undefined
          && input.videosPerTurn === undefined
          && input.applyDefaults === undefined && input.bindToTurn === undefined) throw fail('没有要保存的偏好')
        for (const key of ['autoInsert', 'alwaysSendPrompt', 'applyDefaults', 'bindToTurn']) {
          if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail(key + ' 必须是布尔值')
        }
        if (input.videosPerTurn !== undefined
          && (!Number.isInteger(input.videosPerTurn) || input.videosPerTurn < 1 || input.videosPerTurn > VIDEOS_PER_TURN_MAX)) {
          throw fail(`每回合视频段数必须是 1–${VIDEOS_PER_TURN_MAX} 的整数`)
        }
        const next = {
          autoInsert: input.autoInsert === undefined ? autoInsert : input.autoInsert,
          alwaysSendPrompt: input.alwaysSendPrompt === undefined ? alwaysSendPrompt : input.alwaysSendPrompt,
          videosPerTurn: input.videosPerTurn === undefined ? videosPerTurn : input.videosPerTurn,
          applyDefaults: input.applyDefaults === undefined ? applyDefaultsPref : input.applyDefaults,
          bindToTurn: input.bindToTurn === undefined ? bindToTurnPref : input.bindToTurn,
        }
        await atomicJSON(settingsFile, { baseURL, ...next })
        autoInsert = next.autoInsert
        alwaysSendPrompt = next.alwaysSendPrompt
        videosPerTurn = next.videosPerTurn
        applyDefaultsPref = next.applyDefaults
        bindToTurnPref = next.bindToTurn
        return next
      }
      if (input.action === 'configure') return configure(input)
      if (input.action === 'list') { keys(input, ['action', 'gameId']); return summary(input.gameId) }
      // 输入框停靠区的轻量轮询：只读本地任务记录，不连网关、不列工作流。
      // 工具提交后几秒内就能显示「生成中」，不用等正文这一轮结算。
      if (input.action === 'jobs') {
        keys(input, ['action', 'gameId'])
        if (input.gameId !== undefined && (typeof input.gameId !== 'string' || !input.gameId)) throw fail('gameId 必须是当前对话 ID')
        const all = await store.list()
        return { jobs: clientJobs(input.gameId ? all.filter(job => job.binding?.gameId === input.gameId) : all) }
      }
      if (input.action === 'pregen-settings') return pregenSettings(input)
      if (input.action === 'pregen-refill') return pregenRefill(input)
      if (input.action === 'pregen-delete') return pregenDelete(input)
      if (input.action === 'pregen-send') {
        keys(input, ['action', 'gameId', 'id', 'anchor', 'caption', 'allowStale'])
        if (input.allowStale !== undefined && typeof input.allowStale !== 'boolean') throw fail('allowStale 必须是布尔值')
        exec?.signal?.throwIfAborted()
        const gameId = pregenGameId(input.gameId)
        if (typeof input.id !== 'string' || !input.id) throw fail('缺少预生成视频 id')
        const result = await sendPregen({ gameId, id: input.id, anchor: input.anchor, caption: input.caption,
          allowStale: input.allowStale !== false })
        exec?.signal?.throwIfAborted()
        return result
      }
      const active = await connect()
      if (input.action === 'regenerate') {
        keys(input, ['action', 'id', 'requestId', 'gameId', 'bindToTurn'])
        const id = validateJobId(input.id)
        validateRequestId(input.requestId)
        // 先按 requestId 去重：浏览器结果不明时重试不能变成第二个收费任务。
        const existing = (await store.list()).find(job => job.requestId === input.requestId)
        if (existing) return { ...existing, ...(replays.has(existing.id) ? { replayable: true } : {}) }
        const original = await store.read(id)
        if (!original) throw fail('本地任务不存在', 'NOT_FOUND')
        if (!['ready', 'failed', 'download_failed'].includes(original.status)) {
          throw fail('只有已结束的任务可以重新生成；结果未知的任务请先核对')
        }
        let replay
        try { replay = await replays.load(id) }
        catch (error) { throw fail(error instanceof GatewayError ? sanitizeMessage(error.message) : '可重放输入读取失败') }
        if (!replay) throw fail('该任务没有保存可重放的输入；可能是旧版本提交的任务', 'NOT_FOUND')
        let description
        try { description = await active.client.describe(replay.model) }
        catch (error) { throw new GatewayError('原工作流当前不可用，无法重新生成：' + sanitizeMessage(error.message), { code: 'GATEWAY_ERROR' }) }
        let clean
        try { clean = validateInput(replay, description) }
        catch (error) { throw fail('原任务参数已不适用于当前工作流：' + sanitizeMessage(error.message)) }
        const binding = await bindingOf({ bindToTurn: input.bindToTurn, gameId: input.gameId })
        const job = await active.engine.submit(clean, { binding, requestId: input.requestId })
        try { await replays.save(job.id, clean); job.replayable = true } catch { /* 任务已提交，快照失败只影响下次重放 */ }
        return job
      }
      if (input.action === 'select-model') {
        keys(input, ['action', 'model'])
        if (typeof input.model !== 'string' || !input.model.trim()) throw fail('工作流别名不能为空')
        workflows = await active.client.listWorkflows()
        const target = workflows.find((w) => w.alias === input.model && !w.broken)
        if (!target) throw fail('未找到工作流别名')
        selectedModel = target.alias
        model = target.alias
        await saveSelection(target.alias)
        await refreshDirective(active, target)
        return { model, templateMode: promptDirective.mode,
          ...(promptDirective.error ? { templateError: promptDirective.error } : {}) }
      }
      if (input.action === 'describe') {
        keys(input, ['action', 'model'])
        const alias = await ensureModel(active)
        if (input.model !== undefined && input.model !== alias) throw fail('工作流由面板选择，不能在此指定其他工作流')
        const description = await active.client.describe(alias)
        const templateReady = promptDirective.model === alias && Boolean(promptDirective.text)
        return { ...description,
          promptTemplateReady: templateReady,
          promptTemplateEnabled: alwaysSendPrompt,
          promptTemplateSent: alwaysSendPrompt && templateReady,
          ...(promptDirective.mode ? { promptMode: promptDirective.mode } : {}) }
      }
      if (input.action === 'status') {
        keys(input, ['action'])
        const alias = await ensureModel(active)
        return { model: alias, jobs: clientJobs(await store.list()) }
      }
      if (input.action === 'option-groups') {
        keys(input, ['action'])
        return { groups: await active.client.getOptionGroups() }
      }
      if (input.action === 'save-settings') {
        keys(input, ['action', 'model', 'defaults', 'duration', 'seeds', 'modelFields', 'referenceSlots'])
        const alias = await ensureModel(active)
        if (input.model !== undefined && input.model !== alias) throw fail('工作流由面板选择，不能在此指定其他工作流')
        const current = await active.client.describe(alias)
        if (input.defaults !== undefined) {
          if (!object(input.defaults)) throw fail('defaults 必须是对象')
          const references = input.defaults.references
          if (references !== undefined && references !== null) {
            if (!Array.isArray(references) || references.length > 64) throw fail('参考素材最多 64 项')
            let total = 0
            for (const reference of references) {
              if (!object(reference)) throw fail('参考素材项无效')
              if (typeof reference.data === 'string') {
                const bytes = Math.ceil(reference.data.length * 3 / 4)
                if (bytes > 10 * 1024 * 1024) throw fail('参考素材单张不能超过 10MB')
                total += bytes
              }
            }
            if (total > 25 * 1024 * 1024) throw fail('参考素材总大小不能超过 25MB')
          }
        }
        if (input.duration !== undefined && (!object(input.duration)
          || input.duration.seconds !== null && typeof input.duration.seconds !== 'number')) throw fail('片长设置无效')
        const lists = { seeds: ['target', 'value'], modelFields: ['target', 'value', 'groupId'], referenceSlots: ['nodeId', 'enabled'] }
        for (const [key, allowed] of Object.entries(lists)) {
          if (input[key] === undefined) continue
          if (!Array.isArray(input[key]) || input[key].length > 64) throw fail(key + ' 设置无效')
          for (const item of input[key]) {
            if (!object(item) || Object.keys(item).some(entry => !allowed.includes(entry))) throw fail(key + ' 设置无效')
          }
        }
        if ([input.defaults, input.duration, input.seeds, input.modelFields, input.referenceSlots].every(value => value === undefined)) {
          throw fail('没有要保存的设置')
        }
        try {
          // 先开关槽位再存素材：刚启用的旁路槽才能接收这一轮的默认图。
          if (input.referenceSlots !== undefined) {
            for (const slot of input.referenceSlots) await active.client.setReferenceSlot(alias, slot.nodeId, slot.enabled)
          }
          if (input.defaults !== undefined) {
            const defaults = { ...input.defaults }
            if (defaults.baseUpdatedAt === undefined && current.defaults?.updatedAt) defaults.baseUpdatedAt = current.defaults.updatedAt
            await active.client.saveDefaults(alias, defaults)
          }
          if (input.duration !== undefined) {
            await active.client.saveDuration(alias, current.primarySite, input.duration.seconds === undefined ? null : input.duration.seconds)
          }
          if (input.seeds !== undefined) {
            for (const seed of input.seeds) await active.client.saveSeed(alias, current.primarySite, seed.target, seed.value === undefined ? null : seed.value)
          }
          if (input.modelFields !== undefined) {
            for (const field of input.modelFields) {
              const patch = {}
              if (field.value !== undefined) patch.value = field.value
              if (field.groupId !== undefined) patch.groupId = field.groupId
              await active.client.saveModelField(alias, current.primarySite, field.target, patch)
            }
          }
        } catch (error) {
          if (error instanceof GatewayError && error.status === 409) {
            throw new GatewayError('网关设置已在别处更新，请重新载入后再保存', { code: 'CONFLICT', status: 409, rejected: true })
          }
          throw error
        }
        let workflow
        try { workflow = await active.client.describe(alias) } catch { workflow = undefined }
        if (workflow) workflows = workflows.map(item => item.alias === alias ? workflow : item)
        return { model: alias, ...(workflow ? { workflow } : {}) }
      }
      if (input.action === 'retry-download') {
        keys(input, ['action', 'id'])
        return active.engine.retryDownload(input.id)
      }
      throw fail('未知 RunningHub 操作')
    })
  }
  /**
   * 提交一段视频。慢的部分都在锁外：网关的 describe 往返和宿主绑定可以并行，
   * 同一轮的多段视频才能真正一起发出去。只有「查重 + 建任务」这一小段进
   * 全局串行锁，保证同一个 requestId 只落一条任务、只收一次费。
   */
  async function submitJob(input, exec) {
    keys(input, ['action', 'input', 'gameId', 'bindToTurn', 'requestId', 'anchor'])
    validateRequestId(input.requestId)
    // Deduplicate before looking at the now-current turn or schema: an uncertain browser retry
    // must return the original job even if the game moved on since it was accepted.
    const existing = (await store.list()).find(job => job.requestId === input.requestId)
    if (existing) return { ...existing, ...(replays.has(existing.id) ? { replayable: true } : {}) }
    if (exec && !alwaysSendPrompt) {
      throw fail('插件设置里「总是发送提示词模板」已关闭，模型生成拿不到当前工作流模板。请在面板设置里开启，或用面板手动生成。')
    }
    // 自动插入关闭时，模型不能自行提交；由宿主直接拒绝，不把判断交给模型。
    if (exec && !autoInsert) {
      throw fail('自动插入已关闭，模型不能提交 RunningHub 视频；请玩家在面板手动生成，或在设置里开启自动插入。')
    }
    if (!object(input.input)) throw fail('input 必须是对象')
    const active = await connect()
    const alias = await ensureModel(active)
    // 工作流是宿主状态：模型即使还传了旧字段也不能改选，避免把面板选择绕过去。
    if (input.input.model !== undefined && input.input.model !== alias) throw fail('工作流由面板选择，不能在工具参数里指定')
    if (input.input.custom !== undefined && !object(input.input.custom)) throw fail('custom 必须是对象')
    const description = await active.client.describe(alias)
    const pipelineKind = description.pipeline?.kind || ''
    if (input.input.image_prompt !== undefined && typeof input.input.image_prompt !== 'string') throw fail('image_prompt 必须是文本')
    const structuredImage = typeof input.input.image_prompt === 'string' ? input.input.image_prompt.trim() : ''
    let prompt = input.input.prompt
    let imagePrompt = ''
    if (pipelineKind) {
      // 原生工具优先用 input.image_prompt + input.prompt；旧模板的 image### / video### 只作兼容回退。
      try {
        const split = splitPortPrompt(input.input.prompt, pipelineKind)
        prompt = split.prompt
        imagePrompt = split.imagePrompt
      } catch (error) {
        if (!structuredImage) throw error
        const videoOnly = /(?:^|\r?\n)[ \t]*video###[ \t]*(?:\r?\n)?([\s\S]*?)[ \t]*(?:\r?\n)?[ \t]*###/.exec(input.input.prompt || '')
        prompt = videoOnly ? videoOnly[1].trim() : input.input.prompt
      }
      if (structuredImage) imagePrompt = structuredImage
      if (!imagePrompt) throw fail('管线工作流需要两段提示词：input.image_prompt + input.prompt（或 image### / video### 标记）')
    } else if (structuredImage) {
      throw fail('当前工作流不是管线，不需要 input.image_prompt')
    }
    prompt = restoreTags(prompt)
    imagePrompt = restoreTags(imagePrompt)
    // 面板手动提交允许自由散文（玩家可能只想快速试参数）；模型走工具提交时
    // 必须按全参考模板写，缺段在花钱之前拦住。工具调用一定带 exec，面板走 route 不带。
    if (exec) assertReferencePrompt(prompt, referencePromptMode(description), attachedReferences(description))
    const prepared = { ...input.input, model: alias, prompt }
    delete prepared.image_prompt
    if (pipelineKind && imagePrompt) {
      const imagePromptKey = pipelineKind === 'grid-storyboard' ? 'grid_prompt' : 'image_prompt'
      prepared.custom = { ...(object(input.input.custom) ? input.input.custom : {}), [imagePromptKey]: imagePrompt }
    }
    const clean = validateInput(prepared, description)
    if (input.anchor !== undefined && (typeof input.anchor !== 'string' || input.anchor.length > 500)) throw fail('anchor 必须是最多 500 字的正文原句')
    let binding
    const sessionId = exec?.agent?.session?.id
    if (autoInsert && sessionId) {
      exec.signal?.throwIfAborted()
      if (input.gameId && input.gameId !== sessionId) throw fail('game_id 与当前工具调用会话不一致')
      binding = await autoInsertBinding(sessionId, input.anchor || '')
      exec.signal?.throwIfAborted()
    } else binding = await bindingOf(input)
    // 短临界区：并发提交时 describe 已经并行做完，这里只串行「再查一次重 + 建任务」，
    // 同一个 requestId 的第二次提交拿回第一条任务，不会变成第二个收费任务。
    const job = await serial(async () => {
      const raced = (await store.list()).find(item => item.requestId === input.requestId)
      if (raced) return { ...raced, ...(replays.has(raced.id) ? { replayable: true } : {}) }
      return active.engine.submit(clean, { binding, requestId: input.requestId })
    })
    try { await replays.save(job.id, clean); job.replayable = true } catch { /* 任务已提交，快照失败只影响下次重放 */ }
    return job
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
  async function libraryRoute(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail('仅支持 GET 或 HEAD', 'METHOD_NOT_ALLOWED')
    const query = new URL(req.url, 'http://localhost').searchParams
    const kind = query.get('kind')
    if (kind !== 'image' && kind !== 'audio') throw fail('kind 必须是 image 或 audio')
    const id = query.get('id')
    const active = await connect()
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.on?.('close', abort)
    try {
      if (!id) {
        const items = await active.client.listLibrary(kind, controller.signal)
        const body = Buffer.from(JSON.stringify({ kind, items, maxBytes: REFERENCE_LIMIT }))
        const headers = {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') return res.end()
        return res.end(body)
      }
      const media = await active.client.readLibrary(kind, id, controller.signal)
      const headers = {
        'content-type': media.mediaType,
        'content-length': String(media.data.byteLength),
        // 素材 ID 对应不可变文件；只允许浏览器私有缓存，避免中间层留存客户端素材。
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      }
      if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end() }
      res.writeHead(200, headers)
      res.end(Buffer.from(media.data))
    } finally { res.off?.('close', abort) }
  }
  async function route(req, res) {
    try {
      if (!sameOrigin(req)) return json(res, 403, { error: '拒绝跨站请求' })
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (pathname === MEDIA) return await readMedia(req, res)
      if (pathname === REFERENCE) return await readReferenceRoute(req, res)
      if (pathname === LIBRARY) return await libraryRoute(req, res)
      if (pathname !== API) return json(res, 404, { error: '接口不存在' })
      if (req.method === 'GET') {
        const gameId = new URL(req.url, 'http://localhost').searchParams.get('gameId') || undefined
        return json(res, 200, await dispatch({ action: 'list', ...(gameId ? { gameId } : {}) }))
      }
      if (req.method !== 'POST') return json(res, 405, { error: '请求方法不支持' })
      json(res, 200, await dispatch(await bodyJSON(req)))
    } catch (error) {
      const status = { VALIDATION_ERROR: 400, UNSUPPORTED_TYPE: 415, TOO_LARGE: 413, NOT_CONFIGURED: 409, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, CONFLICT: 409 }[error.code] ?? 502
      json(res, status, { error: error instanceof GatewayError ? sanitizeMessage(error.message) : 'RunningHub 宿主操作失败' })
      if (res.headersSent && !res.writableEnded) res.destroy()
    }
  }
  async function resume() {
    return serial(async () => {
      if (!(await ctx.credentials.resolve(credentialName(baseURL)))?.value) return
      const active = await connect()
      // 预热当前工作流的提示词模板，插件加载后第一轮就能直接发送。
      try { await ensureModel(active) } catch { /* 网关暂时不可用不阻断插件加载 */ }
    })
  }
  // 模型不需要选工作流，也不需要读 Skill：这里把「面板当前选中的工作流 +
  // 它的完整提示词模板」直接拼进正文提示词。开关关掉时整段都不发。
  // 预生成池与自动插入相互独立：自动插入关掉时，池子里的就绪视频仍然可以发。
  function promptText(gameId) {
    if (!alwaysSendPrompt) return ''
    const parts = []
    if (!model) {
      if (autoInsert) parts.push('本回合还没有选择 RunningHub 工作流，不要调用 runninghub_generate；正文照常写。')
    } else if (promptDirective.model !== model || !promptDirective.text) {
      parts.push(`当前工作流的提示词模板不可用${promptDirective.error ? '（' + promptDirective.error + '）' : ''}，本回合不要调用 runninghub_generate；正文照常写。`)
    } else {
      if (autoInsert) {
        parts.push(`本回合生成 ${videosPerTurn} 段视频。严格按顺序：1) 先在思考里定稿完整的本轮正文，从上一轮结束后的下一个动作开始，不要重播上一轮已经写过的画面；2) 只从这份本轮正文里挑 ${videosPerTurn} 个最精彩的瞬间写视频提示词，上一轮和历史正文不能作为本轮视频内容；3) 每条视频的 anchor 必须逐字引用本轮正文里的原句；4) 在同一条回复里先调用 runninghub_generate 提交 ${videosPerTurn} 段（不要多也不要少），紧接着在同一条回复里调用 submit_story，把同一份完整正文放进 content；submit_story 必须是这条回复的最后一个工具调用。不要只提交视频、等工具结果再补正文——那样正文会丢，视频也白生成；anchor 只是定位句，不能代替正文。`)
      }
      parts.push(promptDirective.text)
      if (promptDirective.mode === 'h3-ref2va' || promptDirective.mode === 'h3-hybrid') {
        parts.push('提示词按顺序带六段：subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music；人物用 <Subject 1> 定义、正文用 <Subject 1> 指代，<Picture 1> 要写进主体定义，不能单独成条也不能漏。')
      }
      if (autoInsert) {
        parts.push([
          'runninghub_generate：prompt 放视频段；管线工作流把生图段放 image_prompt。不要包 image### / video### 标记，不要传 model；每段用独立 request_id。',
          '工具报格式错误就按提示改一次；仍失败就只提交正文，不要中断本轮。',
          'anchor 填正文原句可把视频插在它后面，省略则附在正文末尾。提交后立即返回，不要轮询等待。',
        ].join('\n\n'))
      }
    }
    const pool = pregenPromptText(gameId)
    if (pool) parts.push(pool)
    return parts.join('\n\n')
  }
  // Tavern 的 promptSection 单段最多 8000 字：完整模板按段切开，保持顺序注册。
  function promptSections(gameId) {
    return splitPromptText(promptText(gameId))
  }
  // 每回合一条短提醒，放在本轮上下文里，避免长系统提示词里的自动插入要求被忽略。
  function turnReminder(input = '') {
    if (!alwaysSendPrompt || !autoInsert || !model) return ''
    if (promptDirective.model !== model || !promptDirective.text) return ''
    const lead = typeof input === 'string' && input.trim() ? `本轮玩家指引：${input.trim().slice(0, 500)}。` : ''
    return `【RunningHub】${lead}先按这条指引定稿本轮正文，再从正文里挑 ${videosPerTurn} 个瞬间写视频提示词（anchor 用正文原句）；然后在同一条回复里调用 runninghub_generate 提交 ${videosPerTurn} 段，并紧接着调用 submit_story 提交完整正文（最后一个工具调用）。不要等工具结果再补正文，也不要用上一轮画面。`
  }
  function dispose() {
    disposed = true
    clearInterval(reconcileTimer)
    for (const handle of pregenPlanners.values()) handle.controller.abort()
    pregenPlanners.clear()
    engine?.dispose()
  }
  reconcileTimer = setInterval(() => { void reconcile().catch(() => {}) }, options.reconcileMs ?? 5000)
  reconcileTimer.unref?.()
  await initPregen()
  return { dispatch, route, store, replays, resume, dispose, reconcile, promptText, promptSections, turnReminder, handleTurn,
    removeGame: removePregenGame, get autoInsert() { return autoInsert }, get alwaysSendPrompt() { return alwaysSendPrompt },
    get videosPerTurn() { return videosPerTurn } }
}

export async function apply(ctx, config = {}) {
  const runtime = { llm: null }
  const host = await createRunningHubHost(ctx, config, { getLLM: () => runtime.llm })
  ctx.effect(() => () => host.dispose())
  for (const route of [API, MEDIA, REFERENCE, LIBRARY]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler: host.route }))
  ctx.tavern.handle('dsh-runninghub/list', () => host.dispatch({ action: 'list' }))
  ctx.tavern.handle('dsh-runninghub/describe', ({ model }) => host.dispatch({ action: 'describe', model }))
  if (ctx.tavern.onTurnSettled) ctx.tavern.onTurnSettled(async turn => {
    await host.reconcile()
    await host.handleTurn(turn)
  })
  if (ctx.tavern.onGameRemoved) ctx.tavern.onGameRemoved(({ gameId }) => host.removeGame(gameId))
  // 每个 promptSection 最多 8000 字。模板直接注入，不再写 Tavern Skill、不让模型多一步读取。
  // 名称固定补零，保证 Tavern 按名字排序时片段顺序就是模板顺序。
  if (ctx.tavern.promptSection) {
    for (let index = 0; index < PROMPT_SECTION_COUNT; index += 1) {
      const name = index === 0 ? 'auto-insert' : 'auto-insert-' + String(index).padStart(2, '0')
      ctx.tavern.promptSection({ name, text: context => host.promptSections(context?.gameId)[index] || '' })
    }
  }
  if (ctx.tavern.turnSection) {
    ctx.tavern.turnSection({ name: 'auto-insert-reminder', text: context => host.turnReminder(context?.input) })
  }
  // 预生成规划用 DSH 的 llm 服务 + 这局的后台模型；拿不到时池子会显示明确错误，不影响其它功能。
  ctx.inject(['llm'], scoped => { runtime.llm = scoped.llm })
  // Large base64 inputs use the bounded same-origin HTTP route, not the 256KB callHost RPC.
  ctx.inject(['tools'], toolsCtx => {
    const specs = [
      ['runninghub_describe', 'Read the panel-selected workflow parameters and reference slots. Does not submit or change the selection.',
        { type: 'object', properties: { model: { type: 'string', description: 'Omit; kept only for compatibility. The panel selection wins.' } }, additionalProperties: false },
        args => host.dispatch({ action: 'describe', ...(args.model ? { model: args.model } : {}) })],
      ['runninghub_generate', 'Submit ONE image/video job for the panel-selected workflow. input.prompt = video prompt; for a pipeline input.image_prompt = image prompt. No image### / video### fences. Keep the same request_id on uncertain retries; never automatically regenerate. When auto-insert is on, submit every video and then call submit_story in the SAME reply (it must be the last tool call); do not wait for these results before submitting the story.',
        { type: 'object', properties: {
          request_id: { type: 'string' },
          input: { type: 'object', properties: {
            prompt: { type: 'string', description: 'Video/main prompt. Plain text, no video### fence. For a single-stage workflow this is the only prompt.' },
            image_prompt: { type: 'string', description: 'Image-side prompt for a pipeline (first-frame or grid). Plain text, no image### fence. Omit for single-stage workflows.' },
            custom: { type: 'object', additionalProperties: true },
            resolution: { type: 'object', additionalProperties: true },
            references: { type: 'array', items: { type: 'object', additionalProperties: true } },
            duration_seconds: { type: 'number' },
            apply_defaults: { type: 'boolean' },
          }, required: ['prompt'], additionalProperties: true },
          game_id: { type: 'string' }, bind_to_turn: { type: 'boolean' },
          anchor: { type: 'string', description: 'Exact sentence in the forthcoming story; insert video after it. Omit to append below the story.', maxLength: 500 },
        }, required: ['request_id', 'input'], additionalProperties: false },
        (args, exec) => host.dispatch({ action: 'submit', requestId: args.request_id, input: args.input, gameId: args.game_id,
          bindToTurn: args.bind_to_turn ?? false, anchor: args.anchor }, exec)],
      ['runninghub_status', 'Read local RunningHub job history for the selected workflow; only queries state, never submits or regenerates.',
        { type: 'object', properties: {}, additionalProperties: false }, () => host.dispatch({ action: 'status' })],
      ['runninghub_send_pregenerated', 'Send one ready video from the RunningHub pre-generation pool into the current story reply. Use it only when a pool entry matches the current scene, characters, clothing and location; it costs no credits and is available immediately. If the pool has no match, use runninghub_generate instead. Each pool entry can be sent only once; generating entries cannot be sent yet.',
        { type: 'object', properties: {
          pool_id: { type: 'string', description: 'pool_id listed under the RunningHub pre-generation pool (pg-xxxxxxxx).' },
          anchor: { type: 'string', description: 'Exact sentence in the forthcoming story; insert the video after it. Omit to append below the story.', maxLength: 500 },
          caption: { type: 'string', description: 'Optional caption shown with the video.', maxLength: 500 },
        }, required: ['pool_id'], additionalProperties: false },
        (args, exec) => host.dispatch({ action: 'pregen-send', gameId: exec?.agent?.session?.id, id: args.pool_id,
          anchor: args.anchor, caption: args.caption, allowStale: false }, exec).then(({ pregen: _pregen, ...result }) => result)],
    ]
    // 这几个工具都只把任务写进本地库就返回，慢的是网关往返而不是生成本身。
    // 声明并发安全后，宿主会把同一轮的多段提交一起发出去，正文提交不用等它们
    // 一段一段跑完。发送预生成视频仍然独占：它要把池子里的条目认领给这一次生成。
    const concurrencySafe = new Set(['runninghub_describe', 'runninghub_generate', 'runninghub_status'])
    for (const [toolName, description, parameters, execute] of specs) toolsCtx.tools.register({
      name: toolName, description, parameters, execute,
      isConcurrencySafe: () => concurrencySafe.has(toolName),
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    })
  })
  await host.resume()
}
