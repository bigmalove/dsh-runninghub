#!/usr/bin/env node
/**
 * 手机 / termux 排障：插件报「连接异常」时，先确认到底哪个地址能连上网关。
 *
 * 用法（在有 DSH 的那台手机上，termux 里执行）：
 *   node bin/doctor.mjs
 *   node bin/doctor.mjs --settings <...>/runninghub/connection.json --key <网关Key>
 *   node bin/doctor.mjs --base http://192.168.1.23:6888 --key sk-xxx
 *
 * 只做 TCP 连接 + 一次 GET /api/workflows；Key 用完即弃，不落盘、不回显。
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const argv = process.argv.slice(2)
const valueOf = (name) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? argv[index + 1] : undefined
}
const key = (valueOf('key') || process.env.DSH_RUNNINGHUB_KEY || '').trim()

function settingsCandidates() {
  const homes = [process.env.DSH_HOME, path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.dsh-tavern')].filter(Boolean)
  const files = []
  for (const home of homes) files.push(path.join(home, 'profile-data', 'tavern', 'data', 'runninghub', 'connection.json'))
  if (valueOf('data')) files.unshift(path.join(valueOf('data'), 'connection.json'))
  return [...new Set([valueOf('settings'), process.env.DSH_RUNNINGHUB_SETTINGS, ...files].filter(Boolean))]
}

let settings = null
let settingsFile = ''
for (const file of settingsCandidates()) {
  try { settings = JSON.parse(await readFile(file, 'utf8')); settingsFile = file; break } catch { /* 试下一个 */ }
}

const baseText = settings?.baseURL || valueOf('base') || 'http://127.0.0.1:6888'
let base
try { base = new URL(baseText) } catch { base = new URL('http://127.0.0.1:6888') }
const port = Number(valueOf('port') || base.port || (base.protocol === 'https:' ? 443 : 6888))
const configuredHost = base.hostname.replace(/^\[|\]$/g, '')

const hosts = []
const addHost = (host) => { if (host && !hosts.includes(host)) hosts.push(host) }
addHost(configuredHost)
addHost('127.0.0.1')
addHost('::1')
if (!process.argv.includes('--local-only')) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal) addHost(item.address)
  }
}

function tcpProbe(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const finish = (ok, code) => { socket.destroy(); resolve({ ok, code, ms: Date.now() - started }) }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true, 'open'))
    socket.once('timeout', () => finish(false, 'ETIMEDOUT'))
    socket.on('error', (error) => finish(false, error.code || 'ERROR'))
  })
}

async function httpProbe(host, port) {
  const shown = host.includes(':') ? `[${host}]` : host
  try {
    const response = await fetch(`http://${shown}:${port}/api/workflows`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    const text = await response.text()
    let note = ''
    try {
      const body = JSON.parse(text)
      const list = Array.isArray(body) ? body : body?.workflows ?? body?.data
      if (Array.isArray(list)) note = `工作流 ${list.length} 个`
      else if (body?.error) note = String(body.error?.message || body.error).slice(0, 60)
    } catch { note = (text || '').replace(/\s+/g, ' ').slice(0, 60) }
    return { status: response.status, note }
  } catch (error) {
    return { error: error?.cause?.code || error?.code || error.message }
  }
}

console.log('dsh-runninghub 连接排障')
console.log(`  配置文件 : ${settingsFile || '未找到，按默认 ' + baseText}`)
if (settings) {
  console.log('  已存地址 : ' + (settings.baseURL || '(空)') + (settings.allowPrivateLan === true ? '（已勾选允许局域网明文）' : '（只允许回环地址）'))
}
if (base.protocol === 'https:') console.log('  注意     : 配置用了 https，明文网关端口会握手失败（EPROTO）')
console.log(`  端口     : ${port}${key ? '（带 Key 探测）' : '（不带 Key，401 也算端口通）'}`)
console.log('')

const results = []
for (const host of hosts) {
  const tcp = await tcpProbe(host, port)
  const shown = host.includes(':') ? `[${host}]` : host
  const parts = [`${tcp.ok ? '通' : '拒'} ${shown}:${port}`, tcp.ok ? `TCP ${tcp.ms}ms` : `TCP ${tcp.code}`]
  if (tcp.ok) {
    const web = await httpProbe(host, port)
    parts.push(web.error ? `HTTP ${web.error}` : `HTTP ${web.status}${web.note ? ' · ' + web.note : ''}`)
  }
  results.push({ host, tcp, line: '  ' + parts.join('  ') })
  console.log(results.at(-1).line)
}

console.log('')
console.log('结论提示：')
const loopback = results.filter((item) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(item.host))
const lanOpen = results.filter((item) => item.tcp.ok && !loopback.includes(item))
if (!results.some((item) => item.tcp.ok)) {
  console.log('  · 所有地址都不通：网关没在这个端口启动，或客户端把监听地址写成了别的网卡。先在客户端里确认端口与监听地址。')
} else {
  const v4 = loopback.find((item) => item.host === '127.0.0.1')
  const v6 = loopback.find((item) => item.host === '::1')
  if (v4 && !v4.tcp.ok && v6?.tcp.ok) console.log('  · 只有 IPv6 回环通：网关地址改成 http://[::1]:' + port)
  if (v6 && !v6.tcp.ok && v4?.tcp.ok) console.log('  · 只有 IPv4 回环通：地址就用 http://127.0.0.1:' + port + '（别填 localhost / [::1]）')
  if (!v4?.tcp.ok && !v6?.tcp.ok && lanOpen.length) {
    console.log('  · 回环都不通、局域网地址通：网关只绑了局域网网卡。地址填 http://' + lanOpen[0].host + ':' + port)
    console.log('    并在插件「设置 → 网关连接」里勾选「允许局域网明文地址」，否则宿主会拒绝 http + Key。')
  }
  console.log('  · HTTP 401 / 403 → 地址通了，Key 不对或没带；HTTP 200 → 回面板刷新即可。')
}
