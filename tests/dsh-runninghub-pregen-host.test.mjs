// 预生成视频池的宿主集成测试：假 Tavern、假 LLM、假网关，绝不访问真实网络。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createRunningHubHost } from '../index.mjs'

const BASE = 'http://127.0.0.1:6888'
const MP4_BYTES = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 5, 6, 7, 8])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeGateway({ pipeline = null } = {}) {
  const submitted = []
  let seq = 0
  const client = {
    listWorkflows: async () => [{ alias: 'demo', revision: 'rev-1', customFields: [], referenceSlots: [], capabilities: {}, defaults: {} }],
    getSettings: async () => ({ defaultModel: 'demo' }),
    portDirective: async (alias, mode) => ({ text: `TEMPLATE ${mode}: 按模板写成品视频提示词`, mode }),
    describe: async alias => ({
      alias,
      customFields: pipeline ? [{ key: pipeline.kind === 'grid-storyboard' ? 'grid_prompt' : 'image_prompt', type: 'text' }] : [],
      referenceSlots: [], modelFields: [], capabilities: {},
      defaults: { custom: {} }, pipeline,
    }),
    submit: async (input, requestId) => {
      submitted.push({ input, requestId })
      seq += 1
      return { taskId: 'task-' + seq, accepted: 1 }
    },
    task: async () => ({ status: 'succeeded', outputs: [{ path: '/files/out/clip.mp4' }] }),
    download: async () => ({ data: MP4_BYTES, kind: 'video', mediaType: 'video/mp4', name: 'clip.mp4' }),
  }
  return { client, submitted }
}

function makeLLM(plan) {
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      const body = typeof plan === 'function' ? plan(options, calls.length) : plan
      return (async function* () {
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, calls }
}

function makeTavern(tavern) {
  return tavern
}

async function setup(t, { plan, tavernSetup, pipeline } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rh-pregen-'))
  const gateway = makeGateway({ pipeline })
  const { llm, calls: llmCalls } = makeLLM(plan ?? {
    videos: [
      { description: '窗边回头，阳光落在肩上', prompt: 'a woman turns by the window, soft sunlight' },
      { description: '走到门口停住，回头看了一眼', prompt: 'a woman pauses at the door and looks back' },
    ],
  })
  let saved = 0
  const attachments = {
    saveFile: async ({ name, data }) => ({ attachmentId: 'vid-' + (++saved), name, bytes: data.byteLength }),
    saveImage: async ({ name }) => ({ attachmentId: 'img-' + (++saved), name }),
  }
  const items = []
  const attached = []
  let generationResolved = null
  const turnState = { settled: true, busy: false, generating: false, turn: 5, textVersion: 'v5' }
  const tavern = makeTavern({
    getTurnState: async () => ({ ...turnState }),
    getTurn: async ({ gameId, turn }) => ({ gameId, turn, textVersion: turnState.textVersion, text: '她推门进来，停在窗边。' }),
    getHistory: async ({ gameId, from, to }) => {
      const rows = []
      for (let turn = from; turn <= to; turn++) rows.push({ turn, input: turn === 5 ? '她回来了。' : '', text: '第 ' + turn + ' 轮的正文，她在窗边。' })
      return rows
    },
    getCardContext: async () => ({ description: '林岚，女主。', personality: '克制', scenario: '雨夜公寓', lore: [] }),
    backgroundModel: async () => ({ provider: 'fake', model: 'planner' }),
    captureGeneration: async ({ gameId }) => ({ gameId, generationId: 'g'.repeat(64) }),
    resolveGeneration: async () => generationResolved,
    list: async () => items,
    attach: async spec => {
      const item = { ...spec, ...spec.item, id: 'media-' + (attached.length + 1) }
      items.push(item)
      attached.push(item)
      return { id: item.id }
    },
    update: async (id, changes) => Object.assign(items.find(item => item.id === id), changes),
  })
  tavernSetup?.(tavern, { turnState, setResolved(value) { generationResolved = value } })
  const ctx = {
    tavern,
    attachments,
    credentials: {
      resolve: async () => ({ value: 'test-key' }),
      set: async () => {},
      describe: async () => ({ source: 'runtime', writable: true }),
    },
  }
  const hosts = []
  const boot = async () => {
    const host = await createRunningHubHost(ctx, { dataDirectory: directory }, {
      clientFactory: () => gateway.client, pollMs: 5, reconcileMs: 60_000,
      getLLM: () => llm,
    })
    hosts.push(host)
    return host
  }
  const host = await boot()
  t.after(async () => {
    for (const instance of hosts) instance.dispose()
    await wait(30)
    await rm(directory, { recursive: true, force: true })
  })
  return {
    host, boot, directory, gateway, llmCalls, items, attached, turnState,
    setResolved(value) { generationResolved = value },
  }
}

async function until(fn, message, timeout = 3000, debug) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await wait(10)
  }
  if (debug) await debug()
  throw new Error('等待超时：' + message)
}

async function summary(host, gameId = 'game-1') {
  return host.dispatch({ action: 'list', gameId })
}

test('预生成：设置目标后在后台规划、提交、就绪并进入正文提示词', async t => {
  const f = await setup(t)
  const initial = await summary(f.host)
  assert.equal(initial.pregen.settings.count, 0)
  assert.equal(initial.pregen.entries.length, 0)

  const settings = await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 2 })
  assert.equal(settings.pregen.settings.count, 2)
  assert.equal(settings.pregen.entries.length, 0)

  const ready = await until(async () => {
    const state = (await summary(f.host)).pregen
    const entries = state.entries.filter(entry => entry.status === 'ready')
    return entries.length >= 2 ? entries : null
  }, '两条预生成视频就绪')

  assert.equal(f.gateway.submitted.length, 2)
  assert.match(f.gateway.submitted[0].input.prompt, /woman turns by the window/)
  assert.equal(f.gateway.submitted[0].input.model, 'demo')
  assert.ok(f.gateway.submitted[0].requestId.startsWith('pregen:pg-'))

  const prompt = f.host.promptText('game-1')
  assert.match(prompt, /预生成视频池/)
  for (const entry of ready) {
    assert.match(prompt, new RegExp(entry.id))
    assert.match(prompt, new RegExp(entry.description))
  }
  // 没绑定预生成池的局仍要拿到「生成前读 skill」的通用指令；只是没有池子内容。
  const otherGame = f.host.promptText('__other_game__')
  assert.match(otherGame, /runninghub-current/)
  assert.doesNotMatch(otherGame, /预生成视频池/)

  // 就绪条目可以发送到当前已结算的一轮；发送不经过网关、不新增任务。
  const before = f.gateway.submitted.length
  const sent = await f.host.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready[0].id, anchor: '她推门进来。' })
  assert.equal(sent.sent, true)
  assert.equal(sent.queued, false)
  assert.equal(f.gateway.submitted.length, before)
  assert.equal(f.attached.length, 1)
  assert.equal(f.attached[0].textVersion, 'v5')
  assert.equal(f.attached[0].anchor, '她推门进来。')
  assert.equal(f.attached[0].data.runninghubPregen, ready[0].id)
  const afterSend = (await summary(f.host)).pregen
  assert.equal(afterSend.entries.find(entry => entry.id === ready[0].id).status, 'used')
  assert.doesNotMatch(f.host.promptText('game-1'), new RegExp(ready[0].id))
})

test('预生成：正文生成中调用时排队，本轮结算后补入；正文版本确定后才落位', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 1 })
  const ready = await until(async () => {
    const entries = (await summary(f.host)).pregen.entries.filter(entry => entry.status === 'ready')
    return entries[0] ?? null
  }, '一条预生成视频就绪')
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 0 })

  f.turnState.settled = false
  f.turnState.busy = true
  f.turnState.generating = true
  f.turnState.turn = 6
  f.turnState.textVersion = 'v6'
  const sent = await f.host.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready.id, caption: '回头' })
  assert.equal(sent.queued, true)
  assert.equal(f.attached.length, 0, '正文没写完前不能落位')
  assert.equal((await summary(f.host)).pregen.entries.find(entry => entry.id === ready.id).status, 'used')

  // 正文还没结束时 resolveGeneration 返回 null：对账只等待，不重复挂。
  await f.host.handleTurn({ gameId: 'game-1', turn: 6, text: '新的正文' })
  assert.equal(f.attached.length, 0)

  f.turnState.settled = true
  f.turnState.busy = false
  f.turnState.generating = false
  f.setResolved({ gameId: 'game-1', turn: 6, textVersion: 'v6' })
  await f.host.handleTurn({ gameId: 'game-1', turn: 6, text: '新的正文' })
  assert.equal(f.attached.length, 1)
  assert.equal(f.attached[0].textVersion, 'v6')
  assert.equal(f.attached[0].caption, '回头')
})

test('预生成：池子与已用状态落盘，重启不重新生成', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 1 })
  const ready = await until(async () => {
    const entries = (await summary(f.host)).pregen.entries.filter(entry => entry.status === 'ready')
    return entries[0] ?? null
  }, '一条预生成视频就绪')
  await f.host.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready.id })
  assert.equal(f.attached.length, 1)

  f.host.dispose()
  const restored = await f.boot()
  const state = (await summary(restored)).pregen
  assert.equal(state.settings.count, 1)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].status, 'used')
  assert.equal(f.gateway.submitted.length, 1, '重启不能重新提交')
  assert.doesNotMatch(restored.promptText('game-1'), new RegExp(ready.id))
  await assert.rejects(restored.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready.id }), /已经发过/)
})

test('预生成：模型不能发送已退池子的视频，玩家手动可以', async t => {
  const f = await setup(t)
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 1 })
  const ready = await until(async () => {
    const entries = (await summary(f.host)).pregen.entries.filter(entry => entry.status === 'ready')
    return entries[0] ?? null
  }, '一条预生成视频就绪')
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 0, maxAge: 1 })
  await f.host.handleTurn({ gameId: 'game-1', turn: 6, text: '过了一轮' })
  const stale = (await summary(f.host)).pregen.entries.find(entry => entry.id === ready.id)
  assert.equal(stale.status, 'stale')
  await assert.rejects(
    f.host.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready.id, allowStale: false }),
    /退出池子/,
  )
  const sent = await f.host.dispatch({ action: 'pregen-send', gameId: 'game-1', id: ready.id })
  assert.equal(sent.sent, true)
  assert.equal(f.attached.length, 1)
})

test('预生成：整批提示词没过本地校验时带校验原文重写一次', async t => {
  const f = await setup(t, {
    pipeline: { kind: 'first-frame', imageWorkflowAlias: 'img', videoWorkflowAlias: 'vid' },
    plan: (_options, call) => call === 1
      ? { videos: [{ description: '缺标记', prompt: 'plain prompt without fences' }] }
      : { videos: [{ description: '补齐标记', prompt: 'image###\nstill frame\n###\nvideo###\ncamera moves slowly\n###' }] },
  })
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 1 })
  await until(async () => (await summary(f.host)).pregen.entries.some(entry => entry.status === 'ready'), '重写后提交就绪')
  assert.equal(f.llmCalls.length, 2, '第一次校验失败后应带校验原文重写一次')
  assert.equal(f.gateway.submitted.length, 1)
  assert.match(f.gateway.submitted[0].input.prompt, /camera moves slowly/)
  assert.match(f.gateway.submitted[0].input.custom.image_prompt, /still frame/)
})

test('预生成：后台模型缺失时记录错误且不提交；手动补池可重试', async t => {
  const f = await setup(t, {
    plan: '{"videos":[],"retire":[]}',
    tavernSetup(tavern) {
      tavern.backgroundModel = async () => null
    },
  })
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 1 })
  const state = await until(async () => {
    const pregen = (await summary(f.host)).pregen
    return pregen.lastError ? pregen : null
  }, '规划器报错')
  assert.match(state.lastError, /后台模型/)
  assert.equal(f.gateway.submitted.length, 0)
  assert.equal(state.planning, undefined)

  // 冷却期内自动触发不再调用模型；手动补池不受冷却限制。
  await f.host.handleTurn({ gameId: 'game-1', turn: 5, text: '正文' })
  assert.equal(f.llmCalls.length, 0)
  await f.host.dispatch({ action: 'pregen-refill', gameId: 'game-1' })
  assert.equal(f.llmCalls.length, 0)
})

test('预生成：模型输出被解析为多条，重复提示词不会重复提交', async t => {
  const f = await setup(t, {
    plan: {
      videos: [
        { description: 'A', prompt: 'same woman by the same window in the rain' },
        { description: 'B', prompt: 'same woman by the same window in the rain' },
        { description: 'C', prompt: 'a close-up of her eyes looking away' },
      ],
    },
  })
  await f.host.dispatch({ action: 'pregen-settings', gameId: 'game-1', count: 3 })
  await until(async () => (await summary(f.host)).pregen.entries.filter(entry => entry.status === 'ready').length >= 2, '两条就绪')
  assert.equal(f.gateway.submitted.length, 2, '同一批里相似提示词只提交一次')
})
