#!/usr/bin/env node
// 查重复提交：扫任务目录，按「对话 + 提示词指纹」和「网关任务编号」找同一个镜头被打了两遍。
//
//   node bin/duplicate-report.mjs                 # 默认 ~/.dsh/profile-data/tavern/data/runninghub/tasks
//   node bin/duplicate-report.mjs <tasks 目录>
//   DSH_HOME=/path/to/.dsh node bin/duplicate-report.mjs
//
// 只读。旧版本写下的任务记录没有 fingerprint 字段，会被计进「无指纹」那一行，不算重复。

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const directory = path.resolve(process.argv[2] || path.join(
  process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  'profile-data', 'tavern', 'data', 'runninghub', 'tasks',
))

const names = (await readdir(directory).catch(() => null))
if (!names) {
  console.error('读不到任务目录：' + directory)
  process.exit(1)
}

const jobs = []
let unreadable = 0
for (const name of names.sort()) {
  if (!name.endsWith('.json')) continue
  try { jobs.push(JSON.parse(await readFile(path.join(directory, name), 'utf8'))) } catch { unreadable += 1 }
}

const byShot = new Map()
const byRemote = new Map()
let noFingerprint = 0
for (const job of jobs) {
  const fingerprint = job.fingerprint ?? job.binding?.fingerprint
  const gameId = job.markerGameId ?? job.binding?.gameId
  if (typeof fingerprint === 'string' && fingerprint && typeof gameId === 'string' && gameId) {
    const key = gameId + '\u0000' + fingerprint
    if (!byShot.has(key)) byShot.set(key, [])
    byShot.get(key).push(job)
  } else noFingerprint += 1
  if (typeof job.remoteTaskId === 'string' && job.remoteTaskId) {
    const key = job.remoteTaskId
    if (!byRemote.has(key)) byRemote.set(key, [])
    byRemote.get(key).push(job)
  }
}

const describe = job => [
  job.id,
  job.createdAt,
  job.status,
  job.binding?.turn !== undefined ? 'turn=' + job.binding.turn : '-',
  job.remoteTaskId ? 'remote=' + job.remoteTaskId : '-',
  job.binding?.preclaim ? 'preclaim' : '-',
].join('  ')

const shotDupes = [...byShot.entries()].filter(([, list]) => list.length > 1)
const remoteDupes = [...byRemote.entries()].filter(([, list]) => list.length > 1)

console.log('任务目录：' + directory)
console.log(`任务记录：${jobs.length} 条（无法解析 ${unreadable} 条，无指纹的旧记录 ${noFingerprint} 条）`)
console.log('')

if (!shotDupes.length && !remoteDupes.length) {
  console.log('没有发现重复提交。')
  process.exit(0)
}

for (const [key, list] of shotDupes) {
  const [gameId, fingerprint] = key.split('\u0000')
  console.log(`同一个镜头提交了 ${list.length} 次：game=${gameId} fingerprint=${fingerprint}`)
  for (const job of list) console.log('  ' + describe(job))
  console.log('')
}
for (const [remote, list] of remoteDupes) {
  console.log(`同一个网关任务出现在 ${list.length} 条记录里：${remote}`)
  for (const job of list) console.log('  ' + describe(job))
  console.log('')
}
process.exit(2)
