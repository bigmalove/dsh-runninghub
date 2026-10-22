import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunningHubHost } from '../index.mjs'

const generationId = 'a'.repeat(64)
const binding = { gameId: 'game-1', turn: 5, textVersion: 'v1' }
async function setup(t, { legacyHost = false, turnState: initialTurnState } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rh-insertion-'))
  const items = [], calls = [], hosts = []
  let resolved = null, remoteReady = false, broken = false, count = 0
  let turnState = initialTurnState ?? { turn: 5, textVersion: 'v1', settled: true, busy: false }
  const tavern = {
    captureGeneration: async ({ gameId }) => ({ gameId, generationId }),
    resolveGeneration: async () => resolved,
    getTurnState: async ({ gameId }) => ({ gameId, ...turnState }),
    getTurn: async ({ gameId, turn }) => ({ gameId, turn, textVersion: turnState.textVersion, text: '正文' }),
    onTurnSettled: () => () => {},
    list: async ({ gameId, turn }) => items.filter(item => item.gameId === gameId && item.turn === turn),
    attach: async spec => {
      if (broken) throw new Error('insertion unavailable')
      const item = { ...spec, ...spec.item, id: 'media-' + items.length }
      items.push(item)
      return { id: item.id }
    },
    update: async (id, value) => Object.assign(items.find(item => item.id === id), value),
  }
  if (legacyHost) delete tavern.captureGeneration
  const ctx = { tavern, credentials: { resolve: async () => ({ value: 'test-key' }) },
    attachments: { saveFile: async ({ data, name }) => ({ attachmentId: 'file-' + (++count), name, bytes: data.length }) } }
  const client = {
    describe: async model => ({ alias: model, customFields: [], referenceSlots: [], capabilities: {}, modelFields: [], defaults: {} }),
    listWorkflows: async () => [{ alias: 'h3参考', revision: 'rev-test', customFields: [], referenceSlots: [], capabilities: {}, defaults: {} }],
    portDirective: async (alias, mode) => ({ text: `template:${mode}`, mode }),
    submit: async (_input, id) => { calls.push(id); return { taskId: 'task-' + id, accepted: 1 } },
    task: async () => remoteReady ? { status: 'succeeded', outputs: [{ path: '/files/clip.mp4' }] } : { status: 'running' },
    download: async () => ({ data: Buffer.from('test video'), kind: 'video', mediaType: 'video/mp4', name: 'clip.mp4' }),
  }
  async function boot() {
    const host = await createRunningHubHost(ctx, { dataDirectory: directory }, { clientFactory: () => client, pollMs: 10, reconcileMs: 60000 })
    hosts.push(host)
    return host
  }
  const host = await boot()
  t.after(async () => {
    for (const instance of hosts) instance.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    await rm(directory, { recursive: true, force: true })
  })
  const exec = { agent: { session: { id: 'game-1' } } }
  const submit = (id, extra = {}) => host.dispatch({ action: 'submit', requestId: id, input: { model: 'h3参考', prompt: 'scene' }, bindToTurn: false, ...extra }, exec)
  return { host, boot, exec, submit, items, calls, directory, setResolved(value) { resolved = value },
    setReady() { remoteReady = true }, setBroken(value) { broken = value },
    setTurnState(value) { turnState = value } }
}
async function until(host, id, status) {
  for (let step = 0; step < 200; step++) {
    const job = await host.store.read(id)
    if (job.status === status) return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not reach ' + status)
}

test('自动插入：默认关闭、严格布尔校验、持久化且不写Key', async t => {
  const f = await setup(t)
  assert.equal((await f.host.dispatch({ action: 'list' })).autoInsert, false)
  await assert.rejects(f.host.dispatch({ action: 'preferences', autoInsert: 'true' }), /布尔/)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  const settings = JSON.parse(await readFile(path.join(f.directory, 'connection.json'), 'utf8'))
  assert.deepEqual(Object.keys(settings).sort(), ['applyDefaults', 'autoInsert', 'baseURL', 'bindToTurn'])
  f.host.dispose()
  const restored = await f.boot()
  assert.equal((await restored.dispatch({ action: 'list' })).autoInsert, true)
})

test('自动插入：三单先提交，正文尚无映射时保持独立，结算后插入占位再完成', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  const jobs = []
  for (let index = 0; index < 3; index++) jobs.push(await f.submit('scene-' + index, { anchor: '场景' + index + '。' }))
  for (const job of jobs) await until(f.host, job.id, 'running')
  assert.equal(f.calls.length, 3)
  assert.equal(f.items.length, 0)
  f.setResolved(binding)
  await f.host.reconcile()
  assert.equal(f.items.length, 3)
  assert.deepEqual(f.items.map(item => item.anchor), ['场景0。', '场景1。', '场景2。'])
  assert.ok(f.items.every(item => item.status === 'pending'))
  f.setReady()
  for (const job of jobs) await until(f.host, job.id, 'ready')
  await f.host.reconcile()
  assert.equal(f.items.length, 3)
  assert.ok(f.items.every(item => item.status === 'ready' && item.kind === 'video' && item.textVersion === 'v1'))
})

test('自动插入：正文在一次对账途中结算时，后两单不能抢先插入', async t => {
  const f = await setup(t)
  const id = index => '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
  for (let index = 0; index < 3; index++) await f.host.store.write({
    id: id(index), requestId: 'settling-pass-' + index, status: 'ready', model: 'h3参考',
    createdAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString(),
    binding: { gameId: 'game-1', generationId, anchor: '场景' + index + '。' },
  })
  // Make the mapping appear immediately after the first resolve read returns null.
  let reads = 0
  // A fixture hook at the resolver boundary deterministically reproduces the race.
  const ctx = {
    credentials: { resolve: async () => null },
    tavern: {
      resolveGeneration: async () => ++reads === 1 ? null : binding,
      list: async () => f.items,
      attach: async spec => { f.items.push({ ...spec, ...spec.item, id: 'attached-' + f.items.length }) },
      update: async () => {},
    },
  }
  f.host.dispose()
  const isolated = await createRunningHubHost(ctx, { dataDirectory: f.directory }, { reconcileMs: 60000 })
  t.after(() => isolated.dispose())
  await isolated.reconcile()
  assert.equal(reads, 1, '同一生成在单次对账中只解析一次，即使返回空')
  assert.equal(f.items.length, 0)
  await isolated.reconcile()
  assert.deepEqual(f.items.map(item => item.anchor), ['场景0。', '场景1。', '场景2。'])
})

test('自动插入：视频先完成，正文后完成，同ID重试不改绑', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  f.setReady()
  const job = await f.submit('early-video')
  const saved = await until(f.host, job.id, 'ready')
  assert.equal(saved.binding.generationId, generationId)
  assert.equal(f.items.length, 0)
  f.setResolved(binding)
  await f.host.reconcile()
  const retry = await f.submit('early-video', { gameId: 'other-game' })
  assert.equal(retry.id, job.id)
  assert.equal(retry.binding.gameId, 'game-1')
  assert.equal(f.calls.length, 1)
  assert.equal(f.items.length, 1)
})

test('自动插入：关闭只影响新任务，重启恢复不重新生成', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  f.setReady()
  const job = await f.submit('restore-job')
  await until(f.host, job.id, 'ready')
  await f.host.dispatch({ action: 'preferences', autoInsert: false })
  f.host.dispose()
  const restored = await f.boot()
  f.setResolved(binding)
  await restored.resume()
  await restored.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.calls.length, 1)
  assert.equal((await restored.dispatch({ action: 'list' })).autoInsert, false)
})

test('自动插入：已固定版本不跟随重新生成或编辑', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  const job = await f.submit('pin-version')
  f.setResolved(binding)
  await f.host.reconcile()
  f.setResolved({ ...binding, textVersion: 'v2' })
  f.setReady()
  await until(f.host, job.id, 'ready')
  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].textVersion, 'v1')
})

test('自动插入：插入失败独立于下载，重试只插入不再生成或保存视频', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  f.setReady(); f.setResolved(binding); f.setBroken(true)
  const job = await f.submit('insertion-error')
  const saved = await until(f.host, job.id, 'ready')
  assert.equal(saved.attachments.length, 1)
  const summary = await f.host.dispatch({ action: 'list' })
  assert.match(summary.jobs[0].insertionError, /unavailable/)
  f.setBroken(false)
  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].attachment.attachmentId, saved.attachments[0].attachment.attachmentId)
  assert.equal(f.calls.length, 1)
})

test('自动插入：工具会话优先，拒绝伪造game_id和缺失核心支持', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  await assert.rejects(f.submit('wrong-game', { gameId: 'other-game' }), /不一致/)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.host.store.list()).length, 0)
})

test('自动插入：旧宿主没有生成身份接口时，正文写完再绑定这一轮', async t => {
  const f = await setup(t, { legacyHost: true, turnState: { turn: 5, textVersion: 'v5', settled: false, busy: true } })
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  const job = await f.submit('legacy-pending', { anchor: '场景。' })
  const running = await until(f.host, job.id, 'running')
  assert.equal(running.binding.pending, true)
  assert.equal(running.binding.afterTurn, 5)
  await f.host.reconcile()
  assert.equal(f.items.length, 0, '正文结算前不能挂到上一轮')
  await f.host.handleTurn({ gameId: 'game-1', turn: 5, textVersion: 'v5', text: '旧的正文' })
  assert.equal(f.items.length, 0, '不能挂到提交前就已经存在的轮次')
  await f.host.handleTurn({ gameId: 'game-1', turn: 6, textVersion: 'v6', text: '新的正文' })
  const frozen = JSON.parse(await readFile(path.join(f.directory, 'bindings', job.id + '.json'), 'utf8'))
  assert.equal(frozen.turn, 6)
  assert.equal(frozen.textVersion, 'v6')
  assert.equal(frozen.anchor, '场景。')
  assert.equal(f.items.length, 1, '成片还没下载时先挂占位，锁住这一版正文')
  assert.equal(f.items[0].turn, 6)
  assert.equal(f.items[0].textVersion, 'v6')
  assert.equal(f.items[0].anchor, '场景。')
  assert.equal(f.items[0].status, 'pending')
  f.setReady()
  const saved = await until(f.host, job.id, 'ready')
  assert.equal(saved.attachments.length, 1)
  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].status, 'ready')
  assert.equal(f.items[0].attachment.attachmentId, saved.attachments[0].attachment.attachmentId)
  assert.equal(f.calls.length, 1)
})

test('自动插入：旧宿主当前轮已结算时直接绑定，不必等下一轮', async t => {
  const f = await setup(t, { legacyHost: true, turnState: { turn: 5, textVersion: 'v1', settled: true, busy: false } })
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  f.setReady()
  const job = await f.submit('legacy-settled')
  const saved = await until(f.host, job.id, 'ready')
  assert.equal(saved.binding.turn, 5)
  assert.equal(saved.binding.pending, undefined)
  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].textVersion, 'v1')
})
