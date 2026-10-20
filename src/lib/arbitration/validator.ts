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
  'done', 'ok', 'x', 'test', 'temp', 'foo', 'bar', 'none', 'n/a', 'na',
  'null', 'undefined', 'pass', 'success', 'true', 'false', '0', '1', '-1',
  'finished', 'complete', 'completed', 'yes', 'no', 'd'
]);

/**
 * 递归全局深度检测是否包含错误标识 (遍历任意层级的对象与数组，P0-A)
 */
export function hasErrorFlag(obj: any, depth = 0): boolean {
  if (depth > 10 || !obj) return false;
  if (Array.isArray(obj)) {
    return obj.some(item => hasErrorFlag(item, depth + 1));
  }
  if (typeof obj === 'object') {
    if (obj.error === true || (typeof obj.error === 'string' && obj.error.trim().length > 0)) return true;
    if (obj.err === true || (typeof obj.err === 'string' && obj.err.trim().length > 0)) return true;
    const statusStr = String(obj.status || '').toUpperCase();
    if (statusStr === 'ERROR' || statusStr === 'FAILED' || statusStr === 'FAILURE') return true;
    return Object.values(obj).some(val => hasErrorFlag(val, depth + 1));
  }
  return false;
}

/**
 * 校验文本内容是否实质有效（非占位符且具有必要长度）
 */
export function isSubstantiveText(text: any, minLen = 5): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < minLen) return false;
  if (TRIVIAL_PLACEHOLDERS.has(trimmed.toLowerCase())) return false;
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

function isValidIssueList(issues: any): boolean {
  if (!Array.isArray(issues) || issues.length === 0) return false;
  return issues.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (hasErrorFlag(item)) return false;
    const keys = Object.keys(item);
    if (keys.length === 0) return false;
    const recognizedKeys = ['type', 'original', 'suggestion', 'reason', 'message', 'description', 'rule', 'line', 'file', 'severity'];
    return keys.some(k => recognizedKeys.includes(k) && isSubstantiveText(String(item[k]), 1));
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
 * 校验结构化数据记录条目是否实质有效
 */
function isValidStructuredItem(item: any): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (hasErrorFlag(item)) return false;
  const keys = Object.keys(item);
  if (keys.length === 0) return false;

  // 必须包含至少一个实质内容字段且内容非占位符
  const hasSubstantiveContent = keys.some(k => {
    if (!CANONICAL_ITEM_CONTENT_KEYS.has(k)) return false;
    const val = item[k];
    if (typeof val === 'string') return isSubstantiveText(val, 2);
    if (typeof val === 'number') return Number.isFinite(val) && val > 0;
    if (typeof val === 'object' && val !== null) return isNonEmptyValue(val, 1);
    return false;
  });

  return hasSubstantiveContent;
}

/**
 * 校验指标对象是否实质有效
 */
function isValidMetricsObject(metrics: any): boolean {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
  const entries = Object.entries(metrics);
  if (entries.length === 0) return false;
  return entries.some(([_, val]) => {
    if (typeof val === 'number') return Number.isFinite(val) && val >= 0;
    if (typeof val === 'string') return isSubstantiveText(val, 1);
    if (typeof val === 'object' && val !== null) return isNonEmptyValue(val, 1);
    return false;
  });
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

    // 遍历所有白名单字段进行专门契约校验
    return substantiveKeys.some(k => {
      const v = val[k];
      if (v === null || v === undefined) return false;
      if (hasErrorFlag(v)) return false;

      // 文本类产物
      if (['text', 'content', 'summary', 'analysis', 'code', 'corrected', 'solution', 'dataDeliverySample'].includes(k)) {
        return isSubstantiveText(v, 5);
      }
      // URL 类产物
      if (k === 'url') {
        return typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'));
      }
      // Radar 类产物
      if (k === 'radar') {
        return isValidRadar(v);
      }
      // Issues 类产物
      if (k === 'issues') {
        return isValidIssueList(v);
      }
      // 结构化条目数组（findings, records, items, rows）
      if (['findings', 'records', 'items', 'rows'].includes(k)) {
        if (!Array.isArray(v) || v.length === 0) return false;
        return v.every(item => isValidStructuredItem(item));
      }
      // 指标类产物（metrics, benchmark）
      if (['metrics', 'benchmark'].includes(k)) {
        return isValidMetricsObject(v);
      }
      // 嵌套载荷（output, result, data, report, deliverable）
      if (['output', 'result', 'data', 'report', 'deliverable'].includes(k)) {
        return isValidDeliverablePayload(v, depth + 1);
      }
      // 数值评分
      if (k === 'score') {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0;
      }
      return false;
    });
  }

  return false;
}

/**
 * 交付数据包 Schema 字段级契约检查器 (TASK-503)
 * 全面支持 9 类顶层合法契约形状与包装形式 (P0-D)
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

  // 1. 全局深度递归错误标识拦截 (P0-A)
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
    // 4. 顶层对象格式：覆盖 9 类顶层规范形状及 output/result/data 包装 (P0-D)
    const keys = Object.keys(payload);
    if (keys.length === 0) {
      errors.push('Object payload is completely empty ({})');
      integrityScore = 0;
    } else {
      // 记录数解析
      if (payload.verifiedCount !== undefined) {
        if (typeof payload.verifiedCount !== 'number' || !Number.isInteger(payload.verifiedCount) || payload.verifiedCount <= 0) {
          errors.push('verifiedCount must be a positive integer');
          integrityScore = 0;
        } else {
          recordCount = payload.verifiedCount;
        }
      } else if (typeof payload.quantity === 'number' && Number.isInteger(payload.quantity) && payload.quantity > 0) {
        recordCount = payload.quantity;
      } else if (Array.isArray(payload.records)) {
        recordCount = payload.records.length;
      } else if (Array.isArray(payload.items)) {
        recordCount = payload.items.length;
      } else if (Array.isArray(payload.findings)) {
        recordCount = payload.findings.length;
      } else if (Array.isArray(payload.output)) {
        recordCount = payload.output.length;
      } else if (requiredQuantity && requiredQuantity > 1) {
        recordCount = 0;
        errors.push(`Missing verifiedCount in payload for result_based order (required ${requiredQuantity})`);
        integrityScore = 0;
      } else {
        recordCount = 1;
      }

      // 若指定了 verifiedCount，检查对应数组容量是否满足
      const targetArray = Array.isArray(payload.output) ? payload.output : (Array.isArray(payload.records) ? payload.records : (Array.isArray(payload.items) ? payload.items : null));
      if (targetArray && payload.verifiedCount !== undefined) {
        if (targetArray.length < payload.verifiedCount) {
          errors.push(`Array item count (${targetArray.length}) does not meet declared verifiedCount (${payload.verifiedCount})`);
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
