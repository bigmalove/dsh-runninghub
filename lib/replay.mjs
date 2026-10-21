import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { GatewayError } from './client.mjs';

// 可重放输入：任务历史里「重新生成」需要的提示词、参数与参考素材。
// 任务记录本身仍然只存状态；这里按任务 id 单独落盘，参考素材按内容哈希去重。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOB = /^[0-9a-f]{64}\.bin$/;
const JSON_LIMIT = 4 * 1024 * 1024;
const REF_LIMIT = 10 * 1024 * 1024;
const TOTAL_REF_LIMIT = 25 * 1024 * 1024;
const BASE_KEYS = ['model', 'prompt', 'resolution', 'custom', 'duration_seconds', 'apply_defaults'];
const REF_KEYS = ['name', 'mimeType', 'enable', 'note'];

function invalid(message) {
  return new GatewayError(message, { code: 'VALIDATION_ERROR', rejected: true });
}

function storeError(message = '可重放输入读写失败') {
  return new GatewayError(message, { code: 'STORE_ERROR' });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('任务 id 必须是 UUID');
  return value.toLowerCase();
}

async function readNoFollow(file, limit) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw storeError('可重放输入超过大小限制或不是普通文件');
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAtomic(file, content) {
  const temp = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}

function copyBaseInput(input) {
  if (!isObject(input)) throw invalid('可重放输入必须是对象');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) throw invalid('可重放输入缺少工作流');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw invalid('可重放输入缺少提示词');
  const base = {};
  for (const key of BASE_KEYS) {
    if (input[key] === undefined) continue;
    base[key] = structuredClone(input[key]);
  }
  if (base.resolution !== undefined && !isObject(base.resolution)) throw invalid('可重放分辨率无效');
  if (base.custom !== undefined && !isObject(base.custom)) throw invalid('可重放自定义参数无效');
  if (base.duration_seconds !== undefined && (typeof base.duration_seconds !== 'number' || !Number.isFinite(base.duration_seconds))) throw invalid('可重放片长无效');
  if (base.apply_defaults !== undefined && typeof base.apply_defaults !== 'boolean') throw invalid('可重放默认值开关无效');
  return base;
}

export class ReplayStore {
  #directory;
  #initializing;
  #ids = new Set();

  constructor({ directory }) {
    if (typeof directory !== 'string' || !directory.trim()) throw storeError('必须由宿主指定可重放输入目录');
    this.#directory = resolve(directory);
  }

  get directory() { return this.#directory; }

  async init() {
    this.#initializing ??= (async () => {
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(this.#directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        await mkdir(join(this.#directory, 'blobs'), { recursive: true, mode: 0o700 });
        for (const name of await readdir(this.#directory)) {
          if (!UUID.test(name)) continue;
          try {
            const info = await lstat(join(this.#directory, name, 'input.json'));
            if (info.isFile() && !info.isSymbolicLink() && info.size <= JSON_LIMIT) this.#ids.add(name.toLowerCase());
          } catch { /* 未提交完成的目录不是可重放输入 */ }
        }
      } catch {
        throw storeError('可重放输入目录不可用');
      }
      return this;
    })();
    return this.#initializing;
  }

  /** 同步判断是否有可重放快照；仅用于状态列表，不在磁盘上逐条探测。 */
  has(id) {
    try { return this.#ids.has(validateId(id)); } catch { return false; }
  }

  async #ensureDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError('可重放输入目录不可用');
  }

  async #writeBlob(hash, bytes) {
    const blobs = join(this.#directory, 'blobs');
    const target = join(blobs, hash + '.bin');
    try {
      await lstat(target);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw storeError();
    }
    const temp = join(blobs, '.' + hash + '.' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, target);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }

  async #prepareReferences(references) {
    if (references === undefined) return [];
    if (!Array.isArray(references) || references.length > 64) throw invalid('参考素材最多 64 项');
    const result = [];
    let total = 0;
    for (const reference of references) {
      if (!isObject(reference) || typeof reference.nodeId !== 'string' || !reference.nodeId) throw invalid('参考素材项无效');
      const meta = { nodeId: reference.nodeId };
      for (const key of REF_KEYS) {
        if (reference[key] === undefined) continue;
        const expected = key === 'enable' ? 'boolean' : 'string';
        if (typeof reference[key] !== expected) throw invalid('参考素材元数据无效');
        meta[key] = reference[key];
      }
      if (typeof reference.data === 'string' && reference.data) {
        const bytes = Buffer.from(reference.data, 'base64');
        if (!bytes.length || bytes.length > REF_LIMIT) throw invalid('参考素材超过单张 10MB 限制');
        total += bytes.length;
        if (total > TOTAL_REF_LIMIT) throw invalid('参考素材总大小不能超过 25MB');
        if (!meta.mimeType) throw invalid('参考素材缺少 MIME');
        const hash = createHash('sha256').update(bytes).digest('hex');
        await this.#writeBlob(hash, bytes);
        meta.blob = hash + '.bin';
      }
      result.push(meta);
    }
    return result;
  }

  /** 保存一次提交的完整可重放输入；重复保存同一任务会覆盖快照。 */
  async save(rawId, input) {
    const id = validateId(rawId);
    await this.init();
    const base = copyBaseInput(input);
    const references = await this.#prepareReferences(input.references);
    const directory = join(this.#directory, id);
    await this.#ensureDirectory(directory);
    const content = JSON.stringify({ version: 1, id, savedAt: new Date().toISOString(), input: base, references });
    if (Buffer.byteLength(content) > JSON_LIMIT) throw storeError('可重放输入超过大小限制');
    // JSON 最后提交：中途崩溃不会留下指向缺失素材的半成品快照。
    await writeAtomic(join(directory, 'input.json'), content);
    this.#ids.add(id);
  }

  /** 读回可重放输入；快照不存在时返回 null，损坏时抛错。 */
  async load(rawId) {
    const id = validateId(rawId);
    await this.init();
    let raw;
    try {
      raw = await readNoFollow(join(this.#directory, id, 'input.json'), JSON_LIMIT);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#ids.delete(id);
        return null;
      }
      throw error instanceof GatewayError ? error : storeError();
    }
    let doc;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { throw storeError('可重放输入已损坏'); }
    if (!isObject(doc) || doc.version !== 1 || doc.id !== id || !isObject(doc.input)) throw storeError('可重放输入已损坏');
    let input;
    try { input = copyBaseInput(doc.input); } catch { throw storeError('可重放输入已损坏'); }
    if (!Array.isArray(doc.references) || doc.references.length > 64) throw storeError('可重放输入已损坏');
    const references = [];
    let total = 0;
    for (const meta of doc.references) {
      if (!isObject(meta) || typeof meta.nodeId !== 'string' || !meta.nodeId) throw storeError('可重放输入已损坏');
      const reference = { nodeId: meta.nodeId };
      for (const key of REF_KEYS) {
        if (meta[key] === undefined) continue;
        const expected = key === 'enable' ? 'boolean' : 'string';
        if (typeof meta[key] !== expected) throw storeError('可重放输入已损坏');
        reference[key] = meta[key];
      }
      if (meta.blob !== undefined) {
        if (typeof meta.blob !== 'string' || !BLOB.test(meta.blob) || !reference.mimeType) throw storeError('可重放输入已损坏');
        let bytes;
        try { bytes = await readNoFollow(join(this.#directory, 'blobs', meta.blob), REF_LIMIT); }
        catch { throw storeError('可重放参考素材缺失'); }
        total += bytes.length;
        if (total > TOTAL_REF_LIMIT) throw storeError('可重放输入超过大小限制');
        reference.data = bytes.toString('base64');
      }
      references.push(reference);
    }
    if (references.length) input.references = references;
    return input;
  }

  /** 为新任务复制一份快照；素材 blob 按内容哈希共享，不会重复占盘。 */
  async copy(rawFrom, rawTo) {
    const input = await this.load(rawFrom);
    if (!input) throw storeError('原任务没有可重放的输入');
    await this.save(rawTo, input);
  }
}
