import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
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
  const mediaFiles = new Map()
  const ctx = { tavern, credentials: { resolve: async () => ({ value: 'test-key' }) },
    attachments: {
      saveFile: async ({ data, name }) => {
        const attachmentId = 'file-' + (++count)
        const file = path.join(directory, 'blob-' + attachmentId)
        await writeFile(file, data)
        mediaFiles.set(attachmentId, file)
        return { attachmentId, name, bytes: data.length }
      },
      fileHostPath: async ref => mediaFiles.get(ref.attachmentId) ?? path.join(directory, 'blob-' + ref.attachmentId),
    } }
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
  const listed = await f.host.dispatch({ action: 'list' })
  assert.equal(listed.autoInsert, false)
  assert.equal(listed.alwaysSendPrompt, true, '提示词模板默认直接发送')
  assert.equal(listed.videosPerTurn, 3, '每回合视频段数默认 3')
  await assert.rejects(f.host.dispatch({ action: 'preferences', autoInsert: 'true' }), /布尔/)
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  const settings = JSON.parse(await readFile(path.join(f.directory, 'connection.json'), 'utf8'))
  assert.deepEqual(Object.keys(settings).sort(), ['alwaysSendPrompt', 'applyDefaults', 'autoInsert', 'baseURL', 'bindToTurn', 'generationMode', 'streamPreclaim', 'videosPerTurn'])
  f.host.dispose()
  const restored = await f.boot()
  assert.equal((await restored.dispatch({ action: 'list' })).autoInsert, true)
})

test('自动插入：旧任务的附件缺少字节数时补上真实大小，并修复已经挂到正文的空播放器', async t => {
  const f = await setup(t)
  const id = '00000000-0000-4000-8000-000000000777'
  await writeFile(path.join(f.directory, 'blob-legacy-video'), Buffer.alloc(2048, 7))
  await f.host.store.write({
    id, requestId: 'legacy-bytes', status: 'ready', model: 'h3参考',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    binding: { gameId: 'game-1', generationId },
    outputs: [], completedOutputs: [],
    attachments: [{ kind: 'video', name: 'clip.mp4', mediaType: 'video/mp4',
      attachment: { attachmentId: 'legacy-video', name: 'clip.mp4' } }],
  })
  // 这是旧版本已经插进正文的项：bytes 为 0，Tavern 会按 0 字节返回，播放器显示 0:00。
  f.items.push({
    id: 'media-legacy', gameId: 'game-1', turn: 5, textVersion: 'v1', kind: 'video', status: 'ready',
    attachment: { attachmentId: 'legacy-video', name: 'clip.mp4', bytes: 0 },
    caption: 'RunningHub · h3参考', data: { runninghubJob: id, outputIndex: 0 },
  })
  f.setResolved(binding)
  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].attachment.bytes, 2048, '必须写回真实字节数，视频才能播放')
})
