import { constants } from 'node:fs';
import { mkdir, lstat, readdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayError, sanitizeMessage, validateRequestId } from './client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['preparing', 'submitting', 'submit_unknown', 'queued', 'running', 'downloading', 'ready', 'failed', 'download_failed']);
const JOB_LIMIT = 2 * 1024 * 1024;
const JOB_FIELDS = new Set([
  'id', 'requestId', 'status', 'model', 'binding', 'createdAt', 'updatedAt',
  'remoteTaskId', 'gatewayRemoteTaskId', 'remoteStatus', 'accepted', 'deduplicated',
  'outputs', 'attachments', 'completedOutputs', 'error', 'queryError',
  'costCoins', 'costRewardCoins', 'progress', 'pipelineStage',
]);
const SECRET_FIELD = /(?:api[_-]?key|token|secret|password|cookie|authorization|credential|account|session|base64|b64|workflow|prompt|^input$|^data$|^bytes$|^buffer$|__proto__|^constructor$|^prototype$)/i;

export function validateJobId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new GatewayError('本地任务 id 必须是 UUID', { code: 'VALIDATION_ERROR', rejected: true });
  return id;
}

function publicValue(value, depth = 0) {
  if (depth > 16) throw new GatewayError('公开附件结构过深', { code: 'STORE_ERROR' });
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (/data:[^;,]*;base64,/i.test(value) || value.length > 16384 || value.length >= 512 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
    // 附件资源地址可以保留；携带认证信息的 URL 不写入公开记录。
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_FIELD.test(key))) return undefined;
      } catch { return undefined; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => publicValue(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const cleaned = publicValue(item, depth + 1);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function publicJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new GatewayError('任务记录无效', { code: 'STORE_ERROR' });
  validateJobId(job.id);
  validateRequestId(job.requestId);
  if (!STATUSES.has(job.status)) throw new GatewayError('任务状态无效', { code: 'STORE_ERROR' });
  const result = {};
  for (const key of JOB_FIELDS) {
    if (job[key] === undefined) continue;
    if (key === 'binding') {
      result.binding = {};
      for (const name of ['gameId', 'turn', 'textVersion', 'mediaId', 'generationId', 'anchor']) {
        const value = job.binding?.[name];
        if (['string', 'number', 'boolean'].includes(typeof value)) {
          const cleaned = publicValue(value);
          if (cleaned !== undefined) result.binding[name] = cleaned;
        }
      }
    } else if (key === 'error' || key === 'queryError') {
      result[key] = sanitizeMessage(job[key]);
    } else {
      const cleaned = publicValue(job[key]);
      if (cleaned !== undefined) result[key] = cleaned;
    }
  }
  result.outputs ??= [];
  result.attachments ??= [];
  result.completedOutputs ??= [];
  if (![result.outputs, result.attachments, result.completedOutputs].every(Array.isArray)) throw new GatewayError('任务附件记录无效', { code: 'STORE_ERROR' });
  return result;
}

function clone(job) { return structuredClone(job); }

export class TaskStore {
  #directory;
  #initializing;
  #writes = new Map();

  constructor({ directory }) {
    if (typeof directory !== 'string' || !directory.trim()) throw new GatewayError('必须由宿主指定任务目录', { code: 'STORE_ERROR' });
    this.#directory = resolve(directory);
  }

  get directory() { return this.#directory; }

  async init() {
    this.#initializing ??= (async () => {
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(this.#directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      } catch { throw new GatewayError('任务目录不可用', { code: 'STORE_ERROR' }); }
      return this;
    })();
    return this.#initializing;
  }

  async read(id) {
    validateJobId(id);
    await this.init();
    let file;
    try {
      file = await open(join(this.#directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > JOB_LIMIT) throw new Error();
      const job = publicJob(JSON.parse(await file.readFile('utf8')));
      if (job.id !== id) throw new Error();
      return job;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new GatewayError('任务记录读取失败', { code: 'STORE_ERROR' });
    } finally { await file?.close().catch(() => {}); }
  }

  async list() {
    await this.init();
    let files;
    try { files = await readdir(this.#directory); } catch { throw new GatewayError('任务列表读取失败', { code: 'STORE_ERROR' }); }
    const jobs = [];
    for (const name of files.sort()) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      const job = await this.read(name.slice(0, -5));
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }

  async write(job) {
    const safe = publicJob(job);
    const content = JSON.stringify(safe);
    if (Buffer.byteLength(content) > JOB_LIMIT) throw new GatewayError('任务记录超过大小限制', { code: 'STORE_ERROR' });
    const previous = this.#writes.get(safe.id) ?? Promise.resolve();
    const writing = previous.catch(() => {}).then(async () => {
      await this.init();
      const temp = join(this.#directory, `.${safe.id}.${randomUUID()}.tmp`);
      let file;
      let created = false;
      try {
        file = await open(temp, 'wx', 0o600);
        created = true;
        await file.writeFile(content, 'utf8');
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temp, join(this.#directory, `${safe.id}.json`));
        created = false;
        return clone(safe);
      } catch { throw new GatewayError('任务记录保存失败', { code: 'STORE_ERROR' }); }
      finally {
        await file?.close().catch(() => {});
        if (created) await unlink(temp).catch(() => {});
      }
    });
    this.#writes.set(safe.id, writing);
    try { return await writing; }
    finally { if (this.#writes.get(safe.id) === writing) this.#writes.delete(safe.id); }
  }
}

export class TaskEngine {
  #client;
  #store;
  #onMedia;
  #onChange;
  #pollMs;
  #initializing;
  #disposed = false;
  #abort = new AbortController();
  #requests = new Map();
  #locks = new Map();
  #running = new Map();
  #timers = new Map();
  #lastCreatedAt = 0;

  constructor({ client, store, onMedia, onChange = async () => {}, pollMs = 5000 }) {
    if (!client || !store || typeof onMedia !== 'function' || typeof onChange !== 'function' || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new GatewayError('任务引擎配置无效', { code: 'VALIDATION_ERROR', rejected: true });
    this.#client = client;
    this.#store = store;
    this.#onMedia = onMedia;
    this.#onChange = onChange;
    this.#pollMs = pollMs;
  }

  get store() { return this.#store; }

  #assertLive() {
    if (this.#disposed) throw new GatewayError('任务引擎已停止', { code: 'DISPOSED' });
  }

  async #save(job) {
    job.updatedAt = new Date().toISOString();
    const saved = await this.#store.write(job);
    // 通知与远端提交严格解耦；通知失败或挂起都不能触发重新生成。
    void Promise.resolve().then(() => this.#onChange(clone(saved))).catch(() => {});
    return saved;
  }

  #launch(job, operation) {
    if (this.#disposed || this.#running.has(job.id)) return;
    const running = Promise.resolve().then(operation).catch(() => {
      // 存储失败时宁可保留最后一次落盘状态；恢复只查询，绝不补提请求。
    }).finally(() => {
      if (this.#running.get(job.id) === running) this.#running.delete(job.id);
    });
    this.#running.set(job.id, running);
  }

  async #locked(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#locks.set(key, current);
    try { return await current; }
    finally { if (this.#locks.get(key) === current) this.#locks.delete(key); }
  }

  async init() {
    this.#assertLive();
    this.#initializing ??= (async () => {
      await this.#store.init();
      const jobs = await this.#store.list();
      for (const job of jobs) {
        const createdAt = Date.parse(job.createdAt);
        if (Number.isFinite(createdAt)) this.#lastCreatedAt = Math.max(this.#lastCreatedAt, createdAt);
        if (this.#requests.has(job.requestId) && this.#requests.get(job.requestId) !== job.id) throw new GatewayError('存在重复 requestId，需先人工对账', { code: 'STORE_ERROR' });
        this.#requests.set(job.requestId, job.id);
      }
      for (const job of jobs) {
        if (['ready', 'failed', 'download_failed'].includes(job.status)) continue;
        if (!job.remoteTaskId) {
          if (job.status !== 'submit_unknown') {
            job.status = 'submit_unknown';
            job.error = '重启前提交结果未确认；保留 requestId 供人工对账，禁止自动重提';
            await this.#save(job);
          }
          continue;
        }
        // 已知网关任务编号可以恢复查询；没有编号绝不靠重发找回。
        if (['preparing', 'submitting', 'submit_unknown'].includes(job.status)) {
          job.status = 'queued';
          delete job.error;
          await this.#save(job);
        }
        this.#launch(job, () => this.#pump(job));
      }
      return this;
    })();
    return this.#initializing;
  }

  async submit(input, { binding, requestId = randomUUID() } = {}) {
    this.#assertLive();
    validateRequestId(requestId);
    await this.init();
    return this.#locked(`request:${requestId}`, async () => {
      this.#assertLive();
      const existingId = this.#requests.get(requestId);
      if (existingId) {
        const existing = await this.#store.read(existingId);
        if (!existing) throw new GatewayError('幂等记录缺失，禁止重新提交', { code: 'STORE_ERROR' });
        return existing;
      }
      // 先复制输入，无法复制的值不能留下永远无法启动的 preparing 记录。
      const submittedInput = structuredClone(input);
      // Distinct creation times preserve submission order even within one clock
      // millisecond or after a clock rollback; restore the high-water mark on init.
      this.#lastCreatedAt = Math.max(Date.now(), this.#lastCreatedAt + 1);
      const now = new Date(this.#lastCreatedAt).toISOString();
      const job = publicJob({ id: randomUUID(), requestId, status: 'preparing', model: typeof input?.model === 'string' ? input.model : undefined, binding, createdAt: now, updatedAt: now, outputs: [], attachments: [], completedOutputs: [] });
      const saved = await this.#save(job);
      this.#requests.set(requestId, job.id);
      // 输入只留在本次异步调用的内存中，绝不持久化 prompt 或 base64。
      this.#launch(job, () => this.#submitOnce(job, submittedInput));
      return saved;
    });
  }

  async #submitOnce(job, input) {
    if (this.#disposed) return;
    job.status = 'submitting';
    await this.#save(job);
    let result;
    try {
      this.#abort.signal.throwIfAborted();
      result = await this.#client.submit(input, job.requestId, this.#abort.signal);
      if (!result || typeof result.taskId !== 'string' || !result.taskId) throw new GatewayError('提交结果未知', { code: 'SUBMIT_UNKNOWN' });
    } catch (error) {
      const rejected = error?.rejected === true || [400, 401, 403, 404, 405, 406, 410, 413, 415, 422, 429].includes(error?.status);
      job.status = rejected ? 'failed' : 'submit_unknown';
      job.error = rejected ? '网关明确拒绝提交，请检查工作流参数或鉴权' : '提交结果未知；保留 requestId 供人工对账，禁止自动重提';
      await this.#save(job);
      return;
    }
    // remoteTaskId 是用于 /v1/tasks 查询的网关任务编号；真实上游编号另记。
    job.remoteTaskId = result.taskId;
    job.accepted = result.accepted;
    job.deduplicated = result.deduplicated === true;
    job.status = 'queued';
    await this.#save(job);
    if (!this.#disposed) await this.#pump(job);
  }

  async #wait() {
    if (this.#disposed) return;
    await new Promise((done) => {
      const timer = setTimeout(() => { this.#timers.delete(timer); done(); }, this.#pollMs);
      this.#timers.set(timer, done);
    });
  }

  async #pump(job) {
    while (!this.#disposed) {
      if (['ready', 'failed', 'download_failed', 'submit_unknown'].includes(job.status)) return;
      if (job.status === 'downloading' && job.outputs.length) {
        await this.#download(job);
        return;
      }
      let snapshot;
      try {
        const query = this.#client.task ?? this.#client.state;
        snapshot = await query.call(this.#client, job.remoteTaskId, this.#abort.signal);
        if (!snapshot || typeof snapshot.status !== 'string') throw new Error();
      } catch {
        if (this.#disposed) return;
        job.queryError = '网关状态查询失败，将仅重试查询，不重新生成';
        await this.#save(job);
        await this.#wait();
        continue;
      }
      if (this.#disposed) return;
      delete job.queryError;
      job.remoteStatus = snapshot.status;
      if (snapshot.remoteTaskId) job.gatewayRemoteTaskId = snapshot.remoteTaskId;
      for (const key of ['costCoins', 'costRewardCoins', 'progress', 'pipelineStage']) if (snapshot[key] !== undefined) job[key] = snapshot[key];
      const status = snapshot.status.toLowerCase();
      if (['failed', 'timed_out', 'canceled', 'cancelled'].includes(status)) {
        job.status = 'failed';
        job.error = status === 'timed_out' ? '网关任务超时，已终止且不会自动重生' : ['canceled', 'cancelled'].includes(status) ? '网关任务已取消，不会自动重生' : '网关生成任务失败';
        await this.#save(job);
        return;
      }
      if (['succeeded', 'completed', 'success', 'ready'].includes(status)) {
        job.outputs = Array.isArray(snapshot.outputs) ? clone(snapshot.outputs) : [];
        job.status = job.outputs.length ? 'downloading' : 'download_failed';
        if (!job.outputs.length) job.error = '网关任务完成但未返回媒体产物';
        await this.#save(job);
        if (job.outputs.length) await this.#download(job);
        return;
      }
      if (['queued', 'submitting', 'pending'].includes(status)) job.status = 'queued';
      else if (['running', 'downloading', 'extracting', 'processing'].includes(status)) job.status = 'running';
      else job.queryError = '网关返回未知任务状态，将继续查询';
      await this.#save(job);
      await this.#wait();
    }
  }

  async #download(job) {
    for (let index = 0; index < job.outputs.length; index++) {
      if (this.#disposed) return;
      const output = job.outputs[index];
      const outputKey = output.path ?? output.url;
      if (typeof outputKey !== 'string' || !outputKey) {
        job.status = 'download_failed';
        job.error = '网关媒体产物缺少安全路径';
        await this.#save(job);
        return;
      }
      if (job.completedOutputs.includes(outputKey)) continue;
      try {
        const media = await this.#client.download(output, { signal: this.#abort.signal });
        if (this.#disposed) return;
        // 宿主可用 job.id + outputIndex 对附件保存实施跨进程幂等。
        const attachment = await this.#onMedia({ ...clone(job), outputIndex: index, outputKey }, media);
        const safeAttachment = publicValue(attachment);
        if (safeAttachment === undefined || safeAttachment === null) throw new Error();
        job.attachments.push(safeAttachment);
        job.completedOutputs.push(outputKey);
        // 每个附件单独检查点，第二个失败后重试不会再交付第一个。
        await this.#save(job);
      } catch {
        if (this.#disposed) return;
        job.status = 'download_failed';
        job.error = '媒体下载或附件保存失败，可仅重试下载';
        await this.#save(job);
        return;
      }
    }
    if (this.#disposed) return;
    job.status = 'ready';
    delete job.error;
    delete job.queryError;
    await this.#save(job);
  }

  async retryDownload(id) {
    validateJobId(id);
    this.#assertLive();
    await this.init();
    return this.#locked(`download:${id}`, async () => {
      this.#assertLive();
      let job = await this.#store.read(id);
      if (!job) throw new GatewayError('本地任务不存在', { code: 'NOT_FOUND' });
      if (job.status === 'ready' || job.status === 'downloading' && this.#running.has(id)) return job;
      if (job.status !== 'download_failed' || !job.outputs.length) throw new GatewayError('该任务没有可重试下载的产物', { code: 'VALIDATION_ERROR', rejected: true });
      // 等候上一轮失败处理退出，避免通知回调立即重试时撞上旧 pump。
      const previous = this.#running.get(id);
      if (previous) await previous;
      this.#assertLive();
      job = await this.#store.read(id);
      job.status = 'downloading';
      delete job.error;
      const saved = await this.#save(job);
      this.#launch(job, () => this.#download(job));
      return saved;
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    for (const [timer, done] of this.#timers) { clearTimeout(timer); done(); }
    this.#timers.clear();
  }
}
