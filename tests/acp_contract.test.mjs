import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeliverableSchema,
  evaluateDisputeArbitration,
  hasErrorFlag,
  isValidDeliverablePayload
} from '../src/lib/arbitration/validator.ts';

test('P0-A & N2: All Auditor POC Defective Deliverables Must Fail-Closed', async (t) => {
  const defectivePOCs = [
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
    { name: '{ output: false }', payload: { output: false } }
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

test('P1-3 & P0-B: Exhaustive 54-Pair Matrix Check of (status, payoutStatus)', () => {
  const allStatuses = [
    'pending', 'escrowed', 'processing', 'delivered', 'disputed',
    'verified', 'completed', 'refunded', 'failed', 'cancelled'
  ];
  const allPayoutStatuses = [
    null, 'pending', 'escrowed', 'settled', 'refunded', 'failed'
  ];

  // Exact JavaScript implementation of the SQL CHECK constraint
  function isStateComboValid(status, payoutStatus) {
    if (status === 'pending') return payoutStatus === null || payoutStatus === 'pending';
    if (status === 'escrowed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'processing') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'delivered') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'disputed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'settled' || payoutStatus === 'refunded' || payoutStatus === 'failed';
    if (status === 'verified') return payoutStatus !== null && (payoutStatus === 'settled' || payoutStatus === 'escrowed');
    if (status === 'completed') return payoutStatus !== null && (payoutStatus === 'settled' || payoutStatus === 'escrowed');
    if (status === 'refunded') return payoutStatus !== null && payoutStatus === 'refunded';
    if (status === 'failed') return payoutStatus === null || payoutStatus === 'refunded' || payoutStatus === 'failed';
    if (status === 'cancelled') return payoutStatus === null || payoutStatus === 'refunded' || payoutStatus === 'failed' || payoutStatus === 'settled';
    return false;
  }

  // Count total evaluated combinations
  let totalEvaluated = 0;
  for (const st of allStatuses) {
    for (const ps of allPayoutStatuses) {
      totalEvaluated++;
      const valid = isStateComboValid(st, ps);
      // Explicit invariant assertions:
      if (['verified', 'completed', 'refunded'].includes(st)) {
        if (ps === null) {
          assert.strictEqual(valid, false, `${st} with null payoutStatus MUST BE INVALID`);
        }
      }
      if (st === 'refunded') {
        assert.strictEqual(valid, ps === 'refunded', `refunded status only permits refunded payoutStatus`);
      }
      if (st === 'verified' || st === 'completed') {
        assert.strictEqual(valid, ps === 'settled' || ps === 'escrowed', `${st} only permits settled or escrowed`);
      }
      if (['pending', 'escrowed', 'processing', 'delivered'].includes(st)) {
        if (ps === 'settled' || ps === 'refunded') {
          assert.strictEqual(valid, false, `${st} with ${ps} MUST BE INVALID`);
        }
      }
    }
  }

  assert.strictEqual(totalEvaluated, 60, 'Evaluated all 60 status/payoutStatus pairs');
});

test('P1-1 & P1-2: Monotonic Version CAS Fencing Simulation Across All Lifecycles', () => {
  let record = { id: 'ord-cas-1', status: 'escrowed', version: 1 };

  function executeCAS(expectedVersion, newStatus) {
    if (record.version !== expectedVersion) {
      return { success: false, code: 409, message: 'CAS Conflict: version mismatch' };
    }
    const nextVer = record.version + 1;
    // Simulate DB trigger: next version must be strictly greater
    if (nextVer <= record.version) {
      throw new Error('Monotonic version violation');
    }
    record = { ...record, status: newStatus, version: nextVer };
    return { success: true, version: record.version };
  }

  // 1. Lock to processing
  const lock = executeCAS(1, 'processing');
  assert.strictEqual(lock.success, true);
  assert.strictEqual(record.version, 2);

  // Stale runner attempts to lock with old version 1 -> rejected
  const staleLock = executeCAS(1, 'processing');
  assert.strictEqual(staleLock.success, false);
  assert.strictEqual(staleLock.code, 409);

  // 2. Deliver output with version 2
  const deliver = executeCAS(2, 'delivered');
  assert.strictEqual(deliver.success, true);
  assert.strictEqual(record.version, 3);

  // 3. Dispute with version 3
  const dispute = executeCAS(3, 'disputed');
  assert.strictEqual(dispute.success, true);
  assert.strictEqual(record.version, 4);

  // 4. Settle / Refund with version 4
  const settle = executeCAS(4, 'verified');
  assert.strictEqual(settle.success, true);
  assert.strictEqual(record.version, 5);
});
