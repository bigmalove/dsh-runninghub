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
  assert.equal(listed.enabled, true, '插件总开关默认开启')
  assert.equal(listed.autoInsert, false)
  assert.equal(listed.insertPosition, 'inline', '插入位置默认在剧情正文间')
  assert.equal(listed.alwaysSendPrompt, true, '提示词模板默认直接发送')
  assert.equal(listed.videosPerTurn, 3, '每回合视频段数默认 3')
  await assert.rejects(f.host.dispatch({ action: 'preferences', enabled: 'false' }), /布尔/)
  await assert.rejects(f.host.dispatch({ action: 'preferences', autoInsert: 'true' }), /布尔/)
  await assert.rejects(f.host.dispatch({ action: 'preferences', insertPosition: 'top' }), /inline 或 end/)
  await f.host.dispatch({ action: 'preferences', autoInsert: true, insertPosition: 'end' })
  const settings = JSON.parse(await readFile(path.join(f.directory, 'connection.json'), 'utf8'))
  assert.deepEqual(Object.keys(settings).sort(), ['allowPrivateLan', 'alwaysSendPrompt', 'applyDefaults', 'autoInsert', 'baseURL', 'bindToTurn', 'enabled', 'generationMode', 'insertPosition', 'streamPreclaim', 'videosPerTurn'])
  f.host.dispose()
  const restored = await f.boot()
  const restoredList = await restored.dispatch({ action: 'list' })
  assert.equal(restoredList.enabled, true)
  assert.equal(restoredList.autoInsert, true)
  assert.equal(restoredList.insertPosition, 'end')
})

test('自动插入：正文版本尚未解析时不把终态媒体误记为已对账', async t => {
  const f = await setup(t)
  const id = '00000000-0000-4000-8000-000000000776'
  await f.host.store.write({
    id, requestId: 'pending-generation-resolution', status: 'ready', model: 'h3参考',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    binding: { gameId: 'game-1', generationId },
    outputs: [], completedOutputs: [],
    attachments: [{ kind: 'video', name: 'clip.mp4', mediaType: 'video/mp4',
      attachment: { attachmentId: 'pending-video', name: 'clip.mp4', bytes: 10 } }],
  })

  await f.host.reconcile()
  assert.equal(f.items.length, 0, '正文还没写完时不应落位')

  f.setResolved(binding)
  await f.host.reconcile()
  assert.equal(f.items.length, 1, '正文版本解析后必须重试并挂入媒体')
  assert.equal(f.items[0].kind, 'video')
  assert.equal(f.items[0].attachment.attachmentId, 'pending-video')
})

test('自动插入：正文版本键变化后，定位句仍在时迁移到当前版本', async t => {
  const f = await setup(t, { turnState: { turn: 5, textVersion: 'v2', settled: true, busy: false } })
  const id = '00000000-0000-4000-8000-000000000775'
  await writeFile(path.join(f.directory, 'bindings', id + '.json'), JSON.stringify({
    gameId: 'game-1', turn: 5, textVersion: 'v1', anchor: '正文',
  }))
  await f.host.store.write({
    id, requestId: 'current-version-binding', status: 'ready', model: 'h3参考',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    binding: { gameId: 'game-1', turn: 5, textVersion: 'v1', pending: true, anchor: '正文' },
    outputs: [], completedOutputs: [],
    attachments: [{ kind: 'image', name: 'current.png', mediaType: 'image/png',
      attachment: { attachmentId: 'current-image', mediaType: 'image/webp', width: 1, height: 1, bytes: 10 } }],
  })

  await f.host.reconcile()
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].textVersion, 'v2', '媒体必须挂到 Tavern 当前实际显示的版本')
  const saved = JSON.parse(await readFile(path.join(f.directory, 'bindings', id + '.json'), 'utf8'))
  assert.equal(saved.textVersion, 'v2', '后续重试与重启都应沿用已刷新的版本')
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

test('自动插入：本轮正文正在写、已经能读到占位正文时，本轮结算就该落位（不再多等一轮）', async t => {
  const f = await setup(t, { legacyHost: true, turnState: { turn: 5, textVersion: 'v1', settled: false, busy: true } })
  await f.host.dispatch({ action: 'preferences', autoInsert: true })
  await f.host.dispatch({ action: 'select-model', model: 'h3参考' })
  const id = '00000000-0000-4000-8000-000000000778'
  const job = await f.submit(id, { anchor: '正文' })
  assert.equal(job.binding.pending, true)
  assert.equal(job.binding.afterTurn, 4, '第 5 轮还在写：第 5 轮结算时必须落位')

  f.setTurnState({ turn: 5, textVersion: 'v1', settled: true, busy: false })
  await f.host.handleTurn({ gameId: 'game-1', turn: 5, textVersion: 'v1', text: '正文', rawText: '正文' })
  assert.equal(f.items.length, 1, '本轮结算就该把刚生成的媒体挂进正文')
})

test('插入位置：切到每轮生成尾部时忽略 anchor，切回正文间时恢复 anchor', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'preferences', autoInsert: true, insertPosition: 'end' })
  await f.host.dispatch({ action: 'select-model', model: 'h3参考' })
  const endJob = await f.submit('00000000-0000-4000-8000-000000000779', { anchor: '正文中间一句' })
  assert.equal(endJob.binding.anchor, '', '尾部模式应忽略模型传入的 anchor')

  await f.host.dispatch({ action: 'preferences', insertPosition: 'inline' })
  const inlineJob = await f.submit('00000000-0000-4000-8000-000000000780', { anchor: '正文中间一句' })
  assert.equal(inlineJob.binding.anchor, '正文中间一句', '正文间模式应保留 anchor')

  f.setResolved(binding)
  await f.host.reconcile()
  assert.equal(f.items.length, 2)
  assert.equal(f.items.find(item => item.data?.runninghubJob === endJob.id).anchor, '')
  assert.equal(f.items.find(item => item.data?.runninghubJob === inlineJob.id).anchor, '正文中间一句')
})
