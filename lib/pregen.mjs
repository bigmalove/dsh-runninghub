// 预生成视频池：纯数据与提示词逻辑，不碰网络、文件或 Tavern。
//
// 池子按局保存在宿主的数据目录里，由 index.mjs 的后台规划器维护：
// 每轮结束按最近剧情预判接下来最可能出现的画面，写好成品提示词后提交到 RunningHub，
// 就绪的备用视频列进正文提示词，模型用 runninghub_send_pregenerated 直接发（不花积分）。

export const PREGEN_STATUSES = ['generating', 'ready', 'failed', 'used', 'discarded', 'stale']
export const PREGEN_LIVE_STATUSES = ['generating', 'ready']
export const PREGEN_MAX_COUNT = 20
export const PREGEN_MAX_PER_TURN = 20
export const PREGEN_DEFAULT_MAX_AGE = 6
export const PREGEN_MAX_AGE = 99
export const PREGEN_MAX_DESCRIPTION = 120
export const PREGEN_MAX_PROMPT = 12000
export const PREGEN_PLAN_BATCH = 6
export const PREGEN_KEEP_INACTIVE = 20
export const PREGEN_DUPLICATE_SIMILARITY = 0.6
export const PREGEN_FAILURE_COOLDOWN_MS = 10 * 60 * 1000
export const PREGEN_REVIEW_REASONS = new Set(['turn', 'manual'])

const STATUS_TEXT = {
  generating: '生成中',
  ready: '就绪',
  failed: '失败',
  used: '已用',
  discarded: '已删',
  stale: '已退',
}

export function pregenStatusText(status) {
  return STATUS_TEXT[status] || String(status || '')
}

export function defaultPregenSettings() {
  return { count: 0, perTurn: 0, maxAge: PREGEN_DEFAULT_MAX_AGE, review: true }
}

/** 只接受界面能表达的范围；不合法时回落到默认值，不抛错。 */
export function normalizePregenSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const count = Number.isInteger(source.count) && source.count >= 0 && source.count <= PREGEN_MAX_COUNT
    ? source.count : 0
  const perTurn = Number.isInteger(source.perTurn) && source.perTurn >= 0 && source.perTurn <= PREGEN_MAX_PER_TURN
    ? source.perTurn : 0
  const maxAge = Number.isInteger(source.maxAge) && source.maxAge >= 0 && source.maxAge <= PREGEN_MAX_AGE
    ? source.maxAge : PREGEN_DEFAULT_MAX_AGE
  return { count, perTurn, maxAge, review: source.review !== false }
}

function clipText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function attachmentOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = ['video', 'image', 'audio'].includes(raw.kind) ? raw.kind : undefined
  if (!kind) return undefined
  const result = { kind }
  for (const key of ['name', 'mediaType', 'url']) {
    if (typeof raw[key] === 'string' && raw[key]) result[key] = raw[key]
  }
  // attachment 是发送时交给 Tavern 的引用；只在宿主落盘里保留，不发给浏览器。
  if (raw.attachment && typeof raw.attachment === 'object' && typeof raw.attachment.attachmentId === 'string') {
    const ref = { attachmentId: raw.attachment.attachmentId }
    for (const key of ['name', 'mediaType']) if (typeof raw.attachment[key] === 'string' && raw.attachment[key]) ref[key] = raw.attachment[key]
    if (Number.isFinite(raw.attachment.bytes)) ref.bytes = raw.attachment.bytes
    result.attachment = ref
  }
  return result
}

function publicAttachment(raw) {
  const { attachment: _attachment, ...rest } = raw
  return rest
}

function publicEntry(entry) {
  return {
    id: entry.id,
    status: entry.status,
    description: entry.description,
    ...(entry.workflow ? { workflow: entry.workflow } : {}),
    createdAt: entry.createdAt,
    createdTurn: entry.createdTurn,
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(Number.isFinite(entry.progress) ? { progress: entry.progress } : {}),
    ...(entry.attachments?.length ? { attachments: entry.attachments.map(publicAttachment) } : {}),
    ...(entry.staleNote ? { staleNote: entry.staleNote } : {}),
    ...(entry.usedAt ? { usedAt: entry.usedAt } : {}),
    ...(entry.usedTurn ? { usedTurn: entry.usedTurn } : {}),
  }
}

/** 读盘后的状态：丢掉不认识的字段；中断的「提交中」由宿主对账，不在这里猜。 */
export function normalizePregenState(raw, gameId) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const state = {
    version: 1,
    gameId: typeof gameId === 'string' ? gameId : (typeof source.gameId === 'string' ? source.gameId : ''),
    settings: normalizePregenSettings(source.settings),
    entries: [],
    sends: [],
  }
  for (const item of Array.isArray(source.entries) ? source.entries : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.id !== 'string' || !/^pg-[A-Za-z0-9]{4,32}$/.test(item.id)) continue
    if (!PREGEN_STATUSES.includes(item.status)) continue
    if (typeof item.description !== 'string' || !item.description.trim()) continue
    const entry = {
      id: item.id,
      status: item.status,
      description: clipText(item.description, PREGEN_MAX_DESCRIPTION),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      createdTurn: Number.isInteger(item.createdTurn) && item.createdTurn >= 0 ? item.createdTurn : 0,
      attachments: (Array.isArray(item.attachments) ? item.attachments : []).map(attachmentOf).filter(Boolean),
    }
    for (const key of ['workflow', 'summary', 'error', 'argPrompt']) {
      if (typeof item[key] === 'string' && item[key]) entry[key] = clipText(item[key], key === 'argPrompt' ? PREGEN_MAX_PROMPT : 500)
    }
    for (const key of ['jobId', 'requestId', 'staleAt', 'staleNote', 'usedAt', 'staleReason']) {
      if (typeof item[key] === 'string' && item[key]) entry[key] = item[key]
    }
    for (const key of ['submittedAt', 'usedTurn', 'progress']) {
      if (typeof item[key] === 'number' && Number.isFinite(item[key])) entry[key] = item[key]
    }
    if (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) entry.args = item.args
    state.entries.push(entry)
  }
  for (const item of Array.isArray(source.sends) ? source.sends : []) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.entryId !== 'string' || !/^pg-[A-Za-z0-9]{4,32}$/.test(item.entryId)) continue
    if (typeof item.generationId !== 'string' || !item.generationId) continue
    state.sends.push({
      entryId: item.entryId,
      generationId: item.generationId,
      ...(typeof item.anchor === 'string' && item.anchor ? { anchor: clipText(item.anchor, 500) } : {}),
      ...(typeof item.caption === 'string' && item.caption ? { caption: clipText(item.caption, 500) } : {}),
      ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
    })
  }
  if (typeof source.lastError === 'string' && source.lastError) state.lastError = clipText(source.lastError, 500)
  if (typeof source.lastPlannedAt === 'string' && source.lastPlannedAt) state.lastPlannedAt = source.lastPlannedAt
  if (typeof source.lastAttemptAt === 'string' && source.lastAttemptAt) state.lastAttemptAt = source.lastAttemptAt
  if (Number.isInteger(source.lastTurn) && source.lastTurn >= 0) state.lastTurn = source.lastTurn
  trimEntries(state)
  return state
}

/** 落盘只写稳定字段；planning 只活在内存里。 */
export function serializePregenState(state) {
  return {
    version: 1,
    gameId: state.gameId,
    settings: normalizePregenSettings(state.settings),
    entries: state.entries.map(entry => ({
      id: entry.id,
      status: entry.status,
      description: entry.description,
      createdAt: entry.createdAt,
      createdTurn: entry.createdTurn,
      ...(entry.workflow ? { workflow: entry.workflow } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.submittedAt ? { submittedAt: entry.submittedAt } : {}),
      ...(entry.argPrompt ? { argPrompt: entry.argPrompt } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      ...(entry.staleReason ? { staleReason: entry.staleReason } : {}),
      ...(entry.staleAt ? { staleAt: entry.staleAt } : {}),
      ...(entry.staleNote ? { staleNote: entry.staleNote } : {}),
      ...(entry.usedAt ? { usedAt: entry.usedAt } : {}),
      ...(entry.usedTurn ? { usedTurn: entry.usedTurn } : {}),
      ...(Number.isFinite(entry.progress) ? { progress: entry.progress } : {}),
    })),
    ...(state.sends?.length ? { sends: state.sends.map(send => ({ ...send })) } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.lastPlannedAt ? { lastPlannedAt: state.lastPlannedAt } : {}),
    ...(state.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
    ...(Number.isInteger(state.lastTurn) ? { lastTurn: state.lastTurn } : {}),
  }
}

export function publicPregenState(state) {
  const live = state.entries.filter(entry => PREGEN_LIVE_STATUSES.includes(entry.status))
  return {
    settings: normalizePregenSettings(state.settings),
    entries: state.entries.map(publicEntry),
    live: live.length,
    ready: live.filter(entry => entry.status === 'ready').length,
    generating: live.filter(entry => entry.status === 'generating').length,
    ...(state.planning ? { planning: { startedAt: state.planning.startedAt, need: state.planning.need, review: state.planning.review } } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.lastPlannedAt ? { lastPlannedAt: state.lastPlannedAt } : {}),
  }
}

export function livePregenEntries(state) {
  return (state?.entries ?? []).filter(entry => PREGEN_LIVE_STATUSES.includes(entry.status))
}

/** 目标数量减去就绪 + 生成中；0＝池子已满。 */
export function pregenNeed(state) {
  return Math.max(0, normalizePregenSettings(state?.settings).count - livePregenEntries(state).length)
}

export function pregenEntryAge(entry, turn) {
  if (!Number.isInteger(turn) || turn <= 0) return 0
  // 第一轮之前规划的条目按第 1 轮起算，否则永远不会到期。
  const base = Number.isInteger(entry?.createdTurn) && entry.createdTurn > 0 ? entry.createdTurn : 1
  return Math.max(0, turn - base)
}

/** 复审候选：上一轮或更早规划、现在还就绪的条目；刚规划的不复审。 */
export function reviewableEntries(state, turn) {
  return (state?.entries ?? []).filter(entry => entry.status === 'ready' && pregenEntryAge(entry, turn) >= 1)
}

/** 就绪且超过 maxAge 轮没用到 → 退出池子，仍留在界面「已退」里可手动发。 */
export function expireStaleEntries(state, turn, now) {
  const maxAge = normalizePregenSettings(state.settings).maxAge
  const expired = []
  if (maxAge <= 0) return expired
  for (const entry of state.entries) {
    if (entry.status !== 'ready') continue
    const age = pregenEntryAge(entry, turn)
    if (age < maxAge) continue
    entry.status = 'stale'
    entry.staleAt = now
    entry.staleReason = 'age'
    entry.staleNote = `规划后 ${age} 轮没用到`
    expired.push(entry)
  }
  return expired
}

/** 已用 / 失败 / 删除 / 已退只留最近若干条；就绪与生成中的永远保留。 */
export function trimEntries(state) {
  const inactive = state.entries.filter(entry => !PREGEN_LIVE_STATUSES.includes(entry.status))
  if (inactive.length <= PREGEN_KEEP_INACTIVE) return false
  const drop = new Set(inactive.slice(0, inactive.length - PREGEN_KEEP_INACTIVE))
  state.entries = state.entries.filter(entry => !drop.has(entry))
  return true
}

/** 提示词去重：与池里已有的太像就不提交（规划器没听「不要重复」时的兜底）。 */
export function promptSimilarity(left, right) {
  const tokens = text => new Set(String(text ?? '').toLowerCase().match(/<[^>]+>|[a-z0-9_]{2,}|[\u4e00-\u9fff]/g) ?? [])
  const a = tokens(left), b = tokens(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function filterDuplicateVideos(videos, prompts) {
  const existing = (prompts ?? []).filter(Boolean)
  const kept = []
  for (const video of videos) {
    if (existing.some(prompt => promptSimilarity(prompt, video.prompt) >= PREGEN_DUPLICATE_SIMILARITY)) continue
    if (kept.some(item => promptSimilarity(item.prompt, video.prompt) >= PREGEN_DUPLICATE_SIMILARITY)) continue
    kept.push(video)
  }
  return kept
}

/** 模型没按约定调工具 / 把 JSON 写在正文里时的兜底：认代码块、第一个对象或数组。 */
export function parsePlanObject(text) {
  const source = String(text ?? '')
  const candidates = []
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  const firstBrace = source.indexOf('{'), lastBrace = source.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1))
  const firstBracket = source.indexOf('['), lastBracket = source.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(source.slice(firstBracket, lastBracket + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) return { videos: parsed }
      if (parsed && typeof parsed === 'object') {
        const videos = Array.isArray(parsed.videos) ? parsed.videos : undefined
        const retire = Array.isArray(parsed.retire) ? parsed.retire : undefined
        if (videos || retire) return { ...(videos ? { videos } : {}), ...(retire ? { retire } : {}) }
      }
    } catch { /* 试下一个候选 */ }
  }
  return undefined
}

/** 清单 → 干净的条目；description / prompt 必填，prompt 截断到可提交长度。 */
export function normalizePlanVideos(raw, limit = PREGEN_PLAN_BATCH) {
  const videos = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const prompt = clipText(item.prompt, PREGEN_MAX_PROMPT)
    if (!prompt) continue
    const description = clipText(item.description, PREGEN_MAX_DESCRIPTION) || clipText(prompt, 60)
    videos.push({ description, prompt })
    if (videos.length >= limit) break
  }
  return videos
}

/** 只认复审候选里的 pool_id；同一条只记一次，原因截短。 */
export function normalizeRetire(raw, candidates) {
  const byId = new Map((candidates ?? []).map(entry => [entry.id, entry]))
  const seen = new Set()
  const retired = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.pool_id : undefined
    if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) continue
    const reason = item && typeof item === 'object' && typeof item.reason === 'string'
      ? clipText(item.reason, 120) : ''
    seen.add(id)
    retired.push({ entry: byId.get(id), reason: reason || '规划器判定不再合剧情' })
  }
  return retired
}

const OUTPUT_EXAMPLE = '{"videos":[{"description":"中文一句话描述这个画面","prompt":"按模板写好的成品提示词"}],"retire":[{"pool_id":"pg-xxxxxxxx","reason":"为什么不再合剧情"}]}'

/** 规划器的系统提示词：身份、固定工作流、模板、规划原则与输出格式；动态资料放 user 消息。 */
export function buildPlannerPrompt(input) {
  const { alias, template } = input
  const lines = []
  lines.push('你是 RunningHub 视频工作台的后台视频预备员，服务的是一段正在进行的角色扮演 / 互动小说。')
  lines.push('你不与玩家对话，也不续写剧情；你只按最近发生的剧情预判接下来最可能出现的画面，写成可以直接提交给 RunningHub 的成品视频提示词，让前台需要时立刻有片可用。')
  lines.push('')
  lines.push(`当前工作流固定为「${alias}」，不要选择或猜测其他工作流。`)
  lines.push('下面「提示词模板」是前台生成时使用的同一份模板；提示词的语言、格式、长度、镜头要求都按模板写。模板要求 image### / video### 两段时，两段都要写进同一条 prompt。')
  lines.push('人物外貌、身材、衣着、场景与光线要和最近剧情、人物设定保持一致；角色脱掉 / 换掉的按最新状态写。')
  lines.push('不要为了凑数写和最近剧情无关的画面；几条之间方向要明显不同，不要出同一个画面的变体。')
  if (template) {
    lines.push('')
    lines.push('## 提示词模板')
    lines.push(String(template).slice(0, 20000))
  }
  lines.push('')
  lines.push('## 输出')
  lines.push('只输出一个 JSON 对象，不要 Markdown、不要代码块、不要解释。格式：')
  lines.push(OUTPUT_EXAMPLE)
  lines.push('没有复审任务时省略 retire，或给空数组。videos 里不要超过用户消息要求数量；description 与 prompt 都写完整。')
  return lines.join('\n')
}

/** 给规划器的一轮用户消息：最近剧情、人物设定、已有池子、复审候选与本次数量。 */
export function buildPlannerUserMessage(input) {
  const {
    history, card, existing = [], review = [], need = 0, maxNew = 0,
    target = 0, turn = 0, reviewOn = true, maxAge = PREGEN_DEFAULT_MAX_AGE,
  } = input
  const lines = []
  lines.push('最近剧情（旧 → 新）：')
  lines.push(history || '（还没有可读的正文，按人物设定与开场画面规划。）')
  if (card) {
    lines.push('')
    lines.push('## 人物与场景设定')
    lines.push(String(card).slice(0, 4000))
  }
  lines.push('')
  lines.push('## 池子里已有的视频（不要重复）')
  if (!existing.length) lines.push('（空）')
  else {
    for (const entry of existing) {
      const age = entry.age > 0 ? `${entry.age} 轮前规划` : '刚规划'
      lines.push(`- [${entry.status === 'ready' ? '就绪' : '生成中'} · ${age}] ${entry.description}`)
    }
  }
  if (reviewOn && review.length) {
    lines.push('')
    lines.push('## 复审（可以退掉的就绪条目）')
    lines.push('下面几条是之前几轮规划的就绪视频。只退明显不再可能用上的：地点、衣着、情绪阶段已经翻篇，和最近剧情矛盾，或与已经看过的画面重复。拿不准的留着；退错一条等于白花一份积分。')
    for (const entry of review) lines.push(`- pool_id: ${entry.id} · ${entry.age > 0 ? `${entry.age} 轮前规划` : '较早规划'} · ${entry.description}`)
    if (maxAge > 0) lines.push(`（就绪满 ${maxAge} 轮没用到的会由系统自动退出池子。）`)
  }
  lines.push('')
  lines.push('## 本次要做什么')
  const wanted = Math.min(Math.max(0, maxNew), Math.max(0, need + review.length))
  if (wanted > 0) {
    lines.push(`请写出 ${wanted} 条备用视频提示词${review.length ? '（每退掉一条可以多补一条，最多这么多条）' : ''}。`)
  } else {
    lines.push('池子已经满了；这次只做复审。没有明显该退的就不用补新视频。')
  }
  lines.push(`当前是第 ${turn || 0} 轮，池子目标 ${target} 条。`)
  lines.push('每一条：description 是一句中文，告诉前台这段视频对应哪种剧情走向（给模型匹配用，不超过 120 字）；prompt 是可直接提交的成品提示词。')
  lines.push('要退的条目写进 retire（pool_id 必须是上面列出的）；每退一条可以多补一条新的。')
  return lines.join('\n')
}
