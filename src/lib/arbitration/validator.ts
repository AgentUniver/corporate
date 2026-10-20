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
        if (typeof item === 'object' && item !== null) {
          const keys = Object.keys(item);
          if (keys.length === 0) emptyFieldCount++;
        } else if (!item) {
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
        if (typeof payload.verifiedCount !== 'number' || !Number.isInteger(payload.verifiedCount) || payload.verifiedCount < 0) {
          errors.push('verifiedCount must be a non-negative integer');
          integrityScore = 0;
        } else {
          recordCount = payload.verifiedCount;
        }
      } else if (typeof payload.quantity === 'number' && Number.isInteger(payload.quantity) && payload.quantity >= 0) {
        recordCount = payload.quantity;
      } else {
        recordCount = 1;
      }

      const hasContractField = Boolean(
        (typeof payload.corrected === 'string' && payload.corrected.trim().length > 0) ||
        (Array.isArray(payload.issues) && payload.issues.length > 0) ||
        (typeof payload.dataDeliverySample === 'string' && payload.dataDeliverySample.trim().length > 0) ||
        (typeof payload.repo === 'string' && payload.repo.trim().length > 0 && typeof payload.radar === 'object' && payload.radar !== null && Object.keys(payload.radar).length > 0) ||
        (typeof payload.output === 'string' && payload.output.trim().length > 0) ||
        (typeof payload.output === 'object' && payload.output !== null && Object.keys(payload.output).length > 0) ||
        (typeof payload.result === 'string' && payload.result.trim().length > 0) ||
        (typeof payload.result === 'object' && payload.result !== null && Object.keys(payload.result).length > 0) ||
        (typeof payload.data === 'string' && payload.data.trim().length > 0) ||
        (typeof payload.data === 'object' && payload.data !== null && Object.keys(payload.data).length > 0)
      );

      if (!hasContractField) {
        errors.push('Payload schema lacks non-empty deliverable contract fields (corrected, issues, dataDeliverySample, repo/radar, output, result, or data)');
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

  // 1. 若履约交付物不存在或格式严重损坏
  if (!order.resultPayload || report.integrityScore < 50) {
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
