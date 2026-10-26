// 正文标记（非工具调用模式）的解析与提示词格式。
//
// 模型在正文末尾写：
//   [[RH:SHOT]]
//   @after
//   正文里紧挨插入位置的一句原句
//   @caption
//   可选的镜头名
//   @prompt
//   单段工作流的提示词
//   [[/RH:SHOT]]
//
// 两段式管线用 @image / @video 代替 @prompt。宿主在结算时解析这些块，
// 把块从正文里移除，再按 @after 的位置挂上插件媒体占位。
//
// 这里只做纯文本解析，不碰 Tavern、不碰网络，方便单测。

import { createHash } from 'node:crypto'

const SHOT_OPEN = /\[\[\s*RH\s*[:：]\s*SHOT\s*\]\]/gi
const SHOT_CLOSE = /\[\[\s*\/\s*RH\s*(?:[:：]\s*SHOT\s*)?\]\]/gi
const FIELD = /^[ \t]*@(after|caption|prompt|image|video)\b[ \t]*[:：]?[ \t]*(.*)$/i
const ANCHOR_LIMIT = 500
const CAPTION_LIMIT = 200
const MAX_BLOCKS = 200

/** 全角方括号也能识别；两个字符都等长，替换后下标仍能对回原文。 */
function normalized(text) {
  return String(text ?? '').replaceAll('［', '[').replaceAll('］', ']')
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
}

/**
 * 标记块里的提示词常引用工作流模板的尖括号标签（<Picture 1> / <Subject 1>）。
 * 模型写成 &lt;Picture 1&gt; / &lt;Subject 1&gt; 时在这里还原成提交给网关的形式。
 * 只还原尖括号和引号，不碰普通的 &。
 */
export function decodePromptEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

/**
 * 扫描打开的标记块。未闭合的块也返回，`closed: false`，方便宿主清理半截提示词；
 * 但调用方应按块内实际字段决定能不能提交。
 */
export function scanMarkerBlocks(text) {
  const source = String(text ?? '')
  const scan = normalized(source)
  const blocks = []
  let cursor = 0
  while (blocks.length < MAX_BLOCKS) {
    SHOT_OPEN.lastIndex = cursor
    const open = SHOT_OPEN.exec(scan)
    if (!open) break
    const start = open.index
    const contentStart = open.index + open[0].length
    SHOT_CLOSE.lastIndex = contentStart
    const close = SHOT_CLOSE.exec(scan)
    const end = close ? close.index + close[0].length : scan.length
    blocks.push({
      start,
      end,
      inner: scan.slice(contentStart, close ? close.index : scan.length),
      closed: Boolean(close),
    })
    cursor = end
    if (!close) break
  }
  return blocks
}

/** 解析一个块内部的字段。字段名后面的内容可以换行，也可以写在同一行。 */
export function parseMarkerFields(inner) {
  const fields = {}
  let current = ''
  let leading = ''
  for (const line of String(inner ?? '').split(/\r?\n/)) {
    const match = FIELD.exec(line)
    if (match) {
      current = match[1].toLowerCase()
      const value = match[2] ?? ''
      fields[current] = fields[current] ? fields[current] + '\n' + value : value
      continue
    }
    if (current) fields[current] += '\n' + line
    else leading += (leading ? '\n' : '') + line
  }
  for (const key of Object.keys(fields)) fields[key] = fields[key].trim()
  return { fields, leading: leading.trim() }
}

/**
 * 把块内字段落成一条可提交的镜头。
 *
 * - 管线：必须有 @image 与 @video，分别落到 custom.image_prompt 与 prompt。
 * - 单段：必须有 @prompt；为了容忍模型写成 @image / @video，只有一个时也可当主提示词。
 * - `error` 非空时宿主不提交，只把原因挂成失败占位。
 */
export function parseMarkerShot(inner, { pipeline = false } = {}) {
  const { fields, leading } = parseMarkerFields(inner)
  const hasAny = Object.keys(fields).length > 0
  const after = String(fields.after ?? '').trim().split(/\r?\n/)[0].trim().slice(0, ANCHOR_LIMIT)
  const caption = firstLine(fields.caption).slice(0, CAPTION_LIMIT)
  const image = decodePromptEntities(fields.image)
  const video = decodePromptEntities(fields.video)
  let prompt = decodePromptEntities(fields.prompt)
  // 指纹基于块里写明的原始三段（未做单段回退），浏览器侧的流式预提交算的是同一份。
  const fingerprint = shotFingerprint({ prompt, image, video })

  if (pipeline) {
    const error = image && video ? '' : '两段式管线需要 @image 与 @video 两段提示词'
    return { after, caption, image, video, prompt: '', fingerprint, error }
  }
  if (!prompt) {
    if (image && !video) prompt = image
    else if (video && !image) prompt = video
    else if (!hasAny) prompt = decodePromptEntities(leading)
  }
  const error = prompt ? '' : (image && video ? '单段工作流只需要一个提示词，不要同时写 @image 与 @video' : '缺少 @prompt 提示词')
  return { after, caption, image: '', video: '', prompt, fingerprint, error }
}

/**
 * 稳定的 32 位 FNV-1a。浏览器侧 client.js 里有同一份实现：正文标记的流式预提交
 * 在浏览器里算指纹，结算时宿主再算一次，两边必须逐字节一致，所以不用 crypto。
 */
function fnv1a(text, seed) {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 一个镜头的提示词指纹：流式预提交和结算认领都靠它认出「同一个镜头」。
 * 只喂标记块里写明的 @prompt / @image / @video，字段顺序与 trim 必须和 client.js 相同。
 */
export function shotFingerprint({ prompt = '', image = '', video = '' } = {}) {
  const base = [prompt, image, video].map(value => String(value ?? '').trim()).join('\u0000')
  return fnv1a(base, 0x811c9dc5) + fnv1a(base, 0x9e3779b9)
}

/**
 * 解析整段正文。
 *
 * 返回的 `text` 已经移除所有标记块（包括格式错误、超过上限的块），供诊断和测试比对；
 * 真正决定玩家看到什么、模型下一轮读到什么的是 Tavern 全局正则投影。
 * `shots` 里保留前 `limit` 块的解析结果和 `error`，多出来的只计数。
 *
 * `closedOnly` 只认已经写完 `[[/RH:SHOT]]` 的块：浏览器侧的流式预提交是在正文
 * 还没写完时读的，半截提示词不能拿去提交。
 */
export function parseMarkerShots(text, { pipeline = false, limit = Infinity, closedOnly = false } = {}) {
  const source = String(text ?? '')
  const blocks = scanMarkerBlocks(source).filter(block => !closedOnly || block.closed)
  if (!blocks.length) return { found: 0, shots: [], dropped: 0, text: source, blocks }
  const max = Number.isInteger(limit) && limit > 0 ? limit : Infinity
  const shots = []
  let dropped = 0
  blocks.forEach((block, index) => {
    if (index >= max) { dropped += 1; return }
    const shot = parseMarkerShot(block.inner, { pipeline })
    shots.push({
      index,
      ...shot,
      anchor: shot.after,
      ...(block.closed ? {} : { error: shot.error || '标记块没有闭合，已按到正文末尾处理' }),
    })
  })
  return { found: blocks.length, shots, dropped, text: stripMarkerBlocks(source, blocks), blocks }
}

/** 只移除标记块，返回清理后的正文。块放在正文末尾时顺带收掉尾部空行。 */
export function stripMarkerBlocks(text, blocks = scanMarkerBlocks(text)) {
  let result = String(text ?? '')
  if (!blocks.length) return result
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    let start = block.start
    let end = block.end
    while (start > 0 && (result[start - 1] === ' ' || result[start - 1] === '\t')) start -= 1
    if (start > 0 && result[start - 1] === '\n') start -= 1
    while (end < result.length && (result[end] === ' ' || result[end] === '\t')) end += 1
    if (end < result.length && result[end] === '\n') end += 1
    result = result.slice(0, start) + result.slice(end)
  }
  return result.replace(/[ \t]+$/, '').trimEnd()
}

/**
 * 给宿主和测试用的稳定请求 ID：同一局同一轮的同一个镜头（提示词指纹相同）永远
 * 落到同一个任务。流式预提交先发一次，结算时再走一遍同一个 ID，网关只收一次费。
 * 不带 textVersion 是故意的——预提交发生时版本号还没定；重生成同一轮但提示词没变时
 * 复用原任务，不重复扣费。
 */
export function markerRequestId({ gameId, turn, fingerprint }) {
  const input = [String(gameId ?? ''), String(turn ?? ''), String(fingerprint ?? '')].join('\u0000')
  return 'rh-' + createHash('sha256').update(input).digest('hex').slice(0, 40)
}

/**
 * 注入正文提示词的格式说明。宿主把它放在当前工作流模板前面，
 * 避免长模板把格式要求挤到注意力边缘。
 */
export function markerPromptSpec({ pipeline = false, count = 1 } = {}) {
  const n = Number.isInteger(count) && count > 0 ? count : 1
  const example = pipeline
    ? [
        '[[RH:SHOT]]',
        '@after',
        '正文里紧挨插入位置的一句原句，逐字复制',
        '@caption',
        '可选，短镜头名',
        '@image',
        '生图段提示词（Qwen 多图生图的参考图标签按模板写）',
        '@video',
        '视频段提示词（图生视频，首帧就是上一段的成图）',
        '[[/RH:SHOT]]',
      ]
    : [
        '[[RH:SHOT]]',
        '@after',
        '正文里紧挨插入位置的一句原句，逐字复制',
        '@caption',
        '可选，短镜头名',
        '@prompt',
        '这条工作流完整的一段提示词',
        '[[/RH:SHOT]]',
      ]
  const lines = [
    '【RunningHub 正文标记 · 输出格式（优先级最高）】',
    '本轮不要调用 RunningHub 的任何工具（runninghub_generate / runninghub_send_pregenerated）。镜头提示词只写在正文前面的标记块中。',
    '如果 Tavern 要求用 submit_story 提交正文，就把同一份正文和标记块一起放进 content；没有这个要求时直接写在普通回复里。',
    `本轮写 ${n} 个标记块，不要多也不要少。每个块对应一个镜头；块会由插件从正文中移除，玩家不会看到提示词。`,
    '顺序：先在思考里定稿完整的本轮正文（写块时正文还没输出，所以要先把要引用的那句话定下来），然后**先输出标记块，紧接着再输出正文**。标记块在回复最前面，正文从块后面开始。',
    '播放器会插到 @after 那句之后，所以 @after 必须逐字引用**后面正文里**的一句话；省略 @after 时视频附在正文末尾。',
    pipeline
      ? '当前是两段式管线：@image 是生图段，@video 是视频段，两段都必须写，不能合并。'
      : '当前是单段工作流：只写 @prompt，不要写 @image / @video。',
    '',
    example.join('\n'),
    '',
    '格式要求：块开始与结束行必须逐字写成 [[RH:SHOT]] 与 [[/RH:SHOT]]；字段名单独占一行（@after、@caption、@prompt、@image、@video）。',
    '提示词里不要出现单独成行的上述字段名，也不要把标记块包进代码块。',
    '标记块写在正文之前，块里不要写剧情、摘要或与提示词无关的说明；块写完后直接开始正文第一段，中间不要加“正文：”之类的提示行。即使本轮正文含 HTML，也不要把标记块写进 HTML 内部。',
    '标记块整段会被 Tavern 正则移除，块内可以照常写 <Picture N> / <Subject N> 这类尖括号标签，不用转义。',
  ]
  return lines.join('\n')
}

/** 只判断有没有入口，宿主在连网关之前可以先做一次廉价的短路。 */
export function hasMarkerBlock(text) {
  SHOT_OPEN.lastIndex = 0
  return SHOT_OPEN.test(String(text ?? ''))
}
