#!/usr/bin/env node
/**
 * 清点「挂着 pending 却永远不会落位」的旧任务。
 *
 * 背景：自动插入的媒体要等宿主结算回调写 bindings/<id>.json 才算落位。
 * 历史版本在几处把 afterTurn / pending 记错，导致任务卡片一直显示「已绑定正文」，
 * 正文里却永远是空的；这些记录不会再被任何结算路径认领，只是每次对账都白扫一遍。
 *
 * 判定（三条同时成立才动）：
 *   1. 终态任务（ready / failed / download_failed / submit_unknown），不碰生成中的；
 *   2. binding.pending === true；
 *   3. 最后更新时间早于 --hours（默认 24 小时）——刚提交、正在等下一次结算的必须留着。
 *
 * 处理：
 *   - bindings/<id>.json 存在：媒体其实已经落位，只把 pending 标记去掉；
 *   - 没有落位文件：binding 清空成 {}，任务保留在历史里（照旧可以预览 / 重放）。
 *
 * 用法：
 *   node bin/clean-stale-pending.mjs                    # 只报告，不改文件
 *   node bin/clean-stale-pending.mjs --hours 6          # 收紧到 6 小时
 *   node bin/clean-stale-pending.mjs --apply            # 真的写入（先备份）
 *   node bin/clean-stale-pending.mjs --data <...>/runninghub --json
 */
import { open, readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const valueOf = name => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? argv[index + 1] : undefined
}

const TERMINAL = new Set(['ready', 'failed', 'download_failed', 'submit_unknown'])
const hoursArg = Number(valueOf('hours'))
const hours = Number.isFinite(hoursArg) && hoursArg >= 0 ? hoursArg : 24
const cutoff = Date.now() - hours * 3600_000
const apply = flag('apply')
const asJSON = flag('json')

function dataCandidates() {
  const homes = [process.env.DSH_HOME, path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.dsh-tavern')].filter(Boolean)
  const dirs = homes.map(home => path.join(home, 'profile-data', 'tavern', 'data', 'runninghub'))
  const explicit = valueOf('data')
  if (explicit) dirs.unshift(path.resolve(explicit))
  return [...new Set(dirs)]
}

async function pickDirectory() {
  for (const dir of dataCandidates()) {
    try { await readdir(path.join(dir, 'tasks')); return dir } catch { /* 下一个 */ }
  }
  return ''
}

async function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally { await handle.close() }
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

const directory = await pickDirectory()
if (!directory) {
  console.error('找不到 runninghub 数据目录；用 --data <.../runninghub> 指定')
  process.exit(1)
}
const tasksDir = path.join(directory, 'tasks')
const bindingsDir = path.join(directory, 'bindings')

const bindingIds = new Set()
try {
  for (const name of await readdir(bindingsDir)) if (name.endsWith('.json')) bindingIds.add(name.slice(0, -5))
} catch { /* 没有 bindings 目录 = 一条都没落位过 */ }

const landed = []   // 已落位，只是 pending 标记没清
const orphan = []   // 从没落位，绑定永远等不到人
const skipped = { recent: 0, active: 0, notPending: 0, unreadable: 0 }

for (const name of await readdir(tasksDir)) {
  if (!name.endsWith('.json')) continue
  const file = path.join(tasksDir, name)
  let job
  try { job = JSON.parse(await readFile(file, 'utf8')) } catch { skipped.unreadable += 1; continue }
  if (job?.binding?.pending !== true) { skipped.notPending += 1; continue }
  if (!TERMINAL.has(job.status)) { skipped.active += 1; continue }
  const updated = Date.parse(job.updatedAt || job.createdAt || '') || 0
  if (updated > cutoff) { skipped.recent += 1; continue }
  const id = String(job.id || name.slice(0, -5))
  ;(bindingIds.has(id) ? landed : orphan).push({ id, file, job, updated })
}

const report = {
  directory,
  cutoff: new Date(cutoff).toISOString(),
  hours,
  apply,
  landed: landed.length,
  orphan: orphan.length,
  skipped,
  landedSample: landed.slice(0, 10).map(item => ({ id: item.id, turn: item.job.binding?.turn, textVersion: item.job.binding?.textVersion })),
  orphanSample: orphan.slice(0, 20).map(item => ({
    id: item.id, status: item.job.status,
    turn: item.job.binding?.turn, afterTurn: item.job.binding?.afterTurn,
    preclaim: item.job.binding?.preclaim === true, updatedAt: item.job.updatedAt,
  })),
}

let backupDir = ''
if (apply && (landed.length || orphan.length)) {
  backupDir = path.join(directory, 'pending-cleanup-backup-' + new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  for (const item of [...landed, ...orphan]) {
    await writeFile(path.join(backupDir, path.basename(item.file)), await readFile(item.file, 'utf8'), { mode: 0o600 })
  }
  for (const item of landed) {
    const next = { ...item.job, binding: { ...item.job.binding } }
    delete next.binding.pending
    await atomicWrite(item.file, JSON.stringify(next))
  }
  for (const item of orphan) {
    const next = { ...item.job, binding: {} }
    await atomicWrite(item.file, JSON.stringify(next))
  }
  report.backupDir = backupDir
}

if (asJSON) {
  console.log(JSON.stringify(report, null, 1))
} else {
  console.log('数据目录：' + directory)
  console.log('时间线：只处理 ' + report.cutoff + ' 之前更新过的任务（--hours ' + hours + '）')
  console.log('已落位但 pending 未清：' + landed.length + '（只删 pending 标记）')
  console.log('从未落位、绑定作废：' + orphan.length + '（binding 清空，任务保留在历史里）')
  console.log('跳过：近期 ' + skipped.recent + ' / 生成中 ' + skipped.active + ' / 无 pending ' + skipped.notPending + ' / 读不出 ' + skipped.unreadable)
  if (apply) console.log('已写入；原文件备份在：' + backupDir)
  else console.log('这是预演，没有改任何文件；加 --apply 才写入。')
}
