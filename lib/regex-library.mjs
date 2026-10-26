// 把「移除正文标记块」写进 Tavern 的全局正则库。
//
// Tavern 的全局正则存在 <tavern data>/tavern-extension-settings.json 的
// `regex` 数组里，显示投影和提示词投影都会经过它：
//   - displayText / bodyText：正文区与存档投影，标记块整段不显示；
//   - text（sessionText）：写进行记录时就是「模型上下文」的文本，标记块不进下一轮提示词。
// 所以不用 editTurn，也就没有「HTML 块要保持原样」的限制；旧的正文在重新读取时
// 也会按当前正则重新投影。
//
// 插件没有公开的正则库 API，所以这里只做一件事：按 id 维护自己那两条正则，
// 保留文件里的其它字段和用户自己的正则；写入用同目录临时文件 + rename，
// 并在覆盖前重读一次，尽量不和 Tavern 窗口的写入互相覆盖。

import { chmod, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const MARKER_REGEX_ID = 'dsh-runninghub-marker-strip'
export const MARKER_REGEX_NAME = 'RunningHub · 移除正文标记块（自动管理）'
export const MARKER_OPEN_REGEX_ID = 'dsh-runninghub-marker-strip-open'
export const MARKER_OPEN_REGEX_NAME = 'RunningHub · 移除未闭合的标记块（自动管理）'

// SillyTavern 的斜杠格式；兼容全角括号、全角斜杠和大小写。
// 第一条管闭合块：跨行、跨 HTML 块都能整段吃掉。
const MARKER_FIND_REGEX = '/[\\[［]{2}\\s*RH\\s*[:：]\\s*SHOT\\s*[\\]］]{2}[\\s\\S]*?[\\[［]{2}\\s*[\\/／]\\s*RH\\s*(?:[:：]\\s*SHOT\\s*)?[\\]］]{2}/gi'
// 第二条兜底：模型漏写结束行时，从开标记 + 紧跟的 @字段 吃到空行或文本末尾。
// 要求开标记后第一行就是字段名，避免正文里只是提到 [[RH:SHOT]] 时被误删；
// 只吃到空行（而不是整篇末尾）是因为标记块现在写在正文前面——漏写结束行时，
// 一直吃到末尾会把整篇正文一起藏掉，停在第一个空行最多只损失紧贴块后的第一段。
const MARKER_OPEN_FIND_REGEX = '/[\\[［]{2}\\s*RH\\s*[:：]\\s*SHOT\\s*[\\]］]{2}[ \\t]*\\r?\\n[ \\t]*@(?:after|caption|prompt|image|video)\\b[\\s\\S]*?(?=\\r?\\n[ \\t]*\\r?\\n|$)/gi'

export function markerRegexScript() {
  return {
    id: MARKER_REGEX_ID,
    scriptName: MARKER_REGEX_NAME,
    findRegex: MARKER_FIND_REGEX,
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
  }
}

export function markerOpenRegexScript() {
  return {
    ...markerRegexScript(),
    id: MARKER_OPEN_REGEX_ID,
    scriptName: MARKER_OPEN_REGEX_NAME,
    findRegex: MARKER_OPEN_FIND_REGEX,
  }
}

/** 两条规则必须按这个顺序执行：先收闭合块，再用兜底收漏写结束行的块。 */
export function markerRegexScripts() {
  return [markerRegexScript(), markerOpenRegexScript()]
}


export function markerRegexFile(directory) {
  return path.join(String(directory || ''), 'tavern-extension-settings.json')
}

function reason(error) {
  return String(error?.message || error || '未知原因')
}

async function writeAtomic(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp'
  let handle
  // 已有文件沿用它的权限；新建时交给 umask 决定，不显式放宽。
  let mode = null
  try { mode = (await stat(file)).mode & 0o777 } catch { /* 新建文件 */ }
  try {
    handle = await open(temp, 'wx', mode ?? 0o666)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (mode !== null) {
      try { await chmod(temp, mode) } catch { /* 文件系统不支持 chmod 时保留默认权限 */ }
    }
    await rename(temp, file)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temp).catch(() => {})
  }
}

/**
 * 按 id 合并自己的两条规则：
 * - 已存在就覆盖成当前定义（这条规则由插件管理，用户在 UI 里改回也会被改回来）；
 * - 不存在就按「闭合块 → 兜底」的顺序插到最前面（Tavern 按数组顺序执行）。
 * 其它条目原样保留。
 */
function mergeScripts(current, enabled) {
  const desired = markerRegexScripts()
  const managed = new Set(desired.map(script => script.id))
  const next = current.filter(item => !(item && typeof item === 'object' && managed.has(item.id)))
  // 完全用当前定义覆盖，不保留旧字段：这条规则由插件管理，避免用户在 UI 里
  // 加的 minDepth / substituteRegex 之类让清理悄悄失效。
  const insert = desired.map(script => ({ ...script, disabled: enabled !== true }))
  return { next: [...insert, ...next] }
}

async function updateRegexFile(target, enabled) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let raw
    let missing = false
    try { raw = await readFile(target, 'utf8') }
    catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: reason(error) }
      missing = true
    }
    let document = {}
    if (!missing) {
      try { document = JSON.parse(raw) } catch (error) { return { ok: false, reason: '正则库不是有效 JSON：' + reason(error) } }
      if (!document || typeof document !== 'object' || Array.isArray(document)) return { ok: false, reason: '正则库格式无效' }
    }
    const current = Array.isArray(document.regex) ? document.regex : []
    const merged = mergeScripts(current, enabled)
    if (missing && enabled !== true) return { ok: true, changed: false, file: target }
    if (JSON.stringify(merged.next) === JSON.stringify(current) && !missing) return { ok: true, changed: false, file: target }
    if (missing) {
      // 全新 profile 还没有这个文件；父目录存在时才创建，路径推导错了不造空目录。
      try { await stat(path.dirname(target)) } catch { return { ok: false, reason: 'Tavern 正则库目录不存在：' + path.dirname(target) } }
    } else {
      // 覆盖前重读：Tavern 窗口可能刚好也写了这个文件；变了就重来一轮。
      let latest
      try { latest = await readFile(target, 'utf8') } catch (error) { return { ok: false, reason: reason(error) } }
      if (latest !== raw) continue
    }
    try {
      await writeAtomic(target, { ...document, regex: merged.next })
      return { ok: true, changed: true, file: target, created: missing }
    } catch (error) {
      return { ok: false, reason: reason(error) }
    }
  }
  return { ok: false, reason: '正则库正在被其他窗口修改，请稍后重试' }
}

/**
 * 确保正则库里有一对标记清理规则（启用）。
 * 返回 { ok, changed, created?, reason? }，不抛错，方便宿主把失败原因显示到面板上。
 */
export async function ensureMarkerRegex({ file } = {}) {
  const target = String(file || '')
  if (!target) return { ok: false, reason: '没有 Tavern 正则库路径' }
  return updateRegexFile(target, true)
}

/** 插件停用/卸载时把自己的规则关掉，不影响用户和其它插件的正则。 */
export async function disableMarkerRegex({ file } = {}) {
  const target = String(file || '')
  if (!target) return { ok: false, reason: '没有 Tavern 正则库路径' }
  return updateRegexFile(target, false)
}

