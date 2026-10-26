import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  hasMarkerBlock,
  markerPromptSpec,
  markerRequestId,
  parseMarkerFields,
  parseMarkerShot,
  parseMarkerShots,
  scanMarkerBlocks,
  shotFingerprint,
  stripMarkerBlocks,
} from '../lib/markers.mjs'

const SINGLE = [
  '林岚推开门，雨水顺着伞沿落下。',
  '',
  '[[RH:SHOT]]',
  '@after',
  '林岚推开门，雨水顺着伞沿落下。',
  '@caption',
  '雨夜入门',
  '@prompt',
  '电影感写实照片，林岚站在雨夜的门口。',
  '[[/RH:SHOT]]',
].join('\n')

const PIPE = [
  '她走进门。',
  '',
  '[[RH:SHOT]]',
  '@after',
  '她走进门。',
  '@image',
  'Qwen 多图生图：<image1> 中的女子站在门口。',
  '@video',
  'The woman steps through the door, camera pushes in.',
  '[[/RH:SHOT]]',
].join('\n')

test('单段块解析出 @prompt / @after / @caption，并从正文移除', () => {
  const parsed = parseMarkerShots(SINGLE)
  assert.equal(parsed.found, 1)
  assert.equal(parsed.shots.length, 1)
  assert.equal(parsed.shots[0].prompt, '电影感写实照片，林岚站在雨夜的门口。')
  assert.equal(parsed.shots[0].anchor, '林岚推开门，雨水顺着伞沿落下。')
  assert.equal(parsed.shots[0].caption, '雨夜入门')
  assert.equal(parsed.shots[0].error, '')
  assert.equal(parsed.text, '林岚推开门，雨水顺着伞沿落下。')
  assert.equal(hasMarkerBlock(SINGLE), true)
  assert.equal(hasMarkerBlock('普通正文'), false)
})

test('两段式管线要求 @image + @video，并分别落到两段', () => {
  const parsed = parseMarkerShots(PIPE, { pipeline: true })
  assert.equal(parsed.shots.length, 1)
  assert.equal(parsed.shots[0].image, 'Qwen 多图生图：<image1> 中的女子站在门口。')
  assert.equal(parsed.shots[0].video, 'The woman steps through the door, camera pushes in.')
  assert.equal(parsed.shots[0].prompt, '')
  assert.equal(parsed.shots[0].error, '')
  assert.equal(parsed.text, '她走进门。')
})

test('管线缺段会给出 error，但仍清理正文', () => {
  const parsed = parseMarkerShots('正文。\n\n[[RH:SHOT]]\n@image\n只有生图\n[[/RH:SHOT]]', { pipeline: true })
  assert.equal(parsed.found, 1)
  assert.match(parsed.shots[0].error, /@image 与 @video/)
  assert.equal(parsed.text, '正文。')
})

test('单段同时写 @image 与 @video 被视为格式错误', () => {
  const shot = parseMarkerShot('@image\nA\n@video\nB')
  assert.match(shot.error, /只需要一个提示词/)
  assert.equal(shot.prompt, '')
})

test('未闭合块按到正文末尾处理，并标记 error', () => {
  const parsed = parseMarkerShots('正文。\n[[RH:SHOT]]\n@prompt\n被截断的提示词')
  assert.equal(parsed.found, 1)
  assert.match(parsed.shots[0].error, /没有闭合/)
  assert.equal(parsed.text, '正文。')
})

test('全角括号、大小写、字段冒号都能识别', () => {
  const source = '正文。\n［［rh:shot］］\n@AFTER：\n正文。\n@PROMPT:\n一段提示词\n［［/rh:shot］］'
  const parsed = parseMarkerShots(source)
  assert.equal(parsed.found, 1)
  assert.equal(parsed.shots[0].anchor, '正文。')
  assert.equal(parsed.shots[0].prompt, '一段提示词')
  assert.equal(parsed.text, '正文。')
})

test('多个块按顺序解析，limit 只提交前 N 个，其余仍移除', () => {
  const block = index => ['[[RH:SHOT]]', '@prompt', '镜头 ' + index, '[[/RH:SHOT]]'].join('\n')
  const source = ['正文。', '', block(1), '', block(2), '', block(3)].join('\n')
  const parsed = parseMarkerShots(source, { limit: 2 })
  assert.equal(parsed.found, 3)
  assert.equal(parsed.shots.length, 2)
  assert.equal(parsed.dropped, 1)
  assert.equal(parsed.shots[0].prompt, '镜头 1')
  assert.equal(parsed.shots[1].prompt, '镜头 2')
  assert.equal(parsed.text, '正文。')
})

test('@after 只取第一行，超长截到 500 字', () => {
  const long = '甲'.repeat(620)
  const parsed = parseMarkerShots(`正文。\n[[RH:SHOT]]\n@after\n${long}\n@prompt\nP\n[[/RH:SHOT]]`)
  assert.equal(parsed.shots[0].anchor.length, 500)
})

test('没有字段时把整块当单段提示词；没有入口时不改正文', () => {
  const bare = parseMarkerShots('正文。\n[[RH:SHOT]]\n一整段提示词\n[[/RH:SHOT]]')
  assert.equal(bare.shots[0].prompt, '一整段提示词')
  const untouched = '普通正文。'
  assert.equal(parseMarkerShots(untouched).text, untouched)
  assert.equal(parseMarkerShots(untouched).found, 0)
})

test('stripMarkerBlocks 不误删正文里的 @ 行', () => {
  const source = '邮件 a@b.com\n@home 是家\n正文。'
  assert.equal(stripMarkerBlocks(source, scanMarkerBlocks(source)), source)
})

test('parseMarkerFields 把同一字段的多行保留下来', () => {
  const { fields } = parseMarkerFields('@prompt\n第一行\n第二行\n@caption\n标题')
  assert.equal(fields.prompt, '第一行\n第二行')
  assert.equal(fields.caption, '标题')
})

test('markerRequestId 只跟「局 + 轮 + 提示词指纹」有关，与正文版本无关', () => {
  const fp = shotFingerprint({ prompt: '同一段提示词' })
  const a = markerRequestId({ gameId: 'g', turn: 2, fingerprint: fp })
  const b = markerRequestId({ gameId: 'g', turn: 2, fingerprint: fp })
  const other = markerRequestId({ gameId: 'g', turn: 2, fingerprint: shotFingerprint({ prompt: '另一段' }) })
  const laterTurn = markerRequestId({ gameId: 'g', turn: 3, fingerprint: fp })
  assert.equal(a, b)
  assert.notEqual(a, other)
  assert.notEqual(a, laterTurn)
  assert.match(a, /^rh-[0-9a-f]{40}$/)
  assert.ok(a.length < 128)
})

test('shotFingerprint 同一段取同一个值，忽略首尾空白，随任一段变化', () => {
  const base = shotFingerprint({ prompt: '镜头 A', image: '', video: '' })
  assert.match(base, /^[0-9a-f]{16}$/)
  assert.equal(base, shotFingerprint({ prompt: '  镜头 A  ' }))
  assert.notEqual(base, shotFingerprint({ prompt: '镜头 B' }))
  assert.notEqual(base, shotFingerprint({ prompt: '镜头 A', image: '生图段' }))
  // 解析出的镜头直接带指纹，宿主结算时不必再猜字段。
  const parsed = parseMarkerShots('正文。\n[[RH:SHOT]]\n@prompt\n镜头 A\n[[/RH:SHOT]]')
  assert.equal(parsed.shots[0].fingerprint, base)
})

test('closedOnly 只认写完的块：流式预提交不拿半截提示词去提交', () => {
  const text = [
    '正文一句。',
    '[[RH:SHOT]]',
    '@prompt',
    '写完的镜头。',
    '[[/RH:SHOT]]',
    '[[RH:SHOT]]',
    '@prompt',
    '还在写',
  ].join('\n')
  const open = parseMarkerShots(text)
  assert.equal(open.found, 2)
  assert.ok(open.shots[1].error, '未闭合块照常标 error')
  const closed = parseMarkerShots(text, { closedOnly: true })
  assert.equal(closed.found, 1)
  assert.equal(closed.shots.length, 1)
  assert.equal(closed.shots[0].prompt, '写完的镜头。')
})

test('标记块里的 &lt;Picture N&gt; 在提交前还原成尖括号', () => {
  const parsed = parseMarkerShots('正文。\n[[RH:SHOT]]\n@prompt\n&lt;Picture 1&gt; 与 &lt;Subject 1&gt;\n[[/RH:SHOT]]')
  assert.equal(parsed.shots[0].prompt, '<Picture 1> 与 <Subject 1>')
  const pipe = parseMarkerShots('正文。\n[[RH:SHOT]]\n@image\n&lt;Subject 1&gt; 的生图\n@video\n&lt;Picture 1&gt; 的视频\n[[/RH:SHOT]]',
    { pipeline: true })
  assert.equal(pipe.shots[0].image, '<Subject 1> 的生图')
  assert.equal(pipe.shots[0].video, '<Picture 1> 的视频')
})

test('markerPromptSpec 区分单段 / 管线，并写明数量和禁止工具', () => {
  const single = markerPromptSpec({ count: 3 })
  assert.match(single, /写 3 个标记块/)
  assert.match(single, /@prompt/)
  assert.match(single, /不要调用 RunningHub 的任何工具/)
  assert.equal(single.includes('@image\n生图段'), false)
  assert.match(single, /只写 @prompt/)
  assert.match(single, /不用转义/, '尖括号不再需要转义：标记块由正则整段移除')
  assert.match(single, /最末尾/)
  const pipeline = markerPromptSpec({ pipeline: true, count: 2 })
  assert.match(pipeline, /@image/)
  assert.match(pipeline, /@video/)
  assert.match(pipeline, /写 2 个标记块/)
})
