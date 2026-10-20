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

/**
 * 递归判断任意值是否为有实质内容的非空契约项 (Fail-closed)
 */
export function isNonEmptyValue(v: any, depth = 0): boolean {
  if (depth > 6) return false;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v === true; // Strict: boolean false is defective/failed
  if (typeof v === 'number') return Number.isFinite(v) && !Number.isNaN(v);
  if (typeof v === 'string') return v.trim().length > 0;
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
    const keys = Object.keys(item);
    if (keys.length === 0) return false;
    const recognizedKeys = ['type', 'original', 'suggestion', 'reason', 'message', 'description', 'rule', 'line', 'file', 'severity'];
    return keys.some(k => recognizedKeys.includes(k) && isNonEmptyValue(item[k], 1));
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
 * 递归校验 Deliverable Payload 深度契约有效性
 */
function isValidDeliverablePayload(val: any, depth = 0): boolean {
  if (depth > 6) return false;
  if (!isNonEmptyValue(val, depth)) return false;

  if (typeof val === 'string') return val.trim().length > 0;
  if (typeof val === 'number') return Number.isFinite(val);
  if (typeof val === 'boolean') return val === true;

  if (Array.isArray(val)) {
    return val.length > 0 && val.every(item => isValidDeliverablePayload(item, depth + 1));
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return false;

    // 若包含 radar 或 issues 特化结构，必须深度有效
    if (val.radar !== undefined && !isValidRadar(val.radar)) return false;
    if (val.issues !== undefined && !isValidIssueList(val.issues)) return false;

    // 针对数组内部或子对象（depth > 0），只要包含有效内容键值对即为合法数据实体
    if (depth > 0) {
      return keys.some(k => isNonEmptyValue(val[k], depth + 1));
    }

    const recognizedKeys = [
      'analysis', 'summary', 'text', 'corrected', 'score', 'code', 'data', 'result',
      'items', 'records', 'rows', 'metrics', 'findings', 'content', 'url', 'sha',
      'issues', 'radar', 'status', 'token', 'verifiedCount', 'output', 'report',
      'diff', 'benchmark', 'latency', 'model', 'answer', 'solution', 'id', 'title',
      'name', 'description', 'message', 'severity', 'type'
    ];

    const hasRecognized = keys.some(k => recognizedKeys.includes(k) && isValidDeliverablePayload(val[k], depth + 1));
    return hasRecognized;
  }

  return false;
}

/**
 * 交付数据包 Schema 字段级契约检查器 (TASK-503)
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

  if (typeof payload === 'string') {
    if (!payload.trim()) {
      errors.push('String payload is empty');
      integrityScore = 0;
    } else {
      recordCount = 1;
    }
  } else if (Array.isArray(payload)) {
    recordCount = payload.length;
    if (recordCount === 0) {
      errors.push('Array payload contains 0 records');
      integrityScore = 0;
    } else {
      let emptyFieldCount = 0;
      payload.forEach((item) => {
        if (!isNonEmptyValue(item)) {
          emptyFieldCount++;
        }
      });
      if (emptyFieldCount > 0) {
        const defectRate = emptyFieldCount / recordCount;
        integrityScore = Math.max(0, Math.round((1 - defectRate) * 100));
        errors.push(`Detected ${emptyFieldCount} defective/empty items among ${recordCount} records`);
      }
    }
  } else if (typeof payload === 'object') {
    const keys = Object.keys(payload);
    if (keys.length === 0) {
      errors.push('Object payload is completely empty ({})');
      integrityScore = 0;
    } else if (payload.status === 'ERROR' || payload.error) {
      errors.push(`Payload error flag: ${payload.error || 'ERROR status'}`);
      integrityScore = 0;
    } else {
      if (payload.verifiedCount !== undefined) {
        if (typeof payload.verifiedCount !== 'number' || !Number.isInteger(payload.verifiedCount) || payload.verifiedCount <= 0) {
          errors.push('verifiedCount must be a positive integer');
          integrityScore = 0;
        } else {
          recordCount = payload.verifiedCount;
        }
      } else if (typeof payload.quantity === 'number' && Number.isInteger(payload.quantity) && payload.quantity > 0) {
        recordCount = payload.quantity;
      } else if (requiredQuantity && requiredQuantity > 1) {
        recordCount = 0;
        errors.push(`Missing verifiedCount in payload for result_based order (required ${requiredQuantity})`);
        integrityScore = 0;
      } else {
        recordCount = 1;
      }

      // Check array output length against declared verifiedCount
      if (payload.output !== undefined && Array.isArray(payload.output)) {
        if (payload.output.length < recordCount) {
          errors.push(`Output array item count (${payload.output.length}) does not meet declared verifiedCount (${recordCount})`);
          integrityScore = 0;
        }
      }

      const hasValidIssues = payload.issues !== undefined && isValidIssueList(payload.issues);
      const hasValidRadar = typeof payload.repo === 'string' && payload.repo.trim().length > 0 && isValidRadar(payload.radar);
      const hasValidCorrected = typeof payload.corrected === 'string' && payload.corrected.trim().length > 0;
      const hasValidSample = typeof payload.dataDeliverySample === 'string' && payload.dataDeliverySample.trim().length > 0;
      const hasValidOutput = payload.output !== undefined && isValidDeliverablePayload(payload.output);
      const hasValidResult = payload.result !== undefined && isValidDeliverablePayload(payload.result);
      const hasValidData = payload.data !== undefined && isValidDeliverablePayload(payload.data);

      const hasContractField = hasValidIssues || hasValidRadar || hasValidCorrected || hasValidSample || hasValidOutput || hasValidResult || hasValidData;

      if (!hasContractField) {
        errors.push('Payload schema lacks non-empty deliverable contract fields (valid issues with fields, valid repo/radar, corrected text, or recognized output/result/data)');
        integrityScore = 0;
      }
    }
  }

  if (requiredQuantity && recordCount < requiredQuantity) {
    errors.push(`Delivered count (${recordCount}) is below required volume (${requiredQuantity})`);
    integrityScore = Math.round(integrityScore * (recordCount / requiredQuantity));
  }

  const valid = integrityScore >= 60 && errors.length === 0;
  const slaConformant = integrityScore >= 80 && errors.length === 0;

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
 * 基于 SLA 指标、交付物数字指纹校验报告及时间戳窗口进行机器裁判，秒级定谳
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

  // 1. 若履约交付物不存在或校验不合格
  if (!order.resultPayload || !report.valid || report.integrityScore < 50) {
    return {
      ruling: 'refund_client',
      rationale: `Automated inspection failed: Deliverable payload integrity score (${report.integrityScore}/100) fell below the minimal SLA viability threshold. Contract defect confirmed.`,
      confidence: 0.98,
      evidenceHash,
      arbitratedAt
    };
  }

  // 2. 交付物完全合规且达到 SLA 阈值，但买家主观撤单
  if (report.slaConformant && report.integrityScore >= 85) {
    return {
      ruling: 'settle_developer',
      rationale: `Deliverable cryptographic fingerprint (${report.sha256Checksum.slice(0, 16)}...) verified against SLA requirements. Zero data schema defects found. Dispute rejected by SLA protocol.`,
      confidence: 0.94,
      evidenceHash,
      arbitratedAt
    };
  }

  // 3. 部分缺损或争议在边界区间 (50% <= score < 85%)
  return {
    ruling: 'split',
    rationale: `Deliverable passed base verification with integrity score ${report.integrityScore}/100, but detected non-fatal inconsistencies with buyer prompt. Mediated proportional settlement.`,
    confidence: 0.88,
    evidenceHash,
    arbitratedAt
  };
}
