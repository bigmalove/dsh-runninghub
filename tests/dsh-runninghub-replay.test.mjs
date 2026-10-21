import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';

import { ReplayStore } from '../lib/replay.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'rh-replay-'));
  roots.push(root);
  const store = new ReplayStore({ directory: join(root, 'replays') });
  await store.init();
  return { root, store };
}

const sample = () => ({
  model: 'demo',
  prompt: '  原样提示词\n第二行  ',
  apply_defaults: true,
  duration_seconds: 5,
  resolution: { aspect_ratio: '9:16' },
  custom: { quality: 2, stabilize: true },
  references: [
    { nodeId: 'image-ref', name: '主角.png', mimeType: 'image/png', data: PNG.toString('base64'), note: '主角参考' },
    { nodeId: 'audio-ref', note: '只留备注' },
  ],
});

test('可重放输入：提示词、参数与参考素材完整往返，参考内容不写进 JSON', async () => {
  const { root, store } = await makeStore();
  const input = sample();
  await store.save(ID, input);
  assert.equal(store.has(ID), true, '保存后立即可重放');
  assert.equal(store.has(ID2), false);
  assert.deepEqual(await store.load(ID), input);

  const raw = await readFile(join(root, 'replays', ID, 'input.json'), 'utf8');
  assert.match(raw, /原样提示词/);
  assert.equal(raw.includes(PNG.toString('base64')), false, '参考素材以二进制 blob 保存，JSON 里不能有 base64');
  const doc = JSON.parse(raw);
  assert.equal(doc.input.references, undefined, '任务快照的输入部分不含 references 字段');
  assert.ok(doc.references[0].blob, '参考素材指向内容哈希');
  assert.equal(doc.references[1].blob, undefined, '只有备注的槽位不产生 blob');

  const dirInfo = await stat(join(root, 'replays', ID));
  const fileInfo = await stat(join(root, 'replays', ID, 'input.json'));
  assert.equal(dirInfo.mode & 0o777, 0o700, '快照目录仅宿主可读');
  assert.equal(fileInfo.mode & 0o777, 0o600, '快照文件仅宿主可读写');
});

test('可重放输入：同一参考素材跨任务按内容哈希共享，复制快照不重复占盘', async () => {
  const { root, store } = await makeStore();
  const input = sample();
  await store.save(ID, input);
  await store.save(ID2, input);
  const blobs = await readdir(join(root, 'replays', 'blobs'));
  assert.equal(blobs.length, 1, '相同参考素材只保存一份');

  await store.copy(ID, '33333333-3333-4333-8333-333333333333');
  assert.equal(store.has('33333333-3333-4333-8333-333333333333'), true);
  assert.deepEqual(await store.load('33333333-3333-4333-8333-333333333333'), input);
  assert.equal((await readdir(join(root, 'replays', 'blobs'))).length, 1, '复制只新增元数据，不复制素材');
});

test('可重放输入：缺少快照返回 null，损坏快照报 STORE_ERROR', async () => {
  const { root, store } = await makeStore();
  assert.equal(await store.load(ID), null);

  await store.save(ID, sample());
  await writeFile(join(root, 'replays', ID, 'input.json'), '{broken');
  await assert.rejects(store.load(ID), error => error.code === 'STORE_ERROR');
});

test('可重放输入：id 必须是 UUID，未知字段不会落盘', async () => {
  const { store } = await makeStore();
  await assert.rejects(store.save('../evil', sample()), error => error.code === 'VALIDATION_ERROR');
  assert.equal(await store.load('../evil').catch(() => 'rejected'), 'rejected');

  const input = { ...sample(), apiKey: 'must-not-persist', references: [] };
  await store.save(ID, input);
  const loaded = await store.load(ID);
  assert.equal('apiKey' in loaded, false);
  assert.deepEqual(loaded, {
    model: input.model, prompt: input.prompt, apply_defaults: true, duration_seconds: 5,
    resolution: { aspect_ratio: '9:16' }, custom: { quality: 2, stabilize: true },
  });
});
