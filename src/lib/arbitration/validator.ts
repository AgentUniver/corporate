import type { TaskOrder } from '../supabase/types';

/**
 * 计算不可篡改的 SHA-256 存证散列
 */
export async function computeSha256(data: string | object): Promise<string> {
  const content = typeof data === 'string' ? data : JSON.stringify(data);

  // 1. Web Cryptography API (modern browsers & Node 18+ globalThis.crypto)
  const subtleCrypto = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
    ? globalThis.crypto.subtle
    : (typeof window !== 'undefined' && window.crypto && window.crypto.subtle ? window.crypto.subtle : null);

  if (subtleCrypto) {
    try {
      const msgBuffer = new TextEncoder().encode(content);
      const hashBuffer = await subtleCrypto.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to Node crypto
    }
  }

  // 2. Node.js native crypto module fallback
  try {
    const nodeCrypto = await import('crypto');
    if (nodeCrypto && (nodeCrypto as any).createHash) {
      return (nodeCrypto as any).createHash('sha256').update(content).digest('hex');
    }
  } catch {
    // Fall through
  }

  // 3. Fail-closed: Never return mock hash as sha256 declaration
  throw new Error('ACP_CRYPTO_UNAVAILABLE: Standard SHA-256 cryptographic provider is not available in current environment');
}

export interface SchemaValidationReport {
  valid: boolean;
  sha256Checksum: string;
  verifiedCount: number;
  integrityScore: number;
  errors: string[];
  slaConformant: boolean;
}

export const CANONICAL_DELIVERABLE_KEYS = new Set([
  'analysis', 'summary', 'text', 'corrected', 'score', 'code', 'data', 'result',
  'items', 'records', 'rows', 'metrics', 'findings', 'content', 'url', 'sha',
  'issues', 'radar', 'report', 'diff', 'benchmark', 'latency', 'solution',
  'deliverable', 'output', 'repo', 'dataDeliverySample'
]);

export const CANONICAL_ITEM_CONTENT_KEYS = new Set([
  'title', 'description', 'message', 'text', 'content', 'value', 'suggestion',
  'recommendation', 'rule', 'code', 'data', 'summary', 'findings', 'score',
  'metric', 'output', 'solution'
]);

export const TRIVIAL_PLACEHOLDERS = new Set([
  'done', 'ok', 'x', 'test', 'temp', 'foo', 'bar', 'none', 'na',
  'null', 'undefined', 'pass', 'passed', 'passing', 'success', 'true', 'false', '0', '1', '-1',
  'finished', 'complete', 'completed', 'yes', 'no', 'd', 'placeholder', 'sample', 'demo',
  'mock', 'hello', 'world', 'helloworld', 'wip', 'asdf', 'qwerty',
  '待补充内容', '占位符内容', '测试', '示例', '暂无', '待定', '内容待定', '占位',
  'lorem', 'ipsum', 'loremipsum', 'asdfgh', 'qwertyuiop'
]);

/**
 * 递归全局深度检测是否包含错误标识 (遍历任意层级的对象与数组，P0-A / P0-1 / P1-1)
 */
export function hasErrorFlag(obj: any, depth = 0): boolean {
  if (depth > 10 || !obj) return false;
  if (Array.isArray(obj)) {
    return obj.some(item => hasErrorFlag(item, depth + 1));
  }
  if (typeof obj === 'object') {
    // 1. error / err 字段存在且非假值、非空数组、非空对象
    if (obj.error !== undefined && obj.error !== null) {
      if (typeof obj.error === 'boolean' && obj.error === true) return true;
      if (typeof obj.error === 'string' && obj.error.trim().length > 0) return true;
      if (typeof obj.error === 'number' && obj.error !== 0) return true;
      if (Array.isArray(obj.error) && obj.error.length > 0) return true;
      if (typeof obj.error === 'object' && !Array.isArray(obj.error) && Object.keys(obj.error).length > 0) return true;
    }

    if (obj.err !== undefined && obj.err !== null) {
      if (typeof obj.err === 'boolean' && obj.err === true) return true;
      if (typeof obj.err === 'string' && obj.err.trim().length > 0) return true;
      if (typeof obj.err === 'number' && obj.err !== 0) return true;
      if (Array.isArray(obj.err) && obj.err.length > 0) return true;
      if (typeof obj.err === 'object' && !Array.isArray(obj.err) && Object.keys(obj.err).length > 0) return true;
    }

    // 2. 显式成功标志被置为 false
    if (obj.success === false || obj.ok === false) return true;

    // 3. 状态枚举指示失败 (精确匹配词元，杜绝 REFERRAL / TRANSFERRED / PREFERRED 误杀，P1-1)
    const statusStr = String(obj.status || obj.state || obj.result_status || '').toUpperCase().trim();
    if (statusStr.length > 0) {
      const FAIL_EXACT_TOKENS = new Set([
        'FAIL', 'FAILED', 'FAILURE', 'ERROR', 'FATAL', 'REJECT', 'REJECTED',
        'INVALID', 'BROKEN', 'ABORT', 'ABORTED', 'CANCELLED', 'EXCEPTION'
      ]);
      const tokens = statusStr.split(/[\s_\-.:/,]+/);
      if (tokens.some(t => FAIL_EXACT_TOKENS.has(t))) return true;
    }

    // 4. HTTP 错误代码 (4xx / 5xx 仅在伴随错误语义上下文时拦截，避免误杀常规 404 报告，P1-1)
    if (typeof obj.code === 'number' && obj.code >= 400 && obj.code <= 599) {
      if (obj.error || obj.err || obj.exception || obj.stack || String(obj.message || '').toLowerCase().includes('error')) {
        return true;
      }
    }

    return Object.values(obj).some(val => hasErrorFlag(val, depth + 1));
  }
  return false;
}

/**
 * 校验文本内容是否实质有效（非占位符、无零宽字符干扰且具有必要自然语言有效字符，P0-1）
 */
export function isSubstantiveText(text: any, minLen = 5): boolean {
  if (typeof text !== 'string') return false;
  // 1. Unicode 规范化并过滤零宽字符、非断行空格及控制换行符
  const normalizedUnicode = text.normalize('NFKC');
  const stripped = normalizedUnicode.replace(/[\u200B-\u200D\uFEFF\u00A0\r\n\t]/g, '').trim();
  if (stripped.replace(/\s+/g, '').length < minLen) return false;

  // 2. 防西里尔/希腊同形字母混淆 (如用西里尔 "е" 拼写 "passеd")
  if (/[a-zA-Z]/.test(stripped) && /[\u0400-\u04FF\u0370-\u03FF]/.test(stripped)) {
    return false;
  }

  // 3. 必须包含至少一个有效英文字母或中文字符（拒绝 "12345"、"-----"、"..." 等无语义字符）
  if (!/[a-zA-Z\u4e00-\u9fa5]/.test(stripped)) {
    return false;
  }

  // 4. 剔除标点符号并小写后对比占位符字典（拒绝 "done."、"passed" 等变形占位符与中文占位）
  const normalized = stripped.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  if (TRIVIAL_PLACEHOLDERS.has(normalized) || TRIVIAL_PLACEHOLDERS.has(stripped.toLowerCase())) {
    return false;
  }

  // 5. Lorem ipsum 填充文本拦截
  if (normalized.includes('loremipsum') || normalized.startsWith('lorem')) {
    return false;
  }

  // 5. 单字符重复检测 (如 "aaaaaa", "xxxxxx")
  if (/^(.)\1+$/.test(normalized)) {
    return false;
  }

  // 6. Base64 无空格随机垃圾串拦截 (>30 字符无分隔)
  if (/^[A-Za-z0-9+/=]{30,}$/.test(stripped)) {
    return false;
  }

  return true;
}

/**
 * 校验值是否为有实质内容的非空契约项 (Fail-closed)
 */
export function isNonEmptyValue(v: any, depth = 0): boolean {
  if (depth > 6) return false;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return false; // Raw boolean is not deliverable
  if (typeof v === 'number') return Number.isFinite(v) && !Number.isNaN(v) && v > 0;
  if (typeof v === 'string') return isSubstantiveText(v, 1);
  if (Array.isArray(v)) {
    if (v.length === 0) return false;
    return v.every(item => isNonEmptyValue(item, depth + 1));
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return false;
    return keys.some(k => isNonEmptyValue(v[k], depth + 1));
  }
  return false;
}

export function isValidUrl(v: any): boolean {
  if (typeof v !== 'string' || v.length < 10) return false;
  try {
    const parsed = new URL(v);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname || parsed.hostname.length < 3 || !parsed.hostname.includes('.')) return false;
    return true;
  } catch {
    return false;
  }
}

function isValidIssueList(issues: any): boolean {
  if (!Array.isArray(issues) || issues.length === 0) return false;
  return issues.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (hasErrorFlag(item)) return false;
    // 1. 包含实质性描述字段 (message/description/suggestion 等)
    const descriptiveKeys = ['message', 'description', 'suggestion', 'reason', 'summary', 'detail', 'title'];
    const hasSubstantiveTextContent = descriptiveKeys.some(k => isSubstantiveText(item[k], 3));
    if (hasSubstantiveTextContent) return true;

    // 2. 标准静态代码检查格式：包含 rule + severity + line/file (避免误杀结构化 linter 交付，P1-1)
    if (item.rule && item.severity && (item.line !== undefined || item.file !== undefined)) {
      return true;
    }

    return false;
  });
}

function isValidRadar(radar: any): boolean {
  if (!radar || typeof radar !== 'object' || Array.isArray(radar)) return false;
  const keys = Object.keys(radar);
  if (keys.length === 0) return false;
  const recognizedKeys = ['architecture', 'security', 'scalability', 'maintainability', 'reliability', 'score', 'metrics', 'findings', 'quality', 'testCoverage'];
  const validEntries = keys.filter(k => recognizedKeys.includes(k) && isNonEmptyValue(radar[k], 1));
  return validEntries.length > 0;
}

/**
 * 校验结构化数据记录条目是否实质有效 (P0-1: 拒绝单纯元数据如 { value: 1 })
 */
function isValidStructuredItem(item: any): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (hasErrorFlag(item)) return false;
  const keys = Object.keys(item);
  if (keys.length === 0) return false;

  // 支持数值数据集条目如 { id: "metric-1", value: 42 } (避免误杀 legit 数据集，P1-1)
  if (item.id !== undefined && typeof item.value === 'number' && Number.isFinite(item.value)) {
    return true;
  }

  // Reject bare metadata objects like { value: 1 } or { id: 1 } without other context
  const substantiveKeys = keys.filter(k => k !== 'id' && k !== 'index' && k !== 'type' && k !== 'value');
  if (substantiveKeys.length === 0) return false;

  // 必须包含至少一个实质内容字段且内容非占位符
  const hasSubstantiveContent = keys.some(k => {
    if (!CANONICAL_ITEM_CONTENT_KEYS.has(k)) return false;
    const val = item[k];
    if (typeof val === 'string') return isSubstantiveText(val, 2);
    if (typeof val === 'number') return Number.isFinite(val) && val > 0 && k !== 'value';
    if (typeof val === 'object' && val !== null) return isNonEmptyValue(val, 1);
    return false;
  });

  return hasSubstantiveContent;
}

/**
 * 校验指标对象是否实质有效 (P0-1: score/accuracy/quality 必须严格 > 0)
 */
function isValidMetricsObject(metrics: any): boolean {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
  const entries = Object.entries(metrics);
  if (entries.length === 0) return false;

  // If score, accuracy or quality is present, must be strictly > 0
  for (const [key, val] of entries) {
    const k = key.toLowerCase();
    if (['score', 'accuracy', 'quality', 'passrate'].includes(k)) {
      if (typeof val !== 'number' || val <= 0) return false;
    }
  }

  return entries.some(([_, val]) => {
    if (typeof val === 'number') return Number.isFinite(val) && val > 0;
    if (typeof val === 'string') return isSubstantiveText(val, 1);
    if (typeof val === 'object' && val !== null) return isNonEmptyValue(val, 1);
    return false;
  });
}

/**
 * 提取对象内部的条目集合数组 (P0-2)
 */
function extractCollectionArray(obj: any): any[] | null {
  if (!obj || typeof obj !== 'object') return null;
  const collectionKeys = ['records', 'items', 'findings', 'issues', 'output', 'rows', 'data', 'results'];
  for (const k of collectionKeys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  for (const wrapper of ['output', 'result', 'data']) {
    if (obj[wrapper] && typeof obj[wrapper] === 'object' && !Array.isArray(obj[wrapper])) {
      for (const k of collectionKeys) {
        if (Array.isArray(obj[wrapper][k])) return obj[wrapper][k];
      }
    }
  }
  return null;
}

/**
 * 严格递归校验任意交付载荷实体有效性 (Fail-closed)
 */
export function isValidDeliverablePayload(val: any, depth = 0): boolean {
  if (depth > 6) return false;
  if (val === null || val === undefined) return false;
  if (hasErrorFlag(val)) return false;

  // 1. 纯文本交付物：长度 >= 5 且非占位符
  if (typeof val === 'string') {
    return isSubstantiveText(val, 5);
  }

  // 2. 纯数字/布尔值：不能单独作为顶层交付物
  if (typeof val === 'number' || typeof val === 'boolean') {
    return false;
  }

  // 3. 数组交付物：所有子元素必须为合格的结构化对象
  if (Array.isArray(val)) {
    if (val.length === 0) return false;
    return val.every(item => isValidStructuredItem(item));
  }

  // 4. 对象交付物：深度校验全部顶层与嵌套字段
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return false;

    // 必须包含白名单认可的规范契约字段
    const canonicalPresent = keys.filter(k => CANONICAL_DELIVERABLE_KEYS.has(k));
    if (canonicalPresent.length === 0) {
      return false;
    }

    // 杜绝仅含 id/status/token 等伪装壳体
    const substantiveKeys = canonicalPresent.filter(k => k !== 'id' && k !== 'status' && k !== 'token' && k !== 'verifiedCount');
    if (substantiveKeys.length === 0) {
      return false;
    }

    // 拒绝单独 {score: 1} 作为交付物（P1-3）
    if (substantiveKeys.length === 1 && substantiveKeys[0] === 'score') {
      return false;
    }

    // 计量门禁防护 (P0-1): 任何声明 verifiedCount > 1 或 quantity > 1 的交付必须附带满足容量的集合
    const declaredVolume = (typeof val.verifiedCount === 'number' && val.verifiedCount > 1)
      ? val.verifiedCount
      : ((typeof val.quantity === 'number' && val.quantity > 1) ? val.quantity : null);
    if (declaredVolume !== null) {
      const col = extractCollectionArray(val);
      if (!col || col.length < declaredVolume) {
        return false;
      }
    }

    // 若对象内包含条目集合，则集合内的每个元素必须全部合法，禁止局部非法（P0-1 消除 some 旁路）
    const collectionKeys = ['records', 'items', 'findings', 'rows'];
    for (const ck of collectionKeys) {
      if (Array.isArray(val[ck])) {
        if (val[ck].length === 0 || !val[ck].every(item => isValidStructuredItem(item))) {
          return false;
        }
      }
    }
    if (val.issues && Array.isArray(val.issues)) {
      if (val.issues.length === 0 || !isValidIssueList(val.issues)) {
        return false;
      }
    }

    // 遍历所有白名单字段进行专门契约校验
    return substantiveKeys.some(k => {
      const v = val[k];
      if (v === null || v === undefined) return false;
      if (hasErrorFlag(v)) return false;

      // 文本类产物
      if (['text', 'content', 'summary', 'analysis', 'code', 'corrected', 'solution', 'dataDeliverySample'].includes(k)) {
        return isSubstantiveText(v, 5);
      }
      // URL 类产物 (P0-1)
      if (k === 'url') {
        return isValidUrl(v);
      }
      // Radar 类产物
      if (k === 'radar') {
        return isValidRadar(v);
      }
      // Issues 类产物 (P0-1)
      if (k === 'issues') {
        return isValidIssueList(v);
      }
      // Git commit SHA (P1-2)
      if (k === 'sha') {
        return typeof v === 'string' && /^[a-fA-F0-9]{7,64}$/.test(v.trim());
      }
      // Git code diff (P1-2)
      if (k === 'diff') {
        return isSubstantiveText(v, 10);
      }
      // Repository path / URL (P1-2)
      if (k === 'repo') {
        return typeof v === 'string' && (v.includes('/') || isValidUrl(v));
      }
      // 结构化条目数组（findings, records, items, rows）
      if (['findings', 'records', 'items', 'rows'].includes(k)) {
        if (!Array.isArray(v) || v.length === 0) return false;
        return v.every(item => isValidStructuredItem(item));
      }
      // 指标类产物（metrics, benchmark）(P0-1)
      if (['metrics', 'benchmark'].includes(k)) {
        return isValidMetricsObject(v);
      }
      // 嵌套载荷（output, result, data, report, deliverable）
      if (['output', 'result', 'data', 'report', 'deliverable'].includes(k)) {
        return isValidDeliverablePayload(v, depth + 1);
      }
      // 数值评分 (P0-1: 必须严格 > 0)
      if (k === 'score') {
        return typeof v === 'number' && Number.isFinite(v) && v > 0;
      }
      return false;
    });
  }

  return false;
}

/**
 * 交付数据包 Schema 字段级契约检查器 (TASK-503)
 * 全面支持 9 类顶层合法契约形状与包装形式 (P0-D / P0-1 / P0-2)
 */
export async function validateDeliverableSchema(
  payload: any,
  requiredQuantity?: number,
  _slaThreshold?: string
): Promise<SchemaValidationReport> {
  const errors: string[] = [];
  let recordCount = 0;
  let integrityScore = 100;

  if (payload === null || payload === undefined || (typeof payload !== 'object' && typeof payload !== 'string')) {
    return {
      valid: false,
      sha256Checksum: '0'.repeat(64),
      verifiedCount: 0,
      integrityScore: 0,
      errors: ['Payload is null, undefined, or unsupported format'],
      slaConformant: false
    };
  }

  const checksum = await computeSha256(payload);

  // 1. 全局深度递归错误标识拦截 (P0-A / P0-1)
  if (hasErrorFlag(payload)) {
    errors.push('Payload contains error flag or failed status indicator');
    return {
      valid: false,
      sha256Checksum: checksum,
      verifiedCount: 0,
      integrityScore: 0,
      errors,
      slaConformant: false
    };
  }

  // 2. 顶层字符串格式
  if (typeof payload === 'string') {
    if (!isSubstantiveText(payload, 5)) {
      errors.push('String payload is empty or trivial placeholder');
      integrityScore = 0;
    } else {
      recordCount = 1;
    }
  } else if (Array.isArray(payload)) {
    // 3. 顶层数组格式
    recordCount = payload.length;
    if (recordCount === 0) {
      errors.push('Array payload contains 0 records');
      integrityScore = 0;
    } else {
      let defectiveCount = 0;
      payload.forEach((item) => {
        if (!isValidStructuredItem(item)) {
          defectiveCount++;
        }
      });
      if (defectiveCount > 0) {
        errors.push(`Detected ${defectiveCount} invalid/empty items among ${recordCount} records`);
        integrityScore = 0;
      }
    }
  } else if (typeof payload === 'object') {
    // 4. 顶层对象格式：覆盖 9 类顶层规范形状及 output/result/data 包装 (P0-D / P0-2)
    const keys = Object.keys(payload);
    if (keys.length === 0) {
      errors.push('Object payload is completely empty ({})');
      integrityScore = 0;
    } else {
      const foundCollection = extractCollectionArray(payload);

      // 集合数组逐元素强制有效性校验（消灭 some 旁路漏洞，P0-1）
      if (foundCollection) {
        if (foundCollection.length === 0) {
          errors.push('Collection array contains 0 records');
          integrityScore = 0;
        } else {
          let defectiveCount = 0;
          for (const item of foundCollection) {
            if (!isValidStructuredItem(item)) {
              defectiveCount++;
            }
          }
          if (defectiveCount > 0) {
            errors.push(`Detected ${defectiveCount} invalid/defective items in collection array of ${foundCollection.length} records`);
            integrityScore = 0;
          }
        }

        // 防刷屏去重校验：若元素超过 10 条且前 10 条完全相同，视为伪造占位符（P0-1）
        if (foundCollection.length >= 10) {
          const sample = foundCollection.slice(0, 10).map(i => JSON.stringify(i));
          if (sample.every(s => s === sample[0])) {
            errors.push('Collection array consists of identical duplicate placeholder items');
            integrityScore = 0;
          }
        }
      }

      // 记录数与容量匹配规则 (P0-2)
      if (payload.verifiedCount !== undefined) {
        if (typeof payload.verifiedCount !== 'number' || !Number.isInteger(payload.verifiedCount) || payload.verifiedCount <= 0) {
          errors.push('verifiedCount must be a positive integer');
          integrityScore = 0;
        } else if (payload.verifiedCount > 1) {
          // 多件交付 (P0-2): 必须附带条目集合数组，且数组长度 >= verifiedCount
          if (!foundCollection) {
            errors.push(`Multi-item deliverable declared verifiedCount=${payload.verifiedCount} but lacks collection array (e.g. records, items, output, findings)`);
            integrityScore = 0;
            recordCount = 0;
          } else if (foundCollection.length < payload.verifiedCount) {
            errors.push(`Collection array length (${foundCollection.length}) is below declared verifiedCount (${payload.verifiedCount})`);
            integrityScore = 0;
            recordCount = foundCollection.length;
          } else {
            recordCount = payload.verifiedCount;
          }
        } else {
          recordCount = 1;
        }
      } else if (foundCollection) {
        recordCount = foundCollection.length;
      } else if (typeof payload.quantity === 'number' && Number.isInteger(payload.quantity) && payload.quantity > 0) {
        if (payload.quantity > 1) {
          if (!foundCollection) {
            errors.push(`Multi-item deliverable declared quantity=${payload.quantity} but lacks collection array`);
            integrityScore = 0;
            recordCount = 0;
          } else if (foundCollection.length < payload.quantity) {
            errors.push(`Collection array length (${foundCollection.length}) is below declared quantity (${payload.quantity})`);
            integrityScore = 0;
            recordCount = foundCollection.length;
          } else {
            recordCount = payload.quantity;
          }
        } else {
          recordCount = 1;
        }
      } else {
        recordCount = 1;
      }

      // 如果订单要求多件 (requiredQuantity > 1)，但交付物仅为单件文本/对象且无集合数组，阻断伪造 (P0-2)
      if (requiredQuantity && requiredQuantity > 1) {
        if (!foundCollection && recordCount <= 1) {
          errors.push(`Multi-item order required ${requiredQuantity} items, but deliverable provides single item without collection array`);
          integrityScore = 0;
          recordCount = 0;
        } else if (foundCollection && foundCollection.length < requiredQuantity) {
          errors.push(`Collection array length (${foundCollection.length}) does not meet required quantity (${requiredQuantity})`);
          integrityScore = 0;
        }
      }

      // 统一复用契约门禁校验器，确保白名单全量识别
      const isValid = isValidDeliverablePayload(payload, 0);
      if (!isValid) {
        errors.push('Payload schema lacks substantive deliverable contract fields matching CANONICAL_DELIVERABLE_KEYS');
        integrityScore = 0;
      }
    }
  }

  if (requiredQuantity && recordCount < requiredQuantity) {
    errors.push(`Delivered count (${recordCount}) is below required volume (${requiredQuantity})`);
    integrityScore = Math.round(integrityScore * (recordCount / requiredQuantity));
  }

  const valid = integrityScore >= 80 && errors.length === 0;
  const slaConformant = integrityScore >= 90 && errors.length === 0;

  return {
    valid,
    sha256Checksum: checksum,
    verifiedCount: recordCount,
    integrityScore,
    errors,
    slaConformant
  };
}

export interface DisputeArbitrationVerdict {
  ruling: 'refund_client' | 'settle_developer' | 'split';
  rationale: string;
  confidence: number;
  evidenceHash: string;
  arbitratedAt: string;
}

/**
 * 自动化争议裁决分析引擎 (TASK-504)
 */
export async function evaluateDisputeArbitration(
  order: TaskOrder,
  buyerReason: string
): Promise<DisputeArbitrationVerdict> {
  const arbitratedAt = new Date().toISOString();
  const rawEvidence = `${order.id}|${order.status}|${buyerReason}|${order.deliverableFingerprint?.sha256Checksum || ''}|${arbitratedAt}`;
  const evidenceHash = await computeSha256(rawEvidence);

  const report = await validateDeliverableSchema(
    order.resultPayload,
    order.quantity,
    order.slaThreshold
  );

  // 1. 若履约交付物不存在、校验未通过或存在任何契约缺陷，一律全额退款 (Fail-closed)
  if (!order.resultPayload || !report.valid || report.errors.length > 0 || report.integrityScore < 80) {
    return {
      ruling: 'refund_client',
      rationale: `Automated inspection failed: Deliverable payload integrity score (${report.integrityScore}/100) fell below the minimal SLA viability threshold. Contract defect confirmed: ${report.errors.join('; ')}`,
      confidence: 0.99,
      evidenceHash,
      arbitratedAt
    };
  }

  // 2. 交付物完全合规且达到 SLA 阈值（得分 >= 90 且 0 错误），买家主观撤单予以驳回并结算
  if (report.slaConformant && report.integrityScore >= 90 && report.errors.length === 0) {
    return {
      ruling: 'settle_developer',
      rationale: `Deliverable cryptographic fingerprint (${report.sha256Checksum.slice(0, 16)}...) verified against SLA requirements. Zero data schema defects found. Dispute rejected by SLA protocol.`,
      confidence: 0.95,
      evidenceHash,
      arbitratedAt
    };
  }

  // 3. 部分边界区间 (80% <= score < 90%)
  return {
    ruling: 'split',
    rationale: `Deliverable passed base verification with integrity score ${report.integrityScore}/100, but detected non-fatal inconsistencies with buyer prompt. Mediated proportional settlement.`,
    confidence: 0.88,
    evidenceHash,
    arbitratedAt
  };
}
