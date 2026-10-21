import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const JSON_LIMIT = 2 * 1024 * 1024;
const WORKFLOW_LIMIT = 8 * 1024 * 1024;
const REFERENCE_LIMIT = 10 * 1024 * 1024;
const PRIVATE_FIELD = /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization|credential|account|session|凭据|账号|密码)/i;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INPUT_KEYS = new Set(['model', 'prompt', 'resolution', 'custom', 'references', 'duration_seconds', 'apply_defaults']);
const SCHEMA_KEYS = new Set([
  'key', 'name', 'label', 'description', 'nodeId', 'field', 'type', 'valueType', 'kind', 'title',
  'target', 'classType', 'groupTitle', 'groupId', 'value', 'canvasValue', 'currentValue',
  'templateValue', 'pinnedValue', 'pinned', 'customManaged', 'managedByCustom', 'managed',
  'defaultValue', 'default', 'randomize', 'required', 'options', 'enum', 'const',
  'min', 'max', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'step', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'properties', 'items', 'additionalProperties',
  'minItems', 'maxItems', 'uniqueItems', 'oneOf', 'anyOf', 'allOf', 'nullable',
  'label', 'role', 'tag', 'mode', 'bypassed', 'enabled', 'mimeTypes', 'accept',
  'seconds', 'frames', 'fps', 'requestedSeconds', 'source', 'ratio', 'raw', 'width', 'height',
  'aspect_ratio', 'megapixels', 'resolution', 'custom', 'references', 'duration_seconds',
  'aiLora', 'loraKind', 'loraLibrary', 'strengthKey', 'managedByCustomField',
]);

export class GatewayError extends Error {
  constructor(message, { code = 'GATEWAY_ERROR', status, rejected = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.rejected = rejected;
  }
}

function invalid(message = '请求参数无效') {
  return new GatewayError(message, { code: 'VALIDATION_ERROR', rejected: true });
}

export function sanitizeMessage(value, secrets = []) {
  let text = typeof value === 'string' ? value : '操作失败';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[已脱敏]');
  }
  return text
    .replace(/(?:https?:\/\/|file:\/\/)[^\s<>"']+/gi, '[地址已隐藏]')
    .replace(/data:[^\s]+/gi, '[素材已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已脱敏]')
    .replace(/(?:api[_-]?key|token|secret|password|cookie|authorization|credential)\s*[=:]\s*[^\s,;}]+/gi, '[凭据已隐藏]')
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '[已脱敏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 200);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(value, keys) {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.has(key) || BAD_KEYS.has(key))) {
    throw invalid('包含未知参数或参数对象无效');
  }
}

function shortString(value, max = 256) {
  return typeof value === 'string' ? sanitizeMessage(value).slice(0, max) : undefined;
}

function privateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (h === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/.test(h) || !h.includes('.') && !isIP(h)) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  if (isIP(h) === 6) return h === '::' || h === '::1' || /^(?:f[cd]|fe[89ab]|ff)/i.test(h) || h.startsWith('::ffff:');
  return false;
}

export function validateBaseURL(value, apiKey = '') {
  let url;
  try { url = new URL(value); } catch { throw invalid('baseURL 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(String(value)) || url.search || url.hash || /[?#]/.test(String(value))) {
    throw invalid('baseURL 不允许凭据、查询参数或片段');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw invalid('HTTP 网关仅允许本机回环地址');
  if (apiKey && !loopback && privateHost(url.hostname)) throw invalid('不允许向私网地址发送 API key');
  return url;
}

// 只保留公开 schema；properties 的键是用户参数名，不是网关内部配置。
function cleanSchema(value, depth = 0, propertyMap = false) {
  if (depth > 16) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => cleanSchema(item, depth + 1)).filter((item) => item !== undefined);
  if (!isObject(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (BAD_KEYS.has(key) || PRIVATE_FIELD.test(key) || !propertyMap && !SCHEMA_KEYS.has(key)) continue;
    const cleaned = cleanSchema(item, depth + 1, key === 'properties');
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function publicField(field) {
  if (!isObject(field)) return undefined;
  if (['key', 'field', 'name', 'label', 'title', 'target'].some((key) => typeof field[key] === 'string' && PRIVATE_FIELD.test(field[key]))) return undefined;
  return cleanSchema(field);
}

function safeName(value, fallback = 'media') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || /[\\/\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..' || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw invalid('媒体名称不能是路径或 URL');
  }
  return value.trim().slice(0, 200);
}

// 短哈希：仅在服务端用的私有字段（默认素材 fileName、presetIds、note 等）参与计算，
// 但绝不出现在任何公开 DTO 字段里，仅作为 revision 供前端判断「默认素材是否变了」。
function workflowRevision(raw) {
  const parts = [JSON.stringify(raw)];
  const def = raw.defaults;
  if (isObject(def)) {
    if (Array.isArray(def.references)) {
      for (const ref of def.references) {
        if (!isObject(ref)) continue;
        parts.push(`r:${ref.nodeId ?? ''}:${ref.fileName ?? ''}:${ref.size ?? ''}:${ref.name ?? ''}:${ref.mimeType ?? ''}`);
      }
    }
    if (Array.isArray(def.referencePools)) {
      for (const pool of def.referencePools) {
        if (!isObject(pool)) continue;
        parts.push(`p:${pool.nodeId ?? ''}:${(Array.isArray(pool.galleryIds) ? pool.galleryIds : []).join(',')}`);
      }
    }
    if (Array.isArray(def.presetIds)) parts.push(`pr:${def.presetIds.filter((id) => typeof id === 'string').join(',')}`);
    if (typeof def.note === 'string') parts.push(`n:${def.note}`);
    if (typeof def.promptSuffix === 'string') parts.push(`ps:${def.promptSuffix}`);
    if (typeof def.updatedAt === 'string') parts.push(`du:${def.updatedAt}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// 管线子工作流只读展示：避免错把管线本体的合并槽当成上传槽。
function buildReferenceGroups(raw, allRaw) {
  const byAlias = new Map(allRaw.filter(isObject).map((item) => [item.alias, item]));
  const groups = [];
  for (const side of ['imageWorkflowAlias', 'videoWorkflowAlias']) {
    const alias = raw.pipeline?.[side];
    if (typeof alias !== 'string' || !alias) continue;
    if (side === 'videoWorkflowAlias' && raw.pipeline.videoRefSource === 'image' && raw.pipeline.kind !== 'first-frame') continue;
    const sub = byAlias.get(alias);
    if (!sub) continue;
    const described = describeWorkflow(sub);
    groups.push({
      alias: described.alias,
      title: side === 'imageWorkflowAlias' ? '生图' : '视频',
      referenceSlots: described.referenceSlots.filter((slot) => !slot.bypassed),
      defaults: described.defaults,
      revision: described.revision,
    });
  }
  return groups;
}

function describeWorkflow(raw, allRaw) {
  if (!isObject(raw) || typeof raw.alias !== 'string' || !raw.alias.trim()) throw invalid('工作流列表格式无效');
  const customFields = (Array.isArray(raw.customFields) ? raw.customFields : []).map(publicField).filter(Boolean);
  const defaults = {};
  if (isObject(raw.defaults)) {
    if (raw.defaults.resolution !== undefined) defaults.resolution = cleanSchema(raw.defaults.resolution);
    if (typeof raw.defaults.updatedAt === 'string') defaults.updatedAt = raw.defaults.updatedAt;
    if (typeof raw.defaults.note === 'string') defaults.note = shortString(raw.defaults.note);
    if (typeof raw.defaults.promptSuffix === 'string') defaults.promptSuffix = shortString(raw.defaults.promptSuffix);
    if (Array.isArray(raw.defaults.presetIds)) defaults.presetIds = raw.defaults.presetIds.filter((id) => typeof id === 'string').map((id) => id);
    if (isObject(raw.defaults.custom)) {
      const allowed = new Set(customFields.map((field) => field.key));
      defaults.custom = Object.fromEntries(Object.entries(raw.defaults.custom)
        .filter(([key, value]) => allowed.has(key) && !PRIVATE_FIELD.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => [key, cleanSchema(value)]));
    }
    // 默认素材带 fileName/mimeType/size/note，但 DTO 绝不暴露 fileName（服务端磁盘文件名）。
    if (Array.isArray(raw.defaults.references)) {
      defaults.references = raw.defaults.references.filter(isObject).map((reference) => {
        const result = {};
        for (const key of ['nodeId', 'kind', 'mimeType', 'size', 'note']) if (typeof reference[key] !== 'undefined') result[key] = cleanSchema(reference[key]);
        if (typeof reference.name === 'string') result.name = shortString(reference.name.split(/[\\/]/).at(-1));
        return result;
      });
    }
    if (Array.isArray(raw.defaults.referencePools)) {
      defaults.referencePools = raw.defaults.referencePools.filter(isObject).map((pool) => {
        const result = {};
        for (const key of ['nodeId', 'galleryIds', 'note']) if (typeof pool[key] !== 'undefined') result[key] = cleanSchema(pool[key]);
        return result;
      });
    }
  }
  const capabilities = { adapter: 'gateway', perRequestNodeOverrides: false };
  if (Array.isArray(raw.pipelineImageResolutionFields)) capabilities.resolutionFields = raw.pipelineImageResolutionFields.filter((field) => ['width', 'height', 'aspect_ratio', 'megapixels'].includes(field));
  for (const key of ['resolutionSchema', 'durationSchema']) {
    const schema = raw.capabilities?.[key] ?? raw[key];
    if (isObject(schema)) capabilities[key] = cleanSchema(schema);
  }
  const result = {
    alias: raw.alias,
    customFields,
    referenceSlots: (Array.isArray(raw.referenceSlots) ? raw.referenceSlots : []).map(publicField).filter(Boolean).map((slot) => {
      // currentValue 是远端文件路径，不属于公开槽位描述。
      delete slot.currentValue;
      return slot;
    }),
    videoDuration: raw.videoDuration === undefined ? null : cleanSchema(raw.videoDuration),
    videoAspect: raw.videoAspect === undefined ? null : cleanSchema(raw.videoAspect),
    defaults,
    seedTargets: (Array.isArray(raw.seedTargets) ? raw.seedTargets : []).map(publicField).filter(Boolean),
    modelFields: (Array.isArray(raw.modelFields) ? raw.modelFields : []).map(publicField).filter(Boolean),
    capabilities,
    revision: workflowRevision(raw),
    updatedAt: raw.updatedAt ?? null,
    primarySite: raw.primarySite ?? '',
    resolutionNodeId: raw.resolutionNodeId ?? '',
    broken: Boolean(raw.broken),
  };
  if (raw.broken && typeof raw.brokenReason === 'string') result.brokenReason = shortString(raw.brokenReason);
  if (isObject(raw.pipeline)) {
    result.pipeline = {
      kind: raw.pipeline.kind,
      imageWorkflowAlias: raw.pipeline.imageWorkflowAlias,
      videoWorkflowAlias: raw.pipeline.videoWorkflowAlias,
      videoRefSource: raw.pipeline.videoRefSource,
      ...(isObject(raw.pipeline.imageResolution) ? { imageResolution: cleanSchema(raw.pipeline.imageResolution) } : {}),
      ...(isObject(raw.pipeline.gridResolution) ? { gridResolution: cleanSchema(raw.pipeline.gridResolution) } : {}),
    };
  }
  if (isObject(raw.pipeline) && Array.isArray(allRaw)) result.referenceGroups = buildReferenceGroups(raw, allRaw);
  return result;
}

function validateValue(value, schema) {
  if (!isObject(schema)) return;
  const options = schema.enum ?? schema.options;
  if (Array.isArray(options) && !options.some((option) => (isObject(option) ? option.value : option) === value)) throw invalid('参数不在工作流声明的枚举中');
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw invalid('参数不符合工作流固定值');
  const type = schema.type ?? schema.valueType;
  if (['number', 'integer'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isInteger(value))) throw invalid('数值参数类型无效');
  if (type === 'boolean' && typeof value !== 'boolean') throw invalid('布尔参数类型无效');
  if (['string', 'text', 'select'].includes(type) && typeof value !== 'string') throw invalid('文本参数类型无效');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('数值参数必须有限');
    const min = schema.minimum ?? schema.min;
    const max = schema.maximum ?? schema.max;
    if (typeof min === 'number' && value < min || typeof max === 'number' && value > max || typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum || typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) throw invalid('数值参数超出工作流范围');
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8) throw invalid('数值参数不符合工作流步长');
  }
  if (typeof value === 'string') {
    if (value.length > (schema.maxLength ?? 8000) || value.length < (schema.minLength ?? 0)) throw invalid('文本参数长度不符合工作流约束');
    if (typeof schema.pattern === 'string') {
      let pattern;
      try { pattern = new RegExp(schema.pattern, 'u'); } catch { throw invalid('工作流声明的校验表达式无效'); }
      if (!pattern.test(value)) throw invalid('文本参数不符合工作流约束');
    }
  }
}

export function validateReferences(value, description) {
  if (!Array.isArray(value) || value.length > 64) throw invalid('references 必须是最多 64 项的数组');
  const seen = new Set();
  return value.map((reference) => {
    assertKeys(reference, new Set(['nodeId', 'data', 'name', 'mimeType', 'enable', 'note']));
    const slot = description.referenceSlots.find((item) => item.nodeId === reference.nodeId);
    if (!slot || !['image', 'audio'].includes(slot.kind) || seen.has(reference.nodeId)) throw invalid('参考槽位无效或重复');
    seen.add(reference.nodeId);
    if (reference.enable !== undefined && typeof reference.enable !== 'boolean') throw invalid('enable 必须是布尔值');
    if ((slot.bypassed || slot.mode !== undefined && slot.mode !== 0) && reference.enable !== true) throw invalid('停用的参考槽位必须显式 enable');
    const result = { nodeId: slot.nodeId };
    if (reference.enable !== undefined) result.enable = reference.enable;
    if (reference.note !== undefined) {
      if (typeof reference.note !== 'string' || reference.note.length > 200) throw invalid('参考素材备注过长或无效');
      result.note = reference.note;
    }
    if (reference.name !== undefined) result.name = safeName(reference.name);
    if (reference.data === undefined) {
      if (reference.enable === true || reference.mimeType !== undefined) throw invalid('参考素材缺少 base64 内容');
      return result;
    }
    if (typeof reference.data !== 'string' || !reference.data || reference.data.length > Math.ceil(REFERENCE_LIMIT / 3) * 4 + 128) throw invalid('参考素材为空或超过单张 10MB 限制');
    let data = reference.data;
    let mimeType = reference.mimeType;
    const dataURL = /^data:([^;,]+);base64,([\s\S]+)$/.exec(data);
    if (dataURL) {
      if (mimeType !== undefined && mimeType !== dataURL[1]) throw invalid('参考素材 MIME 声明不一致');
      mimeType = dataURL[1];
      data = dataURL[2];
    }
    if (typeof mimeType !== 'string' || !/^(?:image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac|x-flac))$/.test(mimeType)) throw invalid('参考素材仅允许图片或音频');
    if (mimeType.startsWith('image/') !== (slot.kind === 'image')) throw invalid('参考素材类型与槽位不匹配');
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if (data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) throw invalid('参考素材必须为标准 base64，不能传入路径或 URL');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > REFERENCE_LIMIT) throw invalid('参考素材超过单张 10MB 限制');
    return { ...result, data, mimeType };
  });
}

export function validateInput(input, description) {
  assertKeys(input, INPUT_KEYS);
  if (description.broken) throw invalid('broken 工作流不可提交');
  if (typeof input.model !== 'string' || input.model !== description.alias) throw invalid('必须指定已存在的工作流 model');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw invalid('prompt 不能为空');
  if (input.apply_defaults !== undefined && typeof input.apply_defaults !== 'boolean') throw invalid('apply_defaults 必须是布尔值');
  const result = { model: input.model, prompt: input.prompt.trim(), apply_defaults: input.apply_defaults ?? true };
  if (input.custom !== undefined) {
    if (!isObject(input.custom)) throw invalid('custom 必须是对象');
    result.custom = {};
    for (const [key, value] of Object.entries(input.custom)) {
      const field = description.customFields.find((item) => item.key === key);
      if (!field || BAD_KEYS.has(key) || PRIVATE_FIELD.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) throw invalid('包含未知或无效的 custom 参数');
      validateValue(value, field);
      result.custom[key] = value;
    }
  }
  for (const field of description.customFields) {
    if (field.required === true && !Object.hasOwn(input.custom ?? {}, field.key) && !(result.apply_defaults && (Object.hasOwn(description.defaults.custom ?? {}, field.key) || field.defaultValue !== undefined || field.randomize))) throw invalid('缺少工作流必填 custom 参数');
  }
  if (input.resolution !== undefined) {
    assertKeys(input.resolution, new Set(['aspect_ratio', 'megapixels', 'width', 'height']));
    result.resolution = {};
    for (const [key, value] of Object.entries(input.resolution)) {
      if (key === 'aspect_ratio') {
        if (typeof value !== 'string' || value !== 'auto' && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?(?: \([^)]+\))?$/.test(value)) throw invalid('画幅比例格式无效');
      } else if (typeof value !== 'number' || !Number.isFinite(value) || (key === 'megapixels' ? value < 0.1 || value > 16 : !Number.isInteger(value) || value < 64 || value > 8192)) throw invalid('分辨率数值超出网关允许范围');
      const field = description.capabilities.resolutionSchema?.properties?.[key] ?? description.modelFields.find((item) => item.field === key);
      if (field) validateValue(value, field);
      result.resolution[key] = value;
    }
    if (Object.hasOwn(input.resolution, 'width') !== Object.hasOwn(input.resolution, 'height')) throw invalid('width 和 height 必须成对提供');
  }
  if (input.duration_seconds !== undefined) {
    if (!description.videoDuration && !description.capabilities.durationSchema) throw invalid('当前工作流未声明视频时长能力');
    if (typeof input.duration_seconds !== 'number' || !Number.isFinite(input.duration_seconds) || input.duration_seconds < 0.5 || input.duration_seconds > 120) throw invalid('duration_seconds 必须是 0.5 到 120 之间的数字');
    validateValue(input.duration_seconds, description.capabilities.durationSchema ?? description.videoDuration);
    result.duration_seconds = input.duration_seconds;
  }
  if (input.references !== undefined) result.references = validateReferences(input.references, description);
  return result;
}

export function validateRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid('requestId 必须是 1 到 128 位安全标识');
  return value;
}

function validateTaskId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw invalid('任务标识无效');
  return value;
}

function rejectTraversal(value) {
  let decoded = value;
  for (let i = 0; i < 5; i++) {
    if (/[\\\u0000-\u0020\u007f]/.test(decoded) || decoded.split(/[/?#]/).some((part) => part === '..' || part === '.')) throw invalid('媒体路径不安全');
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw invalid('媒体路径编码无效'); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  throw invalid('媒体路径编码层级过深');
}

export function validateOutput(output, baseURL) {
  const base = validateBaseURL(baseURL);
  if (typeof output === 'string') output = { path: output };
  if (!isObject(output)) throw invalid('媒体输出无效');
  let relative;
  let suppliedURL;
  if (output.url !== undefined) {
    if (typeof output.url !== 'string') throw invalid('媒体 URL 无效');
    rejectTraversal(output.url);
    try { suppliedURL = new URL(output.url, base); } catch { throw invalid('媒体 URL 无效'); }
    if (suppliedURL.origin !== base.origin || suppliedURL.username || suppliedURL.password || suppliedURL.search || suppliedURL.hash || /[?#]/.test(output.url) || !suppliedURL.pathname.startsWith('/files/')) throw invalid('媒体只允许同源 /files/ 地址');
    relative = rejectTraversal(suppliedURL.pathname.slice('/files/'.length));
  }
  if (output.path !== undefined) {
    if (typeof output.path !== 'string' || /[?#]/.test(output.path) || /^[a-z][a-z\d+.-]*:/i.test(output.path) || output.path.startsWith('//')) throw invalid('媒体路径无效');
    let path = rejectTraversal(output.path);
    if (path.startsWith('/files/')) path = path.slice(7);
    else if (path.startsWith('files/')) path = path.slice(6);
    else if (path.startsWith('images/')) path = path.slice(7);
    else if (path.startsWith('/')) throw invalid('不允许媒体绝对路径');
    if (relative !== undefined && relative !== path) throw invalid('媒体路径和 URL 不一致');
    relative = path;
  }
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..') || /[?#:]/.test(relative)) throw invalid('媒体路径无效');
  const url = new URL(`/files/${relative.split('/').map(encodeURIComponent).join('/')}`, base).href;
  const name = safeName(output.name ?? relative.split('/').at(-1));
  const ext = relative.split('.').at(-1).toLowerCase();
  const kind = ['mp4', 'webm'].includes(ext) ? 'video' : ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : undefined;
  if (!kind || output.kind !== undefined && output.kind !== kind) throw invalid('不支持的媒体类型或扩展名');
  return { path: relative, url, kind, name };
}

async function readLimited(response, limit, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new GatewayError('网关响应超过大小限制', { code: 'RESPONSE_TOO_LARGE' });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new GatewayError('网关响应超过大小限制', { code: 'RESPONSE_TOO_LARGE' });
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return data;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sniffMedia(data) {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  const ascii = (start, end) => Buffer.from(data.subarray(start, end)).toString('ascii');
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3 && Buffer.from(data.subarray(0, 4096)).includes(Buffer.from('webm'))) return 'video/webm';
  return undefined;
}

// 本模块只适配本地网关协议，不实现或冒充 RunningHub 官方 API。
export class GatewayClient {
  #base;
  #apiKey;
  #fetch;
  #timeout;
  #maxMediaBytes;

  constructor({ baseURL, apiKey, fetchImpl = fetch, timeoutMs = 20000, maxMediaBytes = 256 * 1024 * 1024 }) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey))) throw invalid('API key 格式无效');
    this.#base = validateBaseURL(baseURL, apiKey);
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxMediaBytes) || maxMediaBytes <= 0) throw invalid('客户端配置无效');
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#timeout = timeoutMs;
    this.#maxMediaBytes = maxMediaBytes;
  }

  async #request(path, { method = 'GET', body, signal, limit = JSON_LIMIT, media = false } = {}) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      combined.throwIfAborted();
      const headers = { accept: media ? '*/*' : 'application/json' };
      if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const url = new URL(path, this.#base);
      if (url.origin !== this.#base.origin || url.username || url.password) throw invalid('请求必须与网关同源');
      const response = await this.#fetch(url.href, { method, headers, redirect: 'error', signal: combined, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        throw new GatewayError(`网关请求失败（HTTP ${status}）`, { code: 'HTTP_ERROR', status, rejected: [400, 401, 403, 404, 405, 406, 410, 413, 415, 422, 429].includes(status) });
      }
      if (response.redirected || response.url && new URL(response.url).origin !== this.#base.origin) {
        await response.body?.cancel().catch(() => {});
        throw new GatewayError('拒绝重定向或异源响应', { code: 'INVALID_RESPONSE' });
      }
      const data = await readLimited(response, limit, combined);
      if (media) return { data, mediaType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() };
      try { return JSON.parse(new TextDecoder().decode(data)); } catch { throw new GatewayError('网关返回的 JSON 无效', { code: 'INVALID_RESPONSE' }); }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(combined.aborted ? '网关请求已中止或超时' : '网关连接中断', { code: combined.aborted ? 'ABORTED' : 'NETWORK_ERROR' });
    } finally { clearTimeout(timer); }
  }

  async listWorkflows(signal) {
    const raw = await this.#request('/api/workflows', { signal, limit: WORKFLOW_LIMIT });
    const workflows = Array.isArray(raw) ? raw : raw?.workflows ?? raw?.data;
    if (!Array.isArray(workflows)) throw new GatewayError('工作流列表响应无效', { code: 'INVALID_RESPONSE' });
    return workflows.map((item) => describeWorkflow(item, workflows));
  }

  async describe(alias, signal) {
    if (typeof alias !== 'string' || !alias.trim()) throw invalid('工作流别名不能为空');
    const workflows = await this.listWorkflows(signal);
    const base = workflows.find((item) => item.alias === alias);
    if (!base) throw invalid('未找到工作流别名');
    const capabilities = { ...base.capabilities };
    // 节点 API 取分辨率字段：404 兼容旧 mock；其他错误显式抛出（syncErrors，不瞎猜硬编码）。
    try {
      const site = base.primarySite ? `?site=${encodeURIComponent(base.primarySite)}` : '';
      const nodes = await this.#request(`/api/workflows/${encodeURIComponent(alias)}/nodes${site}`, { signal, limit: JSON_LIMIT });
      if (Array.isArray(nodes)) {
        const target = nodes.find((node) => node.id === base.resolutionNodeId) ?? nodes.find((node) => Array.isArray(node.resolutionFields) && node.resolutionFields.length);
        if (target && Array.isArray(target.resolutionFields)) capabilities.resolutionFields = target.resolutionFields;
      }
    } catch (error) {
      if (!(error instanceof GatewayError && error.status === 404)) throw error;
    }
    // aiLora 动态选项来自全局 LoRA 库：按 kind 缓存，404 跳过，其他错误显式抛出。
    const aiLoraFields = base.customFields.filter((field) => field.aiLora === true);
    if (aiLoraFields.length) {
      const loraCache = new Map();
      for (const field of aiLoraFields) {
        const kind = field.loraLibrary === 'krea2' ? 'krea2' : field.loraLibrary === 'qwen' ? 'qwen' : 'pose';
        let library = loraCache.get(kind);
        if (library === undefined) {
          try {
            library = await this.#request(`/api/lora-library?kind=${kind}`, { signal, limit: JSON_LIMIT });
          } catch (error) {
            if (error instanceof GatewayError && error.status === 404) library = null;
            else throw error;
          }
          loraCache.set(kind, library);
        }
        if (library && Array.isArray(library.loras)) {
          field.aiLoraOptions = library.loras.filter(isObject).map((lora) => {
            const option = { value: lora.name, label: typeof lora.note === 'string' && lora.note ? lora.note : lora.name };
            if (typeof lora.note === 'string' && lora.note) option.note = lora.note;
            if (typeof lora.triggers === 'string' && lora.triggers) option.triggers = lora.triggers;
            if (typeof lora.strength === 'number') option.strength = lora.strength;
            return option;
          });
        }
      }
    }
    if (base.pipeline) {
      capabilities.resolutionFields = base.pipeline.kind === 'first-frame'
        ? base.capabilities.resolutionFields ?? [] : ['aspect_ratio', 'megapixels'];
    }
    return { ...base, capabilities };
  }

  async getSettings(signal) {
    const raw = await this.#request('/api/settings', { signal, limit: JSON_LIMIT });
    return { defaultModel: typeof raw?.defaultModel === 'string' ? raw.defaultModel : '' };
  }

  async readReference(alias, nodeId, signal) {
    if (typeof alias !== 'string' || !alias.trim()) throw invalid('工作流别名不能为空');
    if (typeof nodeId !== 'string' || !nodeId.trim()) throw invalid('参考素材槽位 nodeId 无效');
    const workflows = await this.listWorkflows(signal);
    const workflow = workflows.find((item) => item.alias === alias);
    if (!workflow) throw invalid('未找到工作流别名');
    const asset = (workflow.defaults?.references ?? []).find((reference) => reference.nodeId === nodeId);
    if (!asset) throw invalid('该工作流没有该默认参考素材槽');
    // 固定原文件端点：路径完全由工作流别名与 nodeId 编码构成，不接受任意 URL/路径。
    const url = `/api/workflows/${encodeURIComponent(alias)}/defaults/references/${encodeURIComponent(nodeId)}`;
    const { data, mediaType } = await this.#request(url, { signal, media: true, limit: REFERENCE_LIMIT });
    const type = typeof mediaType === 'string' ? mediaType.split(';')[0].trim().toLowerCase() : '';
    if (!/^(?:image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac|x-flac))$/.test(type)) throw new GatewayError('参考素材仅支持图片或音频', { code: 'INVALID_MEDIA' });
    const head = Buffer.from(data.subarray(0, 512)).toString('latin1').trimStart().toLowerCase();
    if (!data.length || head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<script')) throw new GatewayError('参考素材内容类型无效', { code: 'INVALID_MEDIA' });
    if (asset.mimeType && asset.mimeType !== type || asset.kind === 'audio' && !type.startsWith('audio/') || asset.kind === 'image' && !type.startsWith('image/')) throw new GatewayError('参考素材类型与客户端记录不一致', { code: 'INVALID_MEDIA' });
    const name = safeName(asset.name ?? nodeId);
    const kind = asset.kind === 'audio' ? 'audio' : 'image';
    return { data, mediaType: type, name, kind };
  }

  async submit(input, requestId, signal) {
    assertKeys(input, INPUT_KEYS);
    validateRequestId(requestId);
    const description = await this.describe(input.model, signal);
    const body = { ...validateInput(input, description), n: 1, parallel: 1, concurrency: 1, async: true, client_request_id: requestId };
    const response = await this.#request('/v1/images/generations', { method: 'POST', body, signal });
    if (!Array.isArray(response?.task_id) || response.task_id.length !== 1) throw new GatewayError('提交响应未返回唯一任务，请人工对账', { code: 'SUBMIT_UNKNOWN' });
    let taskId;
    try { taskId = validateTaskId(response.task_id[0]); } catch { throw new GatewayError('提交响应任务标识无效，请人工对账', { code: 'SUBMIT_UNKNOWN' }); }
    return { taskId, accepted: Number.isInteger(response.accepted) ? response.accepted : 1, deduplicated: response.deduplicated === true };
  }

  async task(taskId, signal) {
    validateTaskId(taskId);
    const raw = await this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`, { signal });
    if (!isObject(raw) || typeof raw.status !== 'string' || !Array.isArray(raw.outputs ?? raw.images ?? [])) throw new GatewayError('任务响应格式无效', { code: 'INVALID_RESPONSE' });
    const outputs = (raw.outputs ?? raw.images ?? []).map((output) => validateOutput(output, this.#base));
    const result = { taskId, status: shortString(raw.status), outputs };
    if (typeof raw.remoteTaskId === 'string') result.remoteTaskId = shortString(raw.remoteTaskId);
    if (raw.error) result.error = sanitizeMessage(typeof raw.error === 'string' ? raw.error : '网关任务失败', [this.#apiKey]);
    for (const key of ['costCoins', 'costRewardCoins', 'progress']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) result[key] = raw[key];
    for (const key of ['createdAt', 'updatedAt', 'pipelineStage']) if (typeof raw[key] === 'string') result[key] = shortString(raw[key]);
    return result;
  }

  state(taskId, signal) { return this.task(taskId, signal); }

  async download(output, { signal } = {}) {
    const safe = validateOutput(output, this.#base);
    const { data, mediaType } = await this.#request(safe.url, { signal, media: true, limit: this.#maxMediaBytes });
    const actual = sniffMedia(data);
    const ext = safe.path.split('.').at(-1).toLowerCase();
    const expected = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' }[ext];
    if (actual !== expected || mediaType !== undefined && mediaType !== 'application/octet-stream' && mediaType !== actual) throw new GatewayError('媒体内容、MIME 或扩展名不一致', { code: 'INVALID_MEDIA' });
    return { data, mediaType: actual, name: safe.name, kind: safe.kind };
  }
}
