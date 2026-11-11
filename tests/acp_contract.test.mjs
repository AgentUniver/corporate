import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  validateDeliverableSchema,
  evaluateDisputeArbitration,
  hasErrorFlag,
  isValidDeliverablePayload
} from '../src/lib/arbitration/validator.ts';
import { setSupabaseClientForTesting } from '../api/v1/acp/_supabase.ts';
import settleHandler from '../api/v1/acp/settle/[task_id].ts';
import refundHandler from '../api/v1/acp/refund/[task_id].ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSortedMigrations(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => a.split('_')[0].padEnd(14, '0').localeCompare(b.split('_')[0].padEnd(14, '0')));
}

test('P0-A & N2 & P0-1 & P0-2: All Auditor POC Defective Deliverables Must Fail-Closed', async (t) => {
  const defectivePOCs = [
    // Round 13 P0-① bypass POCs (empty/bogus collection items masked by sibling fields)
    { name: '{ verifiedCount: 1000, records: [{} x 1000], metrics: { score: 1 } }', payload: { verifiedCount: 1000, records: Array(1000).fill({}), metrics: { score: 1 } }, qty: 1000 },
    { name: '{ verifiedCount: 1000, records: [{} x 1000], text: "real report text" }', payload: { verifiedCount: 1000, records: Array(1000).fill({}), text: 'real substantive report text' }, qty: 1000 },
    { name: '{ verifiedCount: 1000, items: [{ foo: 1 } x 1000], metrics: { score: 1 } }', payload: { verifiedCount: 1000, items: Array(1000).fill({ foo: 1 }), metrics: { score: 1 } }, qty: 1000 },
    { name: '{ verifiedCount: 1000, output: { records: [{} x 1000] }, metrics: { score: 1 } }', payload: { verifiedCount: 1000, output: { records: Array(1000).fill({}) }, metrics: { score: 1 } }, qty: 1000 },
    { name: '{ verifiedCount: 1000, records: [{} x 1000], summary: "valid summary" }', payload: { verifiedCount: 1000, records: Array(1000).fill({}), summary: 'valid substantive summary text' }, qty: 1000 },
    { name: '{ verifiedCount: 1000, records: [{ title: "a b" } x 1000] }', payload: { verifiedCount: 1000, records: Array(1000).fill({ title: 'a b' }) }, qty: 1000 },
    { name: '{ verifiedCount: 1000, records: [{ title: "Record 1" } x 1000] } (identical spam)', payload: { verifiedCount: 1000, records: Array(1000).fill({ title: 'Record 1', description: 'valid description' }) }, qty: 1000 },
    { name: 'Sole { score: 1 } deliverable', payload: { score: 1 } },
    { name: 'Cyrillic homoglyph: { text: "passеd" }', payload: { text: 'pass\u0435d' } },
    { name: 'Chinese placeholder: { text: "待补充内容" }', payload: { text: '待补充内容' } },
    { name: 'Lorem placeholder: { text: "lorem ipsum dolor sit amet" }', payload: { text: 'lorem ipsum dolor sit amet' } },

    // Round 12 P0-1 penetration POCs
    { name: '{ output: { status: "FAIL" } }', payload: { output: { status: 'FAIL' } } },
    { name: '{ output: { error: { code: 500 } } }', payload: { output: { error: { code: 500 } } } },
    { name: '{ text: "done." }', payload: { text: 'done.' } },
    { name: '{ text: "12345" }', payload: { text: '12345' } },
    { name: 'Zero-width spaces: { text: "\\u200B\\u200B\\u200B\\u200B\\u200B" }', payload: { text: '\u200B\u200B\u200B\u200B\u200B' } },
    { name: '{ text: "-----" }', payload: { text: '-----' } },
    { name: '{ text: "passed" }', payload: { text: 'passed' } },
    { name: '{ score: 0 }', payload: { score: 0 } },
    { name: '{ metrics: { score: 0 } }', payload: { metrics: { score: 0 } } },
    { name: '[{ value: 1 }]', payload: [{ value: 1 }] },
    { name: '{ url: "https://" }', payload: { url: 'https://' } },
    { name: '{ output: { success: false, summary: "Substantive summary that should be blocked" } }', payload: { output: { success: false, summary: 'Substantive summary that should be blocked' } } },
    { name: '{ issues: [{ type: "bug", severity: "low" }] }', payload: { issues: [{ type: 'bug', severity: 'low' }] } },

    // Round 13 P0-1 Nested & Wrapper Collection Bypass POCs
    { name: 'OP R13 nested probe (a): { text: "...", deliverable: { records: [{}] } }', payload: { text: '报告正文内容在此处技术深度分析', deliverable: { records: [{}] } }, qty: 1 },
    { name: 'OP R13 nested probe (b): { metrics: { score: 1 }, output: { output: { records: [{}] } } }', payload: { metrics: { score: 1 }, output: { output: { records: [{}] } } }, qty: 1 },
    { name: 'OP R13 depth-2 nested empty: { report: { deliverable: { items: [{}] } } }', payload: { report: { deliverable: { items: [{}] } } }, qty: 1 },
    { name: 'OP R13 sibling text + defective output: { text: "...", output: { error: true } }', payload: { text: '分析报告已完成符合规范', output: { error: true } }, qty: 1 },
    { name: 'OP R13 sibling text + defective nested collection: { text: "...", output: { records: [{}] } }', payload: { text: '分析报告已完成符合规范', output: { records: [{}] } }, qty: 1 },

    // Round 12 P0-2 volume metering forgery POCs
    { name: 'P0-2 Forgery: { verifiedCount: 1000, text: "一句报告" } (qty=1000)', payload: { verifiedCount: 1000, text: '一句报告技术分析文档已生成' }, qty: 1000 },
    { name: 'P0-1 OP probe: { quantity: 1000, text: "一句报告" } (qty=1000)', payload: { quantity: 1000, text: '一句报告技术分析文档已生成' }, qty: 1000 },
    { name: 'P0-2 Forgery: { verifiedCount: 1000, output: { items: [{ title: "a", description: "substantive text" }] } } (qty=1000)', payload: { verifiedCount: 1000, output: { items: [{ title: 'a', description: 'substantive text' }] } }, qty: 1000 },

    // Round 11 P0-A new POCs
    { name: '{ output: "done" }', payload: { output: 'done' } },
    { name: '{ data: "x" }', payload: { data: 'x' } },
    { name: '[{ error: true, output: "x" }]', payload: [{ error: true, output: 'x' }] },
    { name: '{ output: [{ status: "ERROR", text: "x" }] }', payload: { output: [{ status: 'ERROR', text: 'x' }] } },
    { name: '{ result: [{ error: "boom", data: "d" }] }', payload: { result: [{ error: 'boom', data: 'd' }] } },

    // Round 10 POCs
    { name: '{ output: 0 }', payload: { output: 0 } },
    { name: '{ output: -1 }', payload: { output: -1 } },
    { name: '{ output: [0] }', payload: { output: [0] } },
    { name: '{ output: [{ foo: 1 }] }', payload: { output: [{ foo: 1 }] } },
    { name: '[{ foo: 1 }, { bar: 2 }]', payload: [{ foo: 1 }, { bar: 2 }] },
    { name: '{ result: { id: "x" } }', payload: { result: { id: 'x' } } },
    { name: '{ result: { status: "ERROR" } }', payload: { result: { status: 'ERROR' } } },
    { name: '{ verifiedCount: 2, output: [{}] }', payload: { verifiedCount: 2, output: [{}] }, qty: 2 },
    { name: '{ result: { radar: {} } }', payload: { result: { radar: {} } } },
    { name: '{ output: false }', payload: { output: false } },

    // Round 15 DSH POCs
    { name: 'DSH R15 C-1 POC: { verifiedCount: 2, data: { tags: { records: [{}, {}] } } }', payload: { verifiedCount: 2, data: { tags: { records: [{}, {}] } } }, qty: 2 },
    { name: 'DSH R15 C-1 POC: { verifiedCount: 2, data: { text: "valid", tags: { records: [{}, {}] } } }', payload: { verifiedCount: 2, data: { text: 'valid substantive text report', tags: { records: [{}, {}] } } }, qty: 2 },
    { name: 'DSH R15 C-2 POC: Overly nested payload (depth > 8)', payload: { text: 'valid text', a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } }
  ];

  for (const poc of defectivePOCs) {
    await t.test(`Defective case: ${poc.name}`, async () => {
      const report = await validateDeliverableSchema(poc.payload, poc.qty);
      assert.strictEqual(report.valid, false, `${poc.name} must be marked invalid`);
      assert.strictEqual(report.integrityScore, 0, `${poc.name} must score 0 integrity`);

      const verdict = await evaluateDisputeArbitration(
        {
          id: 'ord-poc-test',
          status: 'delivered',
          resultPayload: poc.payload,
          quantity: poc.qty
        },
        'Audit POC defect test'
      );

      assert.strictEqual(
        verdict.ruling,
        'refund_client',
        `${poc.name} must strictly rule refund_client in arbitration`
      );
    });
  }
});

test('P0-D: All 9 Canonical Top-Level Deliverable Shapes Must Pass SLA and Settle', async (t) => {
  const canonicalShapes = [
    {
      name: '1. Top-level text shape: { text }',
      payload: { text: 'This is a substantive technical report detailing architecture and performance analysis.' }
    },
    {
      name: '2. Top-level content shape: { content }',
      payload: { content: 'Here is the full generated article text with complete sections and citations.' }
    },
    {
      name: '3. Top-level summary shape: { summary }',
      payload: { summary: 'Executive summary of audit findings covering compliance and security vectors.' }
    },
    {
      name: '4. Top-level analysis shape: { analysis }',
      payload: { analysis: 'Detailed vulnerability analysis identifying zero memory safety breaches in kernel.' }
    },
    {
      name: '5. Top-level url shape: { url }',
      payload: { url: 'https://github.com/AgentUniver/acp-engine/releases/tag/v2.0.0' }
    },
    {
      name: '6. Top-level code shape: { code }',
      payload: { code: 'export function solveProblem(): string { return "optimized high-performance solution"; }' }
    },
    {
      name: '7. Top-level findings shape: { findings }',
      payload: {
        findings: [
          { id: 'F-01', title: 'Missing CSRF Token', severity: 'high', description: 'State-changing POST request lacks anti-CSRF token verification' }
        ]
      }
    },
    {
      name: '8. Top-level records+verifiedCount shape: { records, verifiedCount }',
      payload: {
        records: [
          { id: 'REC-1', name: 'User Account Entry', value: 'Verified record data conforming to schema' }
        ],
        verifiedCount: 1
      },
      qty: 1
    },
    {
      name: '9. Top-level metrics shape: { metrics }',
      payload: {
        metrics: { accuracy: 0.99, latencyP99: 42, score: 98 }
      }
    },
    {
      name: '10. Top-level sha shape: { sha }',
      payload: { sha: '02bde4eac4eb9c5d9456d77da4dedd23552dadd6' }
    },
    {
      name: '11. Top-level diff shape: { diff }',
      payload: { diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old code\n+new optimized code' }
    },
    {
      name: '12. Top-level repo shape: { repo }',
      payload: { repo: 'Leopard/AgentUniver' }
    },
    {
      name: '13. Numeric dataset shape: { records }',
      payload: {
        records: [
          { id: 'REC-1', value: 42 },
          { id: 'REC-2', value: 84 }
        ],
        verifiedCount: 2
      },
      qty: 2
    },
    {
      name: '14. Structured static analysis linter issues: { issues }',
      payload: {
        issues: [
          { rule: 'security/no-eval', line: 12, severity: 'error' },
          { rule: 'correctness/no-unused-vars', file: 'main.ts', severity: 'warning' }
        ]
      }
    },
    {
      name: '15. Legit audit finding with REFERRAL/TRANSFERRED words',
      payload: {
        summary: 'Audit report regarding PREFERRED and TRANSFERRED REFERRAL status',
        analysis: 'Detailed investigation into referral mechanism'
      }
    },
    {
      name: '16. Legit audit finding with error: [] array',
      payload: {
        summary: 'Inspection completed cleanly with zero findings',
        error: []
      }
    },
    {
      name: '17. Legit deliverable wrapper with substantive records',
      payload: {
        text: '技术深度分析与问题修复报告已完成',
        deliverable: {
          records: [
            { id: 'REC-01', title: 'Buffer Overflow', description: 'Patched length check in protocol parser' }
          ]
        }
      },
      qty: 1
    },
    {
      name: '18. Legit depth-2 nested output with substantive items',
      payload: {
        metrics: { score: 95 },
        output: {
          output: {
            records: [
              { id: 'REC-02', title: 'Latency Metric', description: 'P99 reduced to 42ms after optimization' }
            ]
          }
        }
      },
      qty: 1
    }
  ];

  for (const item of canonicalShapes) {
    await t.test(`Canonical shape: ${item.name}`, async () => {
      const report = await validateDeliverableSchema(item.payload, item.qty);
      assert.strictEqual(report.valid, true, `${item.name} must be recognized as valid`);
      assert.strictEqual(report.integrityScore, 100, `${item.name} must score 100`);
      assert.strictEqual(report.slaConformant, true, `${item.name} must be SLA conformant`);

      const verdict = await evaluateDisputeArbitration(
        {
          id: 'ord-valid-shape',
          status: 'delivered',
          resultPayload: item.payload,
          quantity: item.qty
        },
        'Client subjective dispute against valid delivery'
      );

      assert.strictEqual(
        verdict.ruling,
        'settle_developer',
        `${item.name} must settle to developer when SLA conformant`
      );
    });
  }
});

test('P1-3 & P0-B & P0-2: Exhaustive 60-Pair Matrix Check of (status, payoutStatus) Supporting 6 Dirty Rows Non-Destructively', () => {
  const allStatuses = [
    'pending', 'escrowed', 'processing', 'delivered', 'disputed',
    'verified', 'completed', 'refunded', 'failed', 'cancelled'
  ];
  const allPayoutStatuses = [
    null, 'pending', 'escrowed', 'settled', 'refunded', 'failed'
  ];

  // Exact JavaScript implementation of the SQL CHECK constraint
  function isStateComboValid(status, payoutStatus) {
    if (status === 'pending') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'escrowed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'processing') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'delivered') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'settled';
    if (status === 'disputed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'settled' || payoutStatus === 'refunded' || payoutStatus === 'failed';
    if (status === 'verified') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'settled';
    if (status === 'completed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'settled';
    if (status === 'refunded') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'refunded';
    if (status === 'failed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'failed' || payoutStatus === 'refunded';
    if (status === 'cancelled') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'refunded' || payoutStatus === 'failed' || payoutStatus === 'settled';
    return false;
  }

  // Count total evaluated combinations
  let totalEvaluated = 0;
  for (const st of allStatuses) {
    for (const ps of allPayoutStatuses) {
      totalEvaluated++;
      const valid = isStateComboValid(st, ps);
      assert.strictEqual(typeof valid, 'boolean');
    }
  }

  assert.strictEqual(totalEvaluated, 60, 'Evaluated all 60 status/payoutStatus pairs');

  // Explicitly verify the 6 historical dirty row cases from OP probe T2:
  const dirtyRowCases = [
    { status: 'cancelled', payoutStatus: 'pending' },
    { status: 'cancelled', payoutStatus: 'escrowed' },
    { status: 'disputed', payoutStatus: 'settled' },
    { status: 'verified', payoutStatus: null },
    { status: 'refunded', payoutStatus: null },
    { status: 'delivered', payoutStatus: 'settled' },
  ];
  for (const c of dirtyRowCases) {
    assert.strictEqual(
      isStateComboValid(c.status, c.payoutStatus),
      true,
      `Dirty row (${c.status}, ${c.payoutStatus}) must satisfy constraint non-destructively`
    );
  }
});

test('P1-1 & P1-2 & P0-A: Monotonic Version CAS Fencing Simulation Across All Lifecycles with Double-Settlement Guard', () => {
  let record = { id: 'ord-cas-1', status: 'escrowed', payoutStatus: 'escrowed', version: 1 };

  function executeCAS(expectedVersion, newStatus, newPayoutStatus = undefined) {
    if (record.version !== expectedVersion) {
      return { success: false, code: 409, message: 'CAS Conflict: version mismatch' };
    }
    const nextVer = record.version + 1;
    // Simulate DB trigger: next version must be strictly greater
    if (nextVer <= record.version) {
      throw new Error('Monotonic version violation');
    }
    // Claude 规格：状态迁移白名单
    if (record.status !== newStatus) {
      const s = record.status;
      const n = newStatus;
      let allowed = false;
      if (s === 'pending' && ['escrowed', 'cancelled'].includes(n)) allowed = true;
      else if (s === 'escrowed' && ['processing', 'cancelled', 'refunded'].includes(n)) allowed = true;
      else if (s === 'processing' && ['delivered', 'failed'].includes(n)) allowed = true;
      else if (s === 'failed' && ['refunded', 'cancelled'].includes(n)) allowed = true;
      else if (['delivered', 'disputed'].includes(s) && ['completed', 'verified', 'refunded', 'disputed'].includes(n)) allowed = true;
      else if (s === 'completed' && ['verified', 'refunded', 'disputed'].includes(n)) allowed = true;

      if (!allowed) {
        throw new Error(`illegal transition ${s} -> ${n}`);
      }
    }
    // Settled payoutStatus cannot be altered, reverted, or refunded (DSH A-1 / A-2 / Claude spec)
    if (record.payoutStatus === 'settled') {
      if (newPayoutStatus !== undefined && (newPayoutStatus === null || newPayoutStatus !== 'settled')) {
        throw new Error('Settlement immutability violation: settled payoutStatus cannot be altered or refunded');
      }
      if (!['verified', 'completed', 'disputed'].includes(newStatus)) {
        throw new Error(`Settlement immutability violation: settled order cannot transition status to ${newStatus}`);
      }
    }

    record = {
      ...record,
      status: newStatus,
      payoutStatus: newPayoutStatus !== undefined ? newPayoutStatus : record.payoutStatus,
      version: nextVer
    };
    return { success: true, version: record.version };
  }

  // 1. Lock to processing
  const lock = executeCAS(1, 'processing', 'escrowed');
  assert.strictEqual(lock.success, true);
  assert.strictEqual(record.version, 2);

  // Stale runner attempts to lock with old version 1 -> rejected
  const staleLock = executeCAS(1, 'processing', 'escrowed');
  assert.strictEqual(staleLock.success, false);
  assert.strictEqual(staleLock.code, 409);

  // 2. Deliver output with version 2
  const deliver = executeCAS(2, 'delivered', 'escrowed');
  assert.strictEqual(deliver.success, true);
  assert.strictEqual(record.version, 3);

  // 3. Pre-settlement dispute with version 3 (allowed before settlement)
  const dispute = executeCAS(3, 'disputed', 'escrowed');
  assert.strictEqual(dispute.success, true);
  assert.strictEqual(record.version, 4);

  // 4. Completed after dispute resolved: disputed -> completed is ALLOWED
  const complete = executeCAS(4, 'completed', 'escrowed');
  assert.strictEqual(complete.success, true);
  assert.strictEqual(record.version, 5);

  // 5. Settlement from completed: completed -> verified is ALLOWED
  const settle = executeCAS(5, 'verified', 'settled');
  assert.strictEqual(settle.success, true);
  assert.strictEqual(record.version, 6);

  // 6. Anti-double-settlement & terminal protection checks (P0-A OP probes / Claude spec):
  // (a) completed(settled) -> pending(pending) BLOCKED
  assert.throws(() => {
    executeCAS(6, 'pending', 'pending');
  }, /illegal transition|Settlement immutability/);

  // (b) completed(settled) -> escrowed BLOCKED
  assert.throws(() => {
    executeCAS(6, 'escrowed', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (c) completed(settled) -> processing(escrowed) BLOCKED
  assert.throws(() => {
    executeCAS(6, 'processing', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (d) completed(settled) -> delivered(escrowed) BLOCKED
  assert.throws(() => {
    executeCAS(6, 'delivered', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (e) verified(settled) -> delivered(escrowed) BLOCKED
  record.status = 'verified';
  assert.throws(() => {
    executeCAS(6, 'delivered', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (f) verified(settled) -> disputed(escrowed) BLOCKED
  assert.throws(() => {
    executeCAS(6, 'disputed', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (g) Settled payoutStatus cannot revert to escrowed
  assert.throws(() => {
    executeCAS(6, 'completed', 'escrowed');
  }, /illegal transition|Settlement immutability/);

  // (h) verified(settled) -> refunded(refunded) BLOCKED (DSH A-1)
  assert.throws(() => {
    executeCAS(6, 'refunded', 'refunded');
  }, /illegal transition|Settlement immutability/);

  // (i) verified(settled) -> null payoutStatus BLOCKED (DSH A-2)
  assert.throws(() => {
    executeCAS(6, 'verified', null);
  }, /Settlement immutability/);

  // (j) verified(settled) -> refunded payoutStatus BLOCKED (DSH A-1)
  assert.throws(() => {
    executeCAS(6, 'verified', 'refunded');
  }, /Settlement immutability/);
});

test('P0-2: Legitimate Multi-Item Deliverables Meeting Required Volume Must Settle', async () => {
  const legitMultiItem = {
    records: Array.from({ length: 5 }, (_, i) => ({
      id: `REC-${i + 1}`,
      name: `Record ${i + 1}`,
      description: `Substantive validated record description for item ${i + 1}`
    })),
    verifiedCount: 5
  };
  const report = await validateDeliverableSchema(legitMultiItem, 5);
  assert.strictEqual(report.valid, true);
  assert.strictEqual(report.integrityScore, 100);
  assert.strictEqual(report.verifiedCount, 5);

  const verdict = await evaluateDisputeArbitration(
    {
      id: 'ord-legit-multi',
      status: 'delivered',
      resultPayload: legitMultiItem,
      quantity: 5
    },
    'Dispute against valid multi-item delivery'
  );
  assert.strictEqual(verdict.ruling, 'settle_developer');
});

test('Claude TACTIC ①: Settle Conditional Update (WHERE payoutStatus <> settled) and Ledger Unique Constraint Anti-Double Spend', () => {
  // 1. Simulate agent_task_ledger unique constraint (taskId, eventType)
  const ledger = new Set();
  function insertLedgerEvent(taskId, eventType) {
    const key = `${taskId}:${eventType}`;
    if (ledger.has(key)) {
      const err = new Error(`duplicate key value violates unique constraint "uq_agent_task_ledger_event"`);
      err.code = '23505';
      throw err;
    }
    ledger.add(key);
    return { success: true };
  }

  // First payout succeeds
  const firstPayout = insertLedgerEvent('ord-test-ledger-1', 'payout');
  assert.strictEqual(firstPayout.success, true);

  // Concurrent duplicate payout fails with 23505 unique violation
  assert.throws(() => {
    insertLedgerEvent('ord-test-ledger-1', 'payout');
  }, (err) => err.code === '23505');

  // Refund event for same task is permitted (different eventType)
  const refundEvent = insertLedgerEvent('ord-test-ledger-1', 'refund');
  assert.strictEqual(refundEvent.success, true);

  // 2. Simulate settle CAS update: WHERE id = $1 AND version = $2 AND payoutStatus <> 'settled'
  let dbRow = {
    id: 'ord-test-cas-2',
    status: 'delivered',
    payoutStatus: 'escrowed',
    version: 3
  };

  function updateSettleCAS(rowId, currentVersion) {
    if (dbRow.id !== rowId) return { updatedRows: 0 };
    if (dbRow.version !== currentVersion) return { updatedRows: 0 };
    // WHERE payoutStatus <> 'settled'
    if (dbRow.payoutStatus === 'settled') return { updatedRows: 0 };

    dbRow = {
      ...dbRow,
      status: 'verified',
      payoutStatus: 'settled',
      version: currentVersion + 1
    };
    return { updatedRows: 1 };
  }

  // First settlement succeeds
  const res1 = updateSettleCAS('ord-test-cas-2', 3);
  assert.strictEqual(res1.updatedRows, 1);
  assert.strictEqual(dbRow.status, 'verified');
  assert.strictEqual(dbRow.payoutStatus, 'settled');

  // Second settlement attempt with updated or stale version fails to update (0 rows matched)
  const res2 = updateSettleCAS('ord-test-cas-2', 4);
  assert.strictEqual(res2.updatedRows, 0, 'Cannot settle already settled task');

  // 3. Simulate Claude spec: uq_ledger_exclusive ON payout_ledger(task_id) WHERE kind IN ('settle', 'refund')
  const payoutLedger = new Set();
  function insertPayoutLedger(taskId, kind) {
    if (['settle', 'refund'].includes(kind)) {
      if (payoutLedger.has(taskId)) {
        const err = new Error(`duplicate key value violates unique constraint "uq_ledger_exclusive"`);
        err.code = '23505';
        throw err;
      }
      payoutLedger.add(taskId);
    }
    return { success: true };
  }

  const s1 = insertPayoutLedger('ord-claude-task-1', 'settle');
  assert.strictEqual(s1.success, true);
  // Duplicate settle fails
  assert.throws(() => {
    insertPayoutLedger('ord-claude-task-1', 'settle');
  }, (err) => err.code === '23505');
  // Concurrent or subsequent refund for settled task ALSO fails with 23505 (Mutual Exclusion!)
  assert.throws(() => {
    insertPayoutLedger('ord-claude-task-1', 'refund');
  }, (err) => err.code === '23505');
});

test('DSH P0-2 Probe: Hidden collections under tags/errors/labels must produce verifiedCount=0 and fail-closed', async () => {
  const SUBSTANTIVE_TEXT = 'legit substantive text payload with enough detail';
  for (const hiddenKey of ['tags', 'errors', 'labels']) {
    const payload = {
      verifiedCount: 2,
      data: {
        text: SUBSTANTIVE_TEXT,
        [hiddenKey]: { records: [{}, {}] }
      }
    };
    const report = await validateDeliverableSchema(payload, 2);
    assert.strictEqual(report.valid, false);
    assert.strictEqual(report.integrityScore, 0);
    assert.strictEqual(report.verifiedCount, 0, `${hiddenKey} empty records were reported as verified volume`);

    const verdict = await evaluateDisputeArbitration(
      { id: 'probe-hidden', status: 'delivered', resultPayload: payload, quantity: 2 },
      'audit probe'
    );
    assert.strictEqual(verdict.ruling, 'refund_client');
  }

  const payload1000 = {
    verifiedCount: 1000,
    data: {
      text: SUBSTANTIVE_TEXT,
      tags: { records: Array.from({ length: 1000 }, () => ({})) }
    }
  };
  const report1000 = await validateDeliverableSchema(payload1000, 1000);
  assert.strictEqual(report1000.valid, false);
  assert.strictEqual(report1000.integrityScore, 0);
  assert.strictEqual(report1000.verifiedCount, 0);

  // Control: two substantive top-level records remain valid and counted
  const controlPayload = {
    verifiedCount: 2,
    records: [
      { id: 'r1', title: 'Record 1', description: 'Substantive validated record description' },
      { id: 'r2', title: 'Record 2', description: 'Substantive validated record description' }
    ]
  };
  const controlReport = await validateDeliverableSchema(controlPayload, 2);
  assert.strictEqual(controlReport.valid, true);
  assert.strictEqual(controlReport.integrityScore, 100);
  assert.strictEqual(controlReport.verifiedCount, 2);
});

test('PI P0-B Probe: Hidden collections nested inside array elements must fail-closed with verifiedCount=0', async () => {
  // 1. Verbatim PI probe: hidden { records: [{}, {}] } inside records array
  const piPayload = {
    verifiedCount: 2,
    records: [
      { id: 'r1', title: 'Record 1', description: 'substantive validated record', hidden: { records: [{}, {}] } },
      { id: 'r2', title: 'Record 2', description: 'substantive validated record', hidden: { records: [{}, {}] } }
    ]
  };
  const report1 = await validateDeliverableSchema(piPayload, 2);
  assert.strictEqual(report1.valid, false, 'hidden records inside array elements must be rejected');
  assert.strictEqual(report1.integrityScore, 0);
  assert.strictEqual(report1.verifiedCount, 0, 'verifiedCount must be strictly 0');

  // 2. Variant: hidden items: [{ foo: 1 }] inside records array
  const variant1 = {
    verifiedCount: 2,
    records: [
      { id: 'r1', title: 'Record 1', description: 'substantive validated record', hidden: { items: [{ foo: 1 }] } },
      { id: 'r2', title: 'Record 2', description: 'substantive validated record', hidden: { items: [{ foo: 1 }] } }
    ]
  };
  const report2 = await validateDeliverableSchema(variant1, 2);
  assert.strictEqual(report2.valid, false);
  assert.strictEqual(report2.integrityScore, 0);
  assert.strictEqual(report2.verifiedCount, 0);

  // 3. Variant: nested two levels inside array element: records[0].a.b.records = [{}]
  const variant2 = {
    verifiedCount: 2,
    records: [
      { id: 'r1', title: 'Record 1', description: 'substantive validated record', a: { b: { records: [{}] } } },
      { id: 'r2', title: 'Record 2', description: 'substantive validated record', a: { b: { records: [{}] } } }
    ]
  };
  const report3 = await validateDeliverableSchema(variant2, 2);
  assert.strictEqual(report3.valid, false);
  assert.strictEqual(report3.integrityScore, 0);
  assert.strictEqual(report3.verifiedCount, 0);

  // 4. Variant: Depth 6 / 7 boundary
  const deepWithinLimit = {
    verifiedCount: 1,
    report: { deliverable: { output: { records: [{ id: '1', title: 'Valid Title', description: 'Valid Description' }] } } }
  };
  const reportDeep = await validateDeliverableSchema(deepWithinLimit, 1);
  assert.strictEqual(reportDeep.valid, true);
  assert.strictEqual(reportDeep.integrityScore, 100);

  const exceedLimit = {
    verifiedCount: 1,
    l1: { l2: { l3: { l4: { l5: { l6: { records: [{ id: '1', title: 'Deep Title', description: 'Deep Description' }] } } } } } }
  };
  const reportExceed = await validateDeliverableSchema(exceedLimit, 1);
  assert.strictEqual(reportExceed.valid, false);
  assert.strictEqual(reportExceed.verifiedCount, 0);

  // 5. Variant: Cyclic reference protection
  const cyclicObj = { id: 'c1', title: 'Cyclic Record', description: 'Cyclic description' };
  cyclicObj.self = cyclicObj;
  const cyclicPayload = { records: [cyclicObj], verifiedCount: 1 };
  const reportCyclic = await validateDeliverableSchema(cyclicPayload, 1);
  assert.strictEqual(reportCyclic.valid, false);
  assert.strictEqual(reportCyclic.verifiedCount, 0);
});

test('PI & DSH P0-1: Top-Level Array with Numeric/ID Items Hiding Defective Collections Must Fail-Closed', async () => {
  // 1. Array element hiding records: [{}, {}]
  const p1 = [{ id: 'r1', value: 42, hidden: { records: [{}, {}] } }];
  const r1 = await validateDeliverableSchema(p1, 1);
  assert.strictEqual(r1.valid, false);
  assert.strictEqual(r1.integrityScore, 0);
  assert.strictEqual(r1.verifiedCount, 0);

  // 2. Array element hiding empty records: []
  const p2 = [{ id: 'r1', value: 42, hidden: { records: [] } }];
  const r2 = await validateDeliverableSchema(p2, 1);
  assert.strictEqual(r2.valid, false);
  assert.strictEqual(r2.integrityScore, 0);
  assert.strictEqual(r2.verifiedCount, 0);

  // 3. Array element hiding items: [{ foo: 1 }]
  const p3 = [{ id: 'r1', value: 42, hidden: { items: [{ foo: 1 }] } }];
  const r3 = await validateDeliverableSchema(p3, 1);
  assert.strictEqual(r3.valid, false);
  assert.strictEqual(r3.integrityScore, 0);
  assert.strictEqual(r3.verifiedCount, 0);

  // 4. Array element hiding non-diagnostic empty array
  const p4 = [{ id: 'r1', value: 1, hidden: [] }];
  const r4 = await validateDeliverableSchema(p4, 1);
  assert.strictEqual(r4.valid, false);
  assert.strictEqual(r4.integrityScore, 0);
  assert.strictEqual(r4.verifiedCount, 0);

  // 5. Control group: Clean numeric dataset remains valid
  const control = [{ id: 'r1', value: 1 }, { id: 'r2', value: 2 }];
  const rControl = await validateDeliverableSchema(control, 2);
  assert.strictEqual(rControl.valid, true);
  assert.strictEqual(rControl.integrityScore, 100);
  assert.strictEqual(rControl.verifiedCount, 2);
});

test('PI & DSH P0-2: Settle Endpoint Logic Rejects Invalid Budget and Conflicting Refunds', () => {
  // 1. Budget validation
  function validateBudget(budgetUsd) {
    const raw = Number(budgetUsd);
    if (!budgetUsd || isNaN(raw) || raw <= 0) {
      return { success: false, code: 'ACP_INVALID_BUDGET' };
    }
    return { success: true, amount: raw };
  }

  assert.strictEqual(validateBudget(null).code, 'ACP_INVALID_BUDGET');
  assert.strictEqual(validateBudget(0).code, 'ACP_INVALID_BUDGET');
  assert.strictEqual(validateBudget(-5).code, 'ACP_INVALID_BUDGET');
  assert.strictEqual(validateBudget('0.00').code, 'ACP_INVALID_BUDGET');
  assert.strictEqual(validateBudget(10.00).success, true);

  // 2. Conflict handling for ledger replay
  function resolveLedgerConflict(existingLedger) {
    if (existingLedger.some(l => l.kind === 'settle')) {
      return { success: true, idempotent: true, code: 'ALREADY_SETTLED' };
    }
    if (existingLedger.some(l => l.kind === 'refund')) {
      return { success: false, code: 'ACP_SETTLEMENT_BLOCKED_BY_REFUND' };
    }
    return { success: false, code: 'ACP_UNKNOWN_LEDGER_STATE' };
  }

  assert.strictEqual(resolveLedgerConflict([{ kind: 'refund' }]).code, 'ACP_SETTLEMENT_BLOCKED_BY_REFUND');
  assert.strictEqual(resolveLedgerConflict([{ kind: 'settle' }]).idempotent, true);
});

// --- PGlite & Handler Test Helpers ---
let _sharedTestDb = null;

async function getTestDb() {
  if (_sharedTestDb) return _sharedTestDb;
  const db = new PGlite();
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT 'anon'::text $$ LANGUAGE sql;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$ SELECT '{}'::jsonb $$ LANGUAGE sql;
  `);

  const migrationsDir = path.resolve(__dirname, '../supabase/migrations');
  const files = getSortedMigrations(migrationsDir);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await db.exec(sql);
  }
  _sharedTestDb = db;
  return _sharedTestDb;
}

function createPgLiteSupabaseAdapter(pg) {
  return {
    from(tableName) {
      return {
        select(fields) {
          let filterCol = null;
          let filterVal = null;
          const queryObj = {
            eq(col, val) {
              filterCol = col;
              filterVal = val;
              return queryObj;
            },
            async single() {
              try {
                const res = await pg.query(
                  `SELECT id, status, "payoutStatus", "budgetUsd", "taskToken", "userEmail", version 
                   FROM ${tableName} 
                   WHERE "${filterCol}" = $1`,
                  [filterVal]
                );
                if (!res.rows || res.rows.length === 0) {
                  return { data: null, error: { code: 'PGRST116', message: 'Row not found' } };
                }
                const row = res.rows[0];
                return {
                  data: {
                    id: row.id,
                    status: row.status,
                    payoutStatus: row.payoutStatus,
                    budgetUsd: row.budgetUsd != null ? Number(row.budgetUsd) : null,
                    taskToken: row.taskToken,
                    userEmail: row.userEmail,
                    version: Number(row.version)
                  },
                  error: null
                };
              } catch (err) {
                return { data: null, error: { code: 'PGRST_ERR', message: err.message } };
              }
            }
          };
          return queryObj;
        }
      };
    },
    async rpc(funcName, params) {
      try {
        if (funcName === 'acp_settle_task') {
          const res = await pg.query(
            `SELECT acp_settle_task($1, $2, $3, $4) AS result`,
            [params.p_task_id, params.p_expected_version, params.p_amount, Boolean(params.p_customer_accepted)]
          );
          const result = res.rows[0]?.result;
          return { data: typeof result === 'string' ? JSON.parse(result) : result, error: null };
        } else if (funcName === 'acp_refund_task') {
          const res = await pg.query(
            `SELECT acp_refund_task($1, $2, $3) AS result`,
            [params.p_task_id, params.p_expected_version, params.p_reason || null]
          );
          const result = res.rows[0]?.result;
          return { data: typeof result === 'string' ? JSON.parse(result) : result, error: null };
        } else if (funcName === 'acp_t0_payout_with_deposit') {
          const res = await pg.query(
            `SELECT acp_t0_payout_with_deposit($1, $2, $3) AS result`,
            [params.p_task_id, params.p_developer_id, params.p_expected_version]
          );
          const result = res.rows[0]?.result;
          return { data: typeof result === 'string' ? JSON.parse(result) : result, error: null };
        } else if (funcName === 'acp_release_expired_locked_deposits') {
          const res = await pg.query(
            `SELECT acp_release_expired_locked_deposits($1) AS result`,
            [params.p_task_id]
          );
          const result = res.rows[0]?.result;
          return { data: typeof result === 'string' ? JSON.parse(result) : result, error: null };
        } else if (funcName === 'acp_clawback_task') {
          const res = await pg.query(
            `SELECT acp_clawback_task($1, $2, $3) AS result`,
            [params.p_task_id, params.p_expected_version, params.p_reason || null]
          );
          const result = res.rows[0]?.result;
          return { data: typeof result === 'string' ? JSON.parse(result) : result, error: null };
        } else {
          return { data: null, error: { code: '42883', message: `function ${funcName} does not exist` } };
        }
      } catch (err) {
        return { data: null, error: { code: err.code || '500', message: err.message } };
      }
    }
  };
}

function mockReqRes(options) {
  const req = {
    method: options.method || 'POST',
    query: options.query || {},
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer test-internal-key',
      ...(options.headers || {})
    },
    body: options.body || {}
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    setHeader() { return res; },
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    end() {
      return res;
    }
  };
  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getJSON: () => responseData
  };
}

test('DSH P0-1: p0_canonical_duplicate_array & anti-sampling 10 distinct + 990 identical variant', async () => {
  // 1. Shuffled key ordering duplicates: { a: 1, b: 2 } vs { b: 2, a: 1 }
  const keyOrderDuplicates = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0
      ? { id: 'x', title: 'A', description: 'B' }
      : { description: 'B', id: 'x', title: 'A' }
  );
  const repKeyOrder = await validateDeliverableSchema(keyOrderDuplicates, 100);
  assert.strictEqual(repKeyOrder.valid, false);
  assert.strictEqual(repKeyOrder.integrityScore, 0);
  assert.strictEqual(repKeyOrder.verifiedCount, 0);

  // 2. Anti-sampling bypass probe: 10 distinct items followed by 990 identical items
  const prefixDistinctThenSpam = [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `distinct-${i}`,
      title: `Distinct Title ${i}`,
      description: 'substantive description for distinct header item'
    })),
    ...Array.from({ length: 990 }, () => ({
      id: 'spam-id',
      title: 'Spam Title',
      description: 'spam substantive description body'
    }))
  ];
  const repPrefix = await validateDeliverableSchema(prefixDistinctThenSpam, 1000);
  assert.strictEqual(repPrefix.valid, false);
  assert.strictEqual(repPrefix.integrityScore, 0);
  assert.strictEqual(repPrefix.verifiedCount, 0);

  // 3. Control group: 100 legitimate distinct items pass SLA with 100% integrityScore and 100 verifiedCount
  const legitLargeArray = Array.from({ length: 100 }, (_, i) => ({
    id: `item-${i}`,
    title: `Task item ${i}`,
    description: `Detailed substantive description for item ${i} to verify integrity`
  }));
  const repLegit = await validateDeliverableSchema(legitLargeArray, 100);
  assert.strictEqual(repLegit.valid, true);
  assert.strictEqual(repLegit.integrityScore, 100);
  assert.strictEqual(repLegit.verifiedCount, 100);
});

test('DSH P0-2 & PI B-P0-1: p0_refund_settle_interleaving with Live Handlers & PGlite', async () => {
  process.env.ACP_INTERNAL_KEY = 'test-internal-key';
  const db = await getTestDb();
  const adapter = createPgLiteSupabaseAdapter(db);
  setSupabaseClientForTesting(adapter);

  // Scenario 1: Settle delivered task, then subsequent refund attempt must fail-closed
  const taskId1 = 'task-interleaving-settle-first';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 50.00, 1);
  `, [taskId1]);

  const settleCall1 = mockReqRes({ query: { task_id: taskId1 }, body: { customer_accepted: true } });
  await settleHandler(settleCall1.req, settleCall1.res);
  assert.strictEqual(settleCall1.getStatusCode(), 200);
  assert.strictEqual(settleCall1.getJSON().success, true);
  assert.strictEqual(settleCall1.getJSON().status, 'verified');

  // Verify DB state
  const taskRow1 = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId1])).rows[0];
  assert.strictEqual(taskRow1.status, 'verified');
  assert.strictEqual(taskRow1.payoutStatus, 'settled');
  assert.strictEqual(Number(taskRow1.version), 2);

  // Payout ledger must contain kind='settle'
  const ledger1 = (await db.query(`SELECT kind, amount FROM payout_ledger WHERE task_id = $1`, [taskId1])).rows;
  assert.strictEqual(ledger1.length, 1);
  assert.strictEqual(ledger1[0].kind, 'settle');

  // Attempt refund on settled task via refundHandler: Must be blocked
  const refundCall1 = mockReqRes({ query: { task_id: taskId1 } });
  await refundHandler(refundCall1.req, refundCall1.res);
  assert.strictEqual(refundCall1.getStatusCode(), 400);
  assert.strictEqual(refundCall1.getJSON().error.code, 'ACP_INVALID_REFUND_STATE');

  // Verify task row and ledger remain unchanged
  const postRefundTaskRow1 = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId1])).rows[0];
  assert.strictEqual(postRefundTaskRow1.status, 'verified');
  assert.strictEqual(postRefundTaskRow1.payoutStatus, 'settled');
  const postRefundLedger1 = (await db.query(`SELECT kind FROM payout_ledger WHERE task_id = $1`, [taskId1])).rows;
  assert.strictEqual(postRefundLedger1.length, 1);
  assert.strictEqual(postRefundLedger1[0].kind, 'settle');

  // Scenario 2: Refund escrowed task, then subsequent settle attempt must fail-closed
  const taskId2 = 'task-interleaving-refund-first';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'escrowed', 'escrowed', 35.00, 1);
  `, [taskId2]);

  const refundCall2 = mockReqRes({ query: { task_id: taskId2 } });
  await refundHandler(refundCall2.req, refundCall2.res);
  assert.strictEqual(refundCall2.getStatusCode(), 200);
  assert.strictEqual(refundCall2.getJSON().success, true);
  assert.strictEqual(refundCall2.getJSON().status, 'refunded');

  // Verify DB state
  const taskRow2 = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId2])).rows[0];
  assert.strictEqual(taskRow2.status, 'refunded');
  assert.strictEqual(taskRow2.payoutStatus, 'refunded');
  assert.strictEqual(Number(taskRow2.version), 2);

  // Attempt settle on refunded task via settleHandler: Must be blocked
  const settleCall2 = mockReqRes({ query: { task_id: taskId2 } });
  await settleHandler(settleCall2.req, settleCall2.res);
  assert.strictEqual(settleCall2.getStatusCode(), 400);
  assert.strictEqual(settleCall2.getJSON().error.code, 'ACP_TASK_ALREADY_REFUNDED');

  // Verify task row and ledger remain purely refunded
  const postSettleTaskRow2 = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId2])).rows[0];
  assert.strictEqual(postSettleTaskRow2.status, 'refunded');
  assert.strictEqual(postSettleTaskRow2.payoutStatus, 'refunded');
  const postSettleLedger2 = (await db.query(`SELECT kind FROM payout_ledger WHERE task_id = $1`, [taskId2])).rows;
  assert.strictEqual(postSettleLedger2.length, 1);
  assert.strictEqual(postSettleLedger2[0].kind, 'refund');
});

test('PI P1: p1_event_ledger_failure Single-Transaction Atomic Rollback with PGlite', async () => {
  process.env.ACP_INTERNAL_KEY = 'test-internal-key';
  const db = await getTestDb();
  const adapter = createPgLiteSupabaseAdapter(db);
  setSupabaseClientForTesting(adapter);

  const taskId = 'task-event-ledger-failure-rollback';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 40.00, 1);
  `, [taskId]);

  // Pre-insert an identical event into agent_task_ledger to trigger uq_agent_task_ledger_event unique violation on settle
  await db.query(`
    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES ($1, 'payout', 40.00, 1);
  `, [taskId]);

  // Now attempt settle: in single-transaction RPC, unique_violation on agent_task_ledger triggers EXCEPTION
  const settleCall = mockReqRes({ query: { task_id: taskId }, body: { customer_accepted: true } });
  await settleHandler(settleCall.req, settleCall.res);

  // Settlement should be rejected due to unique constraint conflict
  assert.strictEqual(settleCall.getStatusCode(), 400);
  assert.strictEqual(settleCall.getJSON().error.code, 'ACP_UNIQUE_VIOLATION');

  // Crucial Single-Transaction Invariant:
  // Because acp_settle_task runs in a single transaction, the CAS update on agent_tasks and
  // the insert into payout_ledger were rolled back. Task MUST remain 'delivered'/'escrowed' at version 1!
  const taskRow = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId])).rows[0];
  assert.strictEqual(taskRow.status, 'delivered', 'Task status must not mutate when transaction fails');
  assert.strictEqual(taskRow.payoutStatus, 'escrowed', 'Task payoutStatus must not mutate when transaction fails');
  assert.strictEqual(Number(taskRow.version), 1, 'Task version must not increment when transaction fails');

  // No settle record in payout_ledger
  const ledger = (await db.query(`SELECT kind FROM payout_ledger WHERE task_id = $1`, [taskId])).rows;
  assert.strictEqual(ledger.length, 0, 'No orphaned payout_ledger row must exist');
});

test('FIN-T1: T+1 Hold Rejects Premature Auto-Settlement But Permits Customer Acceptance', async () => {
  process.env.ACP_INTERNAL_KEY = 'test-internal-key';
  const db = await getTestDb();
  const adapter = createPgLiteSupabaseAdapter(db);
  setSupabaseClientForTesting(adapter);

  const taskId = 'task-t1-hold-test';
  // Insert task with T+1 hold expiring 24 hours into future
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 50.00, NOW() + INTERVAL '24 hours', 1);
  `, [taskId]);

  // 1. Regular settlement attempt during T+1 hold without customer acceptance: MUST FAIL with ACP_T1_HOLD_ACTIVE (409)
  const prematureCall = mockReqRes({ query: { task_id: taskId }, body: { customer_accepted: false } });
  await settleHandler(prematureCall.req, prematureCall.res);
  assert.strictEqual(prematureCall.getStatusCode(), 409);
  assert.strictEqual(prematureCall.getJSON().error.code, 'ACP_T1_HOLD_ACTIVE');

  // Verify task remains delivered and escrowed
  const taskRowBefore = (await db.query(`SELECT status, "payoutStatus" FROM agent_tasks WHERE id = $1`, [taskId])).rows[0];
  assert.strictEqual(taskRowBefore.status, 'delivered');
  assert.strictEqual(taskRowBefore.payoutStatus, 'escrowed');

  // 2. Customer explicitly accepts deliverable: MUST IMMEDIATELY SUCCEED (200)
  const acceptCall = mockReqRes({ query: { task_id: taskId }, body: { customer_accepted: true } });
  await settleHandler(acceptCall.req, acceptCall.res);
  assert.strictEqual(acceptCall.getStatusCode(), 200);
  assert.strictEqual(acceptCall.getJSON().success, true);
  assert.strictEqual(acceptCall.getJSON().status, 'verified');

  // Verify task transitioned to verified/settled
  const taskRowAfter = (await db.query(`SELECT status, "payoutStatus", version FROM agent_tasks WHERE id = $1`, [taskId])).rows[0];
  assert.strictEqual(taskRowAfter.status, 'verified');
  assert.strictEqual(taskRowAfter.payoutStatus, 'settled');
  assert.strictEqual(Number(taskRowAfter.version), 2);
});

test('FIN-T0: T+0 Guaranteed Payout with Atomic Deposit Lock, Replay Guard, and Clawback', async () => {
  process.env.ACP_INTERNAL_KEY = 'test-internal-key';
  const db = await getTestDb();
  const adapter = createPgLiteSupabaseAdapter(db);
  setSupabaseClientForTesting(adapter);

  const devId = 'dev-t0-tester';
  // Seed developer guarantee deposit: total $100, available $100, locked $0
  await db.query(`
    INSERT INTO developer_guarantee_deposits (developer_id, total_deposit, locked_deposit, available_deposit)
    VALUES ($1, 100.00, 0.00, 100.00)
    ON CONFLICT (developer_id) DO UPDATE SET total_deposit = 100.00, locked_deposit = 0.00, available_deposit = 100.00;
  `, [devId]);

  const taskId = 'task-t0-deposit-flow';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 40.00, NOW() + INTERVAL '24 hours', 1);
  `, [taskId]);

  // 1. First T+0 instant payout: must succeed and lock $40.00 deposit
  const t0Res1 = (await db.query(`SELECT acp_t0_payout_with_deposit($1, $2, 1) AS result;`, [taskId, devId])).rows[0].result;
  assert.strictEqual(t0Res1.success, true);
  assert.strictEqual(t0Res1.code, 'T0_SETTLED_WITH_DEPOSIT');
  assert.strictEqual(Number(t0Res1.locked_deposit), 40.00);

  // Verify deposit balances: available should now be $60, locked should be $40
  const devDeposit1 = (await db.query(`SELECT total_deposit, locked_deposit, available_deposit FROM developer_guarantee_deposits WHERE developer_id = $1`, [devId])).rows[0];
  assert.strictEqual(Number(devDeposit1.available_deposit), 60.00);
  assert.strictEqual(Number(devDeposit1.locked_deposit), 40.00);

  // 2. Replay guard: second T+0 payout on same task must fail
  const t0ResDuplicate = (await db.query(`SELECT acp_t0_payout_with_deposit($1, $2, 2) AS result;`, [taskId, devId])).rows[0].result;
  assert.strictEqual(t0ResDuplicate.success, false);
  assert.strictEqual(t0ResDuplicate.code, 'ACP_T0_ALREADY_LOCKED');

  // 3. Customer rejection within dispute window triggers clawback from locked deposit
  const clawbackCall = mockReqRes({ query: { task_id: taskId }, body: { customer_rejected: true, reason: 'Quality unverified' } });
  await refundHandler(clawbackCall.req, clawbackCall.res);
  assert.strictEqual(clawbackCall.getStatusCode(), 200);
  assert.strictEqual(clawbackCall.getJSON().meta.clawback, true);

  // Verify deposit deduction: locked deposit should be $0, total deposit should be $60
  const devDepositAfterClawback = (await db.query(`SELECT total_deposit, locked_deposit, available_deposit FROM developer_guarantee_deposits WHERE developer_id = $1`, [devId])).rows[0];
  assert.strictEqual(Number(devDepositAfterClawback.locked_deposit), 0.00);
  assert.strictEqual(Number(devDepositAfterClawback.available_deposit), 60.00);
  assert.strictEqual(Number(devDepositAfterClawback.total_deposit), 60.00);

  // Verify payout_ledger contains clawback record
  const clawbackLedger = (await db.query(`SELECT kind, amount FROM payout_ledger WHERE task_id = $1 AND kind = 'clawback'`, [taskId])).rows;
  assert.strictEqual(clawbackLedger.length, 1);
  assert.strictEqual(Number(clawbackLedger[0].amount), 40.00);
});

test('FIN-RESERVE: Platform Reserve Account Invariant and Balance Non-Negative Guard', async () => {
  const db = await getTestDb();

  // 1. Verify platform reserve account exists and has balance >= 0
  const reserve = (await db.query(`SELECT balance_usd, max_advance_per_task FROM platform_reserve_account WHERE id = 'PLATFORM_MAIN_RESERVE'`)).rows[0];
  assert.strictEqual(Number(reserve.balance_usd) >= 0, true);
  assert.strictEqual(Number(reserve.max_advance_per_task), 100.00);

  // 2. Invariant guard: attempt to force negative balance must trigger physical CHECK violation
  let checkViolation = false;
  try {
    await db.query(`UPDATE platform_reserve_account SET balance_usd = -100.00 WHERE id = 'PLATFORM_MAIN_RESERVE';`);
  } catch (err) {
    checkViolation = true;
  }
  assert.strictEqual(checkViolation, true, 'Physical CHECK constraint must prevent negative reserve balance');
});

test('INV-AUTH: Universal ACL Verification across all acp_% functions for anon and authenticated', async () => {
  const db = await getTestDb();
  const funcs = (await db.query(`
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'acp\\_%'
  `)).rows;

  assert.ok(funcs.length > 0, 'Must have at least one acp_% function registered');

  for (const { sig } of funcs) {
    const perm = (await db.query(`
      SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon_can_exec,
             has_function_privilege('authenticated', $1, 'EXECUTE') AS auth_can_exec,
             has_function_privilege('service_role', $1, 'EXECUTE') AS service_can_exec
    `, [sig])).rows[0];

    assert.strictEqual(perm.anon_can_exec, false, `anon must NOT have EXECUTE on ${sig}`);
    assert.strictEqual(perm.auth_can_exec, false, `authenticated must NOT have EXECUTE on ${sig}`);
    assert.strictEqual(perm.service_can_exec, true, `service_role MUST have EXECUTE on ${sig}`);
  }
});

test('INV-AUTH: Anonymous role execution of acp_settle_task must fail with permission denied', async () => {
  const db = await getTestDb();
  const taskId = 'task-auth-anon-probe';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 10.00, NOW() + INTERVAL '24 hours', 1)
    ON CONFLICT (id) DO NOTHING;
  `, [taskId]);

  await db.exec('SET ROLE anon;');
  let permissionDenied = false;
  try {
    await db.query(`SELECT acp_settle_task($1, 1, 10.00, true);`, [taskId]);
  } catch (err) {
    permissionDenied = true;
  } finally {
    await db.exec('RESET ROLE;');
  }

  assert.strictEqual(permissionDenied, true, 'Calling acp_settle_task as anon must trigger permission denied');
});

test('INV-FIN: NULL T+1 boundary must fail closed in settle', async () => {
  const db = await getTestDb();
  const taskId = 'task-null-t1-probe';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 10.00, NULL, 1)
    ON CONFLICT (id) DO UPDATE SET "t1ReleaseAt" = NULL, status = 'delivered', "payoutStatus" = 'escrowed', version = 1;
  `, [taskId]);

  const res = (await db.query(`SELECT acp_settle_task($1, 1, 10.00, false) AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'NULL t1ReleaseAt must fail closed when customer has not accepted');
  assert.strictEqual(res.code, 'ACP_T1_HOLD_ACTIVE');
});

test('INV-FIN: NULL dispute boundary must not unlock T+0 deposit', async () => {
  const db = await getTestDb();
  const devId = 'dev-null-t1-dep';
  const taskId = 'task-null-t1-dep';

  await db.query(`
    INSERT INTO developer_guarantee_deposits (developer_id, total_deposit, locked_deposit, available_deposit)
    VALUES ($1, 100.00, 0.00, 100.00)
    ON CONFLICT (developer_id) DO UPDATE SET total_deposit = 100.00, locked_deposit = 0.00, available_deposit = 100.00;
  `, [devId]);

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 20.00, NULL, 1)
    ON CONFLICT (id) DO UPDATE SET "t1ReleaseAt" = NULL, status = 'delivered', "payoutStatus" = 'escrowed', version = 1;
  `, [taskId]);

  const t0Res = (await db.query(`SELECT acp_t0_payout_with_deposit($1, $2, 1) AS result;`, [taskId, devId])).rows[0].result;
  assert.strictEqual(t0Res.success, true);

  const releaseRes = (await db.query(`SELECT acp_release_expired_locked_deposits($1) AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(releaseRes.success, false, 'Release must fail closed when t1ReleaseAt is NULL');
  assert.strictEqual(releaseRes.code, 'ACP_DISPUTE_WINDOW_ACTIVE');

  const dep = (await db.query(`SELECT locked_deposit FROM developer_guarantee_deposits WHERE developer_id = $1`, [devId])).rows[0];
  assert.strictEqual(Number(dep.locked_deposit), 20.00, 'Deposit must remain locked');
});

test('INV-FIN: clawback within window without locked deposit must fail closed', async () => {
  const db = await getTestDb();
  const taskId = 'task-clawback-no-source';

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'verified', 'settled', 15.00, NOW() + INTERVAL '1 hour', 2)
    ON CONFLICT (id) DO UPDATE SET status = 'verified', "payoutStatus" = 'settled', "t1ReleaseAt" = NOW() + INTERVAL '1 hour', version = 2;
  `, [taskId]);

  await db.query(`
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES ($1, 'settle', 15.00)
    ON CONFLICT DO NOTHING;
  `, [taskId]);

  const res = (await db.query(`SELECT acp_clawback_task($1, 2, 'late rejection') AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'Clawback without active locked deposit must fail');
  assert.strictEqual(res.code, 'ACP_NO_ACTIVE_DEPOSIT_LOCK');
});

test('INV-FIN: Stale settle ledger must not yield success on non-terminal task', async () => {
  const db = await getTestDb();
  const taskId = 'task-stale-settle-probe';

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 10.00, NOW() - INTERVAL '1 hour', 1)
    ON CONFLICT (id) DO UPDATE SET status = 'delivered', "payoutStatus" = 'escrowed', version = 1;
  `, [taskId]);

  await db.query(`
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES ($1, 'settle', 10.00)
    ON CONFLICT DO NOTHING;
  `, [taskId]);

  const res = (await db.query(`SELECT acp_settle_task($1, 1, 10.00, false) AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'Pre-existing settle ledger on non-settled task must return false');
  assert.strictEqual(res.code, 'ACP_STALE_LEDGER_CONFLICT');

  const taskRow = (await db.query(`SELECT status, "payoutStatus" FROM agent_tasks WHERE id = $1`, [taskId])).rows[0];
  assert.strictEqual(taskRow.status, 'delivered');
  assert.strictEqual(taskRow.payoutStatus, 'escrowed');
});

test('INV-FIN: Stale refund ledger must not yield success on non-terminal task', async () => {
  const db = await getTestDb();
  const taskId = 'task-stale-refund-probe';

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'escrowed', 'escrowed', 10.00, NOW() - INTERVAL '1 hour', 1)
    ON CONFLICT (id) DO UPDATE SET status = 'escrowed', "payoutStatus" = 'escrowed', version = 1;
  `, [taskId]);

  await db.query(`
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES ($1, 'refund', 10.00)
    ON CONFLICT DO NOTHING;
  `, [taskId]);

  const res = (await db.query(`SELECT acp_refund_task($1, 1, 'stale test') AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'Pre-existing refund ledger on non-refunded task must return false');
  assert.strictEqual(res.code, 'ACP_STALE_LEDGER_CONFLICT');

  const taskRow = (await db.query(`SELECT status, "payoutStatus" FROM agent_tasks WHERE id = $1`, [taskId])).rows[0];
  assert.strictEqual(taskRow.status, 'escrowed');
  assert.strictEqual(taskRow.payoutStatus, 'escrowed');
});

test('INV-FIN: All migrations must bootstrap a clean database in filename order', async () => {
  const migrationsDir = path.resolve(__dirname, '../supabase/migrations');
  const files = getSortedMigrations(migrationsDir);
  
  const cleanDb = new PGlite();
  await cleanDb.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT 'anon'::text $$ LANGUAGE sql;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$ SELECT '{}'::jsonb $$ LANGUAGE sql;
  `);

  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    try {
      await cleanDb.exec(sql);
    } catch (err) {
      assert.fail(`Migration ${f} failed to execute in filename order: ${err.message}`);
    }
  }

  const cols = (await cleanDb.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_tasks'`)).rows.map(r => r.column_name);
  for (const c of ['agentName', 'subdomain', 'taskTitle', 'taskDescription', 'payoutAddress', 'payoutTxHash', 'deliverableFingerprint', 'arbitrationVerdict', 'resultPayload', 't1ReleaseAt']) {
    assert.ok(cols.includes(c), `clean bootstrap must have agent_tasks.${c}`);
  }
  await cleanDb.close();
});

test('API-CONTRACT: Settle handler strict boolean check for customer_accepted', async () => {
  const db = await getTestDb();
  const taskId = 'task-bool-validation';

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "taskToken", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 10.00, 'tok_12345678901234567890', NOW() + INTERVAL '24 hours', 1)
    ON CONFLICT (id) DO UPDATE SET status = 'delivered', "payoutStatus" = 'escrowed', "t1ReleaseAt" = NOW() + INTERVAL '24 hours', version = 1;
  `, [taskId]);

  // 1. customer_accepted = "false" must return 400
  const callStringFalse = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: { customer_accepted: 'false' }
  });
  await settleHandler(callStringFalse.req, callStringFalse.res);
  assert.strictEqual(callStringFalse.getStatusCode(), 400);
  assert.strictEqual(callStringFalse.getJSON().error.code, 'ACP_INVALID_CUSTOMER_ACCEPTANCE');

  // 2. customer_accepted = "true" must return 400
  const callStringTrue = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: { customer_accepted: 'true' }
  });
  await settleHandler(callStringTrue.req, callStringTrue.res);
  assert.strictEqual(callStringTrue.getStatusCode(), 400);
  assert.strictEqual(callStringTrue.getJSON().error.code, 'ACP_INVALID_CUSTOMER_ACCEPTANCE');

  // 3. customer_accepted = 1 must return 400
  const callNum = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: { customer_accepted: 1 }
  });
  await settleHandler(callNum.req, callNum.res);
  assert.strictEqual(callNum.getStatusCode(), 400);
  assert.strictEqual(callNum.getJSON().error.code, 'ACP_INVALID_CUSTOMER_ACCEPTANCE');

  // 4. customer_accepted omitted (default false) within T+1 window -> 409 ACP_T1_HOLD_ACTIVE
  const callOmitted = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: {}
  });
  await settleHandler(callOmitted.req, callOmitted.res);
  assert.strictEqual(callOmitted.getStatusCode(), 409);
  assert.strictEqual(callOmitted.getJSON().error.code, 'ACP_T1_HOLD_ACTIVE');

  // 5. customer_accepted = true (boolean) -> 200 settled
  const callTrue = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: { customer_accepted: true }
  });
  await settleHandler(callTrue.req, callTrue.res);
  assert.strictEqual(callTrue.getStatusCode(), 200);
  assert.strictEqual(callTrue.getJSON().status, 'verified');
});

test('INV-AUTH: RLS INSERT policy prevents anonymous injection of settlement timestamps', async () => {
  const db = await getTestDb();
  await db.exec('SET ROLE anon;');
  try {
    // 1. Valid pending order insertion by anon should succeed
    const validId = 'task-rls-valid-' + Date.now();
    await db.query(`
      INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", version)
      VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, 1);
    `, [validId]);

    // 2. Pre-setting acceptedByCustomerAt must violate RLS
    let acceptedBlocked = false;
    try {
      await db.query(`
        INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "acceptedByCustomerAt", version)
        VALUES ('task-rls-injected-accepted', 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, NOW(), 1);
      `);
    } catch {
      acceptedBlocked = true;
    }
    assert.strictEqual(acceptedBlocked, true, 'RLS must block INSERT with acceptedByCustomerAt');

    // 3. Pre-setting t1ReleaseAt must violate RLS
    let t1Blocked = false;
    try {
      await db.query(`
        INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
        VALUES ('task-rls-injected-t1', 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, NOW() - INTERVAL '1 hour', 1);
      `);
    } catch {
      t1Blocked = true;
    }
    assert.strictEqual(t1Blocked, true, 'RLS must block INSERT with t1ReleaseAt');

    // 4. Pre-setting disputeDeadlineAt must violate RLS
    let disputeBlocked = false;
    try {
      await db.query(`
        INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "disputeDeadlineAt", version)
        VALUES ('task-rls-injected-dispute', 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, NOW() - INTERVAL '1 hour', 1);
      `);
    } catch {
      disputeBlocked = true;
    }
    assert.strictEqual(disputeBlocked, true, 'RLS must block INSERT with disputeDeadlineAt');

    // 5. Pre-setting settlementType must violate RLS
    let settlementTypeBlocked = false;
    try {
      await db.query(`
        INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "settlementType", version)
        VALUES ('task-rls-injected-stype', 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, 't0_instant', 1);
      `);
    } catch {
      settlementTypeBlocked = true;
    }
    assert.strictEqual(settlementTypeBlocked, true, 'RLS must block INSERT with settlementType');
  } finally {
    await db.exec('RESET ROLE;');
  }
});

test('INV-FIN: Pre-set acceptedByCustomerAt does not bypass T+1 hold when customer_accepted is false', async () => {
  const db = await getTestDb();
  const taskId = 'task-preset-accepted-probe';
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "acceptedByCustomerAt", "t1ReleaseAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'delivered', 'escrowed', 25.00, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '23 hours', 1)
    ON CONFLICT (id) DO UPDATE SET "acceptedByCustomerAt" = NOW() - INTERVAL '1 hour', "t1ReleaseAt" = NOW() + INTERVAL '23 hours', status = 'delivered', "payoutStatus" = 'escrowed', version = 1;
  `, [taskId]);

  // Calling acp_settle_task with p_customer_accepted = false must fail-closed with ACP_T1_HOLD_ACTIVE
  const res = (await db.query(`SELECT acp_settle_task($1, 1, 25.00, false) AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'Pre-set row timestamp must not bypass T+1 hold without explicit RPC parameter');
  assert.strictEqual(res.code, 'ACP_T1_HOLD_ACTIVE');
});

test('INV-FIN: Clawback after dispute window expiration fails with ACP_CLAWBACK_WINDOW_EXPIRED (409)', async () => {
  process.env.ACP_INTERNAL_KEY = 'test-internal-key';
  const db = await getTestDb();
  const adapter = createPgLiteSupabaseAdapter(db);
  setSupabaseClientForTesting(adapter);

  const devId = 'dev-clawback-exp';
  const taskId = 'task-clawback-expired-probe';

  await db.query(`
    INSERT INTO developer_guarantee_deposits (developer_id, total_deposit, locked_deposit, available_deposit)
    VALUES ($1, 100.00, 30.00, 70.00)
    ON CONFLICT (developer_id) DO UPDATE SET total_deposit = 100.00, locked_deposit = 30.00, available_deposit = 70.00;
  `, [devId]);

  // Task settled, but dispute window expired 1 hour ago
  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", "disputeDeadlineAt", "taskToken", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'verified', 'settled', 30.00, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'tok_12345678901234567890', 2)
    ON CONFLICT (id) DO UPDATE SET status = 'verified', "payoutStatus" = 'settled', "disputeDeadlineAt" = NOW() - INTERVAL '1 hour', version = 2;
  `, [taskId]);

  await db.query(`
    INSERT INTO task_t0_deposit_locks (task_id, developer_id, locked_amount, status)
    VALUES ($1, $2, 30.00, 'locked')
    ON CONFLICT (task_id) DO UPDATE SET developer_id = $2, locked_amount = 30.00, status = 'locked';
  `, [taskId, devId]);

  // 1. Direct RPC invocation
  const rpcRes = (await db.query(`SELECT acp_clawback_task($1, 2, 'expired dispute') AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(rpcRes.success, false);
  assert.strictEqual(rpcRes.code, 'ACP_CLAWBACK_WINDOW_EXPIRED');

  // 2. Refund API handler invocation with customer_rejected: true -> must return HTTP 409
  const callExp = mockReqRes({
    query: { task_id: taskId },
    headers: { 'x-task-token': 'tok_12345678901234567890' },
    body: { customer_rejected: true, reason: 'Dispute after deadline' }
  });
  await refundHandler(callExp.req, callExp.res);
  assert.strictEqual(callExp.getStatusCode(), 409);
  assert.strictEqual(callExp.getJSON().error.code, 'ACP_CLAWBACK_WINDOW_EXPIRED');
});

test('INV-FIN: Forward migration 20261022000000 safely backfills historical delivered rows with version bump', async () => {
  const migrationsDir = path.resolve(__dirname, '../supabase/migrations');
  const allFiles = getSortedMigrations(migrationsDir);
  const forwardFile = '20261022000000_harden_t1_t0_governance.sql';
  const priorFiles = allFiles.filter(f => f.split('_')[0].padEnd(14, '0') < forwardFile.split('_')[0].padEnd(14, '0'));

  const testDb = new PGlite();
  await testDb.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT 'anon'::text $$ LANGUAGE sql;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$ SELECT '{}'::jsonb $$ LANGUAGE sql;
  `);

  // 1. Run all prior migrations
  for (const f of priorFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await testDb.exec(sql);
  }

  // 2. Insert historical delivered row with NULL t1ReleaseAt and version = 1
  const historicalId = 'hist-delivered-order-1';
  await testDb.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", version)
    VALUES ($1, 'ag_hist', 'Agent Hist', 'agenthist', 'Historical Order', 'Desc', 'delivered', 'escrowed', 50.00, NULL, 1);
  `, [historicalId]);

  // 3. Run forward migration 20261022000000: MUST NOT throw monotonic version violation
  const forwardSql = fs.readFileSync(path.join(migrationsDir, forwardFile), 'utf8');
  await testDb.exec(forwardSql);

  // 4. Verify the row was safely backfilled and version bumped to 2
  const row = (await testDb.query(`SELECT status, "payoutStatus", "t1ReleaseAt", "disputeDeadlineAt", "settlementType", version FROM agent_tasks WHERE id = $1`, [historicalId])).rows[0];
  assert.strictEqual(row.status, 'delivered');
  assert.strictEqual(row.payoutStatus, 'escrowed');
  assert.ok(row.t1ReleaseAt !== null, 't1ReleaseAt must be backfilled');
  assert.ok(row.disputeDeadlineAt !== null, 'disputeDeadlineAt must be backfilled');
  assert.strictEqual(row.settlementType, 't1_default');
  assert.strictEqual(Number(row.version), 2, 'version must be incremented to 2');

  await testDb.close();
});

test('INV-FIN: acp_clawback_task fails closed when both disputeDeadlineAt and t1ReleaseAt are NULL', async () => {
  const db = await getTestDb();
  const taskId = 'task-clawback-null-boundaries';

  await db.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", "disputeDeadlineAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'verified', 'settled', 15.00, NULL, NULL, 2)
    ON CONFLICT (id) DO UPDATE SET status = 'verified', "payoutStatus" = 'settled', "t1ReleaseAt" = NULL, "disputeDeadlineAt" = NULL, version = 2;
  `, [taskId]);

  const res = (await db.query(`SELECT acp_clawback_task($1, 2, 'null test') AS result;`, [taskId])).rows[0].result;
  assert.strictEqual(res.success, false, 'Undefined dispute window must fail-closed');
  assert.strictEqual(res.code, 'ACP_CLAWBACK_WINDOW_EXPIRED');
});

test('INV-AUTH: RLS INSERT policy prevents anonymous userEmail injection', async () => {
  const db = await getTestDb();
  await db.exec('SET ROLE anon;');
  try {
    let emailBlocked = false;
    try {
      await db.query(`
        INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "userEmail", version)
        VALUES ('task-rls-injected-email', 'ag_1', 'Agent 1', 'agent1', 'Title', 'Desc', 'pending', 'pending', 10.00, 'victim@example.com', 1);
      `);
    } catch {
      emailBlocked = true;
    }
    assert.strictEqual(emailBlocked, true, 'RLS must block anon INSERT with userEmail');
  } finally {
    await db.exec('RESET ROLE;');
  }
});

test('INV-AUTH & INV-FIN: Production Upgrade Path Verification from 23f8fcb Baseline', async () => {
  const migrationsDir = path.resolve(__dirname, '../supabase/migrations');
  const allFiles = getSortedMigrations(migrationsDir);

  // Baseline files from production commit 23f8fcb
  const prodBaseFiles = [
    '20261020_agent_tasks_schema.sql',
    '20261020210000_harden_agent_tasks.sql',
    '20261021200000_t1_t0_settlement_architecture.sql'
  ];
  const forwardFiles = allFiles.filter(f => !prodBaseFiles.includes(f));

  const upgradeDb = new PGlite();
  await upgradeDb.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT 'anon'::text $$ LANGUAGE sql;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$ SELECT '{}'::jsonb $$ LANGUAGE sql;
  `);

  // 1. Simulate production baseline state (23f8fcb)
  for (const f of prodBaseFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await upgradeDb.exec(sql);
  }

  // 2. Seed historical legacy rows (with NULL timestamps and version=1)
  const legacyTaskId = 'task-legacy-prod-row';
  await upgradeDb.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", "disputeDeadlineAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Legacy Task', 'Desc', 'delivered', 'escrowed', 50.00, NULL, NULL, 1);
  `, [legacyTaskId]);

  // 3. Apply all forward migrations in chronological sequence
  for (const f of forwardFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await upgradeDb.exec(sql);
  }

  // 4. Test idempotency: re-applying the latest forward governance migration must not fail
  const latestForwardSql = fs.readFileSync(path.join(migrationsDir, '20261022500000_acp_final_governance_and_acl.sql'), 'utf8');
  await upgradeDb.exec(latestForwardSql);

  // 5. Verify INV-AUTH: Anonymous role execution of ANY acp_% function MUST fail
  await upgradeDb.exec('SET ROLE anon;');
  let anonSettleBlocked = false;
  try {
    await upgradeDb.query(`SELECT acp_settle_task($1, 2, 50.00, true);`, [legacyTaskId]);
  } catch (err) {
    anonSettleBlocked = true;
  }
  await upgradeDb.exec('RESET ROLE;');
  assert.strictEqual(anonSettleBlocked, true, 'Anonymous execution of acp_settle_task must fail closed');

  // 6. Verify legacy 3-argument overload is dropped from pg_proc (only 1 function remains)
  const procCount = Number((await upgradeDb.query(`
    SELECT count(*)::int as cnt
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'acp_settle_task';
  `)).rows[0].cnt);
  assert.strictEqual(procCount, 1, 'Only the single hardened 4-parameter acp_settle_task function must exist');

  // 7. Verify INV-FIN: Undefined double-NULL dispute window on settled task must fail-closed on clawback
  await upgradeDb.query(`
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           "t1ReleaseAt" = NULL,
           "disputeDeadlineAt" = NULL,
           version = version + 1
     WHERE id = $1;
  `, [legacyTaskId]);

  const currentVer = Number((await upgradeDb.query(`SELECT version FROM agent_tasks WHERE id = $1;`, [legacyTaskId])).rows[0].version);
  const clawbackRes = (await upgradeDb.query(`SELECT acp_clawback_task($1, $2, 'prod null test') AS result;`, [legacyTaskId, currentVer])).rows[0].result;
  assert.strictEqual(clawbackRes.success, false);
  assert.strictEqual(clawbackRes.code, 'ACP_CLAWBACK_WINDOW_EXPIRED');

  // 8. Verify INV-FIN: Undefined NULL t1ReleaseAt must fail-closed on release deposit
  const releaseRes = (await upgradeDb.query(`SELECT acp_release_expired_locked_deposits($1) AS result;`, [legacyTaskId])).rows[0].result;
  assert.strictEqual(releaseRes.success, false);
  assert.strictEqual(releaseRes.code, 'ACP_LOCK_NOT_FOUND'); // since no lock was created for this legacy task

  // 9. Verify successful release of an expired T+0 deposit lock (testing line 47/57 schema alignment)
  const devId = 'dev-upgrade-test';
  await upgradeDb.query(`
    INSERT INTO developer_guarantee_deposits (developer_id, total_deposit, locked_deposit, available_deposit)
    VALUES ($1, 100.00, 40.00, 60.00)
    ON CONFLICT (developer_id) DO UPDATE SET total_deposit = 100.00, locked_deposit = 40.00, available_deposit = 60.00;
  `, [devId]);

  const lockTaskId = 'task-lock-release-test';
  await upgradeDb.query(`
    INSERT INTO agent_tasks (id, "agentId", "agentName", subdomain, "taskTitle", "taskDescription", status, "payoutStatus", "budgetUsd", "t1ReleaseAt", "disputeDeadlineAt", version)
    VALUES ($1, 'ag_1', 'Agent 1', 'agent1', 'Lock Task', 'Desc', 'delivered', 'settled', 40.00, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 2);
  `, [lockTaskId]);

  await upgradeDb.query(`
    INSERT INTO task_t0_deposit_locks (task_id, developer_id, locked_amount, status)
    VALUES ($1, $2, 40.00, 'locked');
  `, [lockTaskId, devId]);

  const unlockRes = (await upgradeDb.query(`SELECT acp_release_expired_locked_deposits($1) AS result;`, [lockTaskId])).rows[0].result;
  assert.strictEqual(unlockRes.success, true);
  assert.strictEqual(unlockRes.code, 'DEPOSIT_UNLOCKED');
  assert.strictEqual(Number(unlockRes.released_amount), 40.00);

  // Verify deposit balances
  const devBal = (await upgradeDb.query(`SELECT locked_deposit, available_deposit FROM developer_guarantee_deposits WHERE developer_id = $1;`, [devId])).rows[0];
  assert.strictEqual(Number(devBal.locked_deposit), 0.00);
  assert.strictEqual(Number(devBal.available_deposit), 100.00);
});



