import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunningHubHost } from '../index.mjs'

const generationId = 'a'.repeat(64)
const binding = { gameId: 'game-1', turn: 5, textVersion: 'v1' }
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rh-insertion-'))
  const items = [], calls = [], hosts = []
  let resolved = null, remoteReady = false, broken = false, count = 0
  const tavern = {
    captureGeneration: async ({ gameId }) => ({ gameId, generationId }),
    resolveGeneration: async () => resolved,
    list: async ({ gameId, turn }) => items.filter(item => item.gameId === gameId && item.turn === turn),
    attach: async spec => {
      if (broken) throw new Error('insertion unavailable')
      const item = { ...spec, ...spec.item, id: 'media-' + items.length }
      items.push(item)
      return { id: item.id }
    },
    update: async (id, value) => Object.assign(items.find(item => item.id === id), value),
  }
  const ctx = { tavern, credentials: { resolve: async () => ({ value: 'test-key' }) },
    attachments: { saveFile: async ({ data, name }) => ({ attachmentId: 'file-' + (++count), name, bytes: data.length }) } }
  const client = {
    describe: async model => ({ alias: model, customFields: [], referenceSlots: [], capabilities: {}, modelFields: [], defaults: {} }),
    listWorkflows: async () => [],
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
    setReady() { remoteReady = true }, setBroken(value) { broken = value } }
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
  assert.deepEqual(Object.keys(settings).sort(), ['autoInsert', 'baseURL'])
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
