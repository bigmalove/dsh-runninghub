// 预生成视频池的纯逻辑测试：不访问网络、网关或 Tavern。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PREGEN_PLAN_BATCH,
  buildPlannerPrompt,
  buildPlannerUserMessage,
  expireStaleEntries,
  filterDuplicateVideos,
  normalizePlanVideos,
  normalizePregenSettings,
  normalizePregenState,
  normalizeRetire,
  parsePlanObject,
  pregenNeed,
  promptSimilarity,
  publicPregenState,
  reviewableEntries,
  serializePregenState,
} from '../lib/pregen.mjs'

function entry(overrides = {}) {
  return {
    id: 'pg-abcdef12',
    status: 'ready',
    description: '窗边的回头',
    createdAt: '2026-10-21T00:00:00.000Z',
    createdTurn: 2,
    attachments: [{
      kind: 'video', name: 'clip.mp4', mediaType: 'video/mp4', url: '/api/dsh-runninghub/media?id=job&index=0',
      attachment: { attachmentId: 'vid-1', name: 'clip.mp4', bytes: 12 },
    }],
    argPrompt: 'a woman turns by the window',
    ...overrides,
  }
}

test('设置：范围外回落，0 表示关闭，缺省复审开', () => {
  assert.deepEqual(normalizePregenSettings(undefined), { count: 0, perTurn: 0, maxAge: 6, review: true })
  assert.deepEqual(normalizePregenSettings({ count: 99, perTurn: -1, maxAge: 999, review: false }),
    { count: 0, perTurn: 0, maxAge: 6, review: false })
  assert.deepEqual(normalizePregenSettings({ count: 3, perTurn: 2, maxAge: 0, review: true }),
    { count: 3, perTurn: 2, maxAge: 0, review: true })
})

test('状态：读盘只留合法条目，attachment 引用只在宿主侧保留', () => {
  const state = normalizePregenState({
    settings: { count: 4 },
    entries: [
      entry(),
      { id: 'bad', status: 'ready', description: 'x' },
      { id: 'pg-bad', status: 'nope', description: 'x' },
    ],
  }, 'game-1')
  assert.equal(state.gameId, 'game-1')
  assert.equal(state.settings.count, 4)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].attachments[0].attachment.attachmentId, 'vid-1')
  const publicState = publicPregenState(state)
  assert.equal(publicState.entries[0].attachments[0].attachment, undefined, 'attachment 引用不能下发给浏览器')
  assert.equal(publicState.entries[0].attachments[0].url, '/api/dsh-runninghub/media?id=job&index=0')
  const serialized = serializePregenState(state)
  assert.equal(serialized.entries[0].attachments[0].attachment.attachmentId, 'vid-1')
  assert.equal(publicState.live, 1)
  assert.equal(publicState.ready, 1)
})

test('池子：生成中与就绪占位，目标数量决定还差几条', () => {
  const state = normalizePregenState({
    settings: { count: 3 },
    entries: [entry({ id: 'pg-aaaaaaaa', status: 'ready' }), entry({ id: 'pg-bbbbbbbb', status: 'generating' }), entry({ id: 'pg-cccccccc', status: 'used' })],
  }, 'g')
  assert.equal(pregenNeed(state), 1)
  state.settings.count = 1
  assert.equal(pregenNeed(state), 0)
})

test('过期：就绪满 N 轮退出池子，未满与 0 轮不退出', () => {
  const state = normalizePregenState({
    settings: { count: 3, maxAge: 2 },
    entries: [
      entry({ id: 'pg-aaaaaaaa', createdTurn: 2 }),
      entry({ id: 'pg-bbbbbbbb', createdTurn: 3 }),
    ],
  }, 'g')
  const expired = expireStaleEntries(state, 4, '2026-10-21T01:00:00.000Z')
  assert.deepEqual(expired.map(item => item.id), ['pg-aaaaaaaa'])
  assert.equal(state.entries[0].status, 'stale')
  assert.equal(state.entries[0].staleReason, 'age')
  assert.match(state.entries[0].staleNote, /2 轮/)
  assert.equal(state.entries[1].status, 'ready')
  state.settings.maxAge = 0
  state.entries[1].createdTurn = 0
  assert.deepEqual(expireStaleEntries(state, 99, '2026-10-21T01:00:00.000Z'), [])
})

test('复审候选只含上一轮及更早规划的就绪条目', () => {
  const state = normalizePregenState({
    entries: [
      entry({ id: 'pg-aaaaaaaa', createdTurn: 2 }),
      entry({ id: 'pg-bbbbbbbb', createdTurn: 4 }),
      entry({ id: 'pg-cccccccc', createdTurn: 1, status: 'generating' }),
    ],
  }, 'g')
  assert.deepEqual(reviewableEntries(state, 4).map(item => item.id), ['pg-aaaaaaaa'])
})

test('相似度与去重：同一提示词、相近模板不重复入池', () => {
  assert.ok(promptSimilarity('a woman turns by the window', 'a woman turns by the window') > 0.99)
  assert.ok(promptSimilarity('a woman turns by the window', 'a red car on the highway') < 0.2)
  const videos = normalizePlanVideos([
    { description: '一', prompt: 'a woman turns by the window in a white dress' },
    { description: '二', prompt: 'a woman turns by the window in a white dress with soft light' },
    { description: '三', prompt: 'a red car on the highway at night' },
  ], 3)
  const kept = filterDuplicateVideos(videos, [])
  assert.equal(kept.length, 2)
  assert.equal(kept[1].prompt, 'a red car on the highway at night')
})

test('解析：认代码块、对象、数组；坏 JSON 返回 undefined', () => {
  assert.deepEqual(parsePlanObject('```json\n{"videos":[{"description":"x","prompt":"p"}]}\n```')?.videos?.length, 1)
  assert.deepEqual(parsePlanObject('noise {"videos":[],"retire":[]} tail')?.videos, [])
  assert.equal(parsePlanObject('not json'), undefined)
  assert.equal(parsePlanObject('```json\n{bad}\n```'), undefined)
})

test('清单清洗：必填 prompt、截断描述、限制条数', () => {
  const videos = normalizePlanVideos([
    { description: '', prompt: '  a  ' },
    { description: 'x'.repeat(300), prompt: 'b' },
    { description: 'no prompt' },
    { prompt: 'c' },
  ], 2)
  assert.equal(videos.length, 2)
  assert.equal(videos[0].prompt, 'a')
  assert.equal(videos[0].description, 'a')
  assert.equal(videos[1].description.length, 120)
  assert.equal(PREGEN_PLAN_BATCH >= 2, true)
})

test('复审：只认候选 pool_id，去重并保留原因', () => {
  const candidates = [
    { id: 'pg-aaaaaaaa', description: '甲' },
    { id: 'pg-bbbbbbbb', description: '乙' },
  ]
  const retired = normalizeRetire([
    { pool_id: 'pg-aaaaaaaa', reason: '地点已经换了' },
    { pool_id: 'pg-cccccccc', reason: '编出来的 id' },
    { pool_id: 'pg-aaaaaaaa', reason: '重复' },
    'pg-bbbbbbbb',
  ], candidates)
  assert.deepEqual(retired.map(item => item.entry.id), ['pg-aaaaaaaa', 'pg-bbbbbbbb'])
  assert.equal(retired[0].reason, '地点已经换了')
  assert.match(retired[1].reason, /不再合剧情/)
})

test('规划提示词：模板、数量、复审 id 与 JSON 输出约定', () => {
  const system = buildPlannerPrompt({ alias: 'h3参考', template: 'TEMPLATE image### 生图 ### video### 视频 ###' })
  assert.match(system, /h3参考/)
  assert.match(system, /image###/)
  assert.match(system, /只输出一个 JSON 对象/)
  assert.match(system, /retire/)
  const user = buildPlannerUserMessage({
    history: '第 2 轮\n正文：她推门进来。', card: '人物卡：林岚',
    existing: [{ description: '窗边回头', status: 'ready', age: 2 }],
    review: [{ id: 'pg-aaaaaaaa', description: '浴室里', age: 3 }],
    need: 2, maxNew: 3, target: 4, turn: 5, maxAge: 6,
  })
  assert.match(user, /第 2 轮/)
  assert.match(user, /林岚/)
  assert.match(user, /pg-aaaaaaaa/)
  assert.match(user, /请写出 3 条/)
  assert.match(user, /当前是第 5 轮，池子目标 4 条/)
})
