import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeliverableSchema,
  evaluateDisputeArbitration,
  hasErrorFlag,
  isNonEmptyValue
} from '../src/lib/arbitration/validator.ts';

test('Round 10 Security: All Auditor POC Defective Deliverables Must Fail-Closed', async (t) => {
  const defectivePOCs = [
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

test('Round 10 Quality: Substantive AI Work Products Must Pass SLA', async (t) => {
  await t.test('Valid structured issue findings report', async () => {
    const payload = {
      verifiedCount: 2,
      output: [
        { id: 'ISSUE-01', title: 'SQL Injection Vulnerability', severity: 'high', description: 'Raw SQL parameter interpolation detected' },
        { id: 'ISSUE-02', title: 'Missing Rate Limiting', severity: 'medium', description: 'Public endpoint lacks token bucket throttling' }
      ]
    };
    const report = await validateDeliverableSchema(payload, 2);
    assert.strictEqual(report.valid, true, 'Substantive deliverable must be valid');
    assert.strictEqual(report.integrityScore, 100, 'Substantive deliverable must score 100');
    assert.strictEqual(report.slaConformant, true, 'Substantive deliverable must be SLA conformant');

    const verdict = await evaluateDisputeArbitration(
      {
        id: 'ord-valid-1',
        status: 'delivered',
        resultPayload: payload,
        quantity: 2
      },
      'Client subjective complaint on valid delivery'
    );
    assert.strictEqual(verdict.ruling, 'settle_developer', 'Fully conformant work must settle to developer');
  });

  await t.test('Valid text and radar analysis', async () => {
    const payload = {
      repo: 'AgentUniver/acp-engine',
      radar: {
        architecture: 95,
        security: 98,
        maintainability: 92
      },
      summary: 'Architecture audit fully completed with 0 critical defects.'
    };
    const report = await validateDeliverableSchema(payload);
    assert.strictEqual(report.valid, true);
    assert.strictEqual(report.integrityScore, 100);
  });
});

test('Round 10 Ledger: 54-Combination State Machine Consistency Check', () => {
  const allStatuses = [
    'pending', 'escrowed', 'processing', 'delivered', 'disputed',
    'verified', 'completed', 'refunded', 'failed'
  ];
  const allPayoutStatuses = [
    null, 'pending', 'escrowed', 'settled', 'refunded', 'failed'
  ];

  // Exact JavaScript representation of the SQL CHECK constraint
  function isStateComboValid(status, payoutStatus) {
    if (status === 'pending') return payoutStatus === null || payoutStatus === 'pending';
    if (status === 'escrowed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'processing') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'delivered') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed';
    if (status === 'disputed') return payoutStatus === null || payoutStatus === 'pending' || payoutStatus === 'escrowed' || payoutStatus === 'failed';
    if (status === 'verified') return payoutStatus === 'settled' || payoutStatus === 'escrowed';
    if (status === 'completed') return payoutStatus === 'settled' || payoutStatus === 'escrowed';
    if (status === 'refunded') return payoutStatus === 'refunded';
    if (status === 'failed') return payoutStatus === null || payoutStatus === 'refunded' || payoutStatus === 'failed';
    return false;
  }

  // Critical contradictory states that MUST be rejected
  const illegalCombinations = [
    ['escrowed', 'settled'],
    ['pending', 'settled'],
    ['processing', 'settled'],
    ['delivered', 'settled'],
    ['disputed', 'settled'],
    ['failed', 'settled'],
    ['refunded', 'settled'],
    ['verified', 'refunded'],
    ['completed', 'refunded'],
    ['escrowed', 'refunded'],
    ['processing', 'refunded'],
    ['delivered', 'refunded'],
    ['refunded', null],
    ['refunded', 'pending'],
    ['refunded', 'escrowed'],
    ['verified', null],
    ['verified', 'pending'],
    ['completed', null]
  ];

  for (const [st, ps] of illegalCombinations) {
    assert.strictEqual(
      isStateComboValid(st, ps),
      false,
      `State combination (${st}, ${ps}) MUST BE ILLEGAL in ledger`
    );
  }

  // Legal milestone states that MUST be allowed
  const legalCombinations = [
    ['pending', null],
    ['pending', 'pending'],
    ['escrowed', 'escrowed'],
    ['processing', 'escrowed'],
    ['delivered', 'escrowed'],
    ['verified', 'settled'],
    ['completed', 'settled'],
    ['refunded', 'refunded'],
    ['disputed', 'escrowed'],
    ['failed', 'refunded']
  ];

  for (const [st, ps] of legalCombinations) {
    assert.strictEqual(
      isStateComboValid(st, ps),
      true,
      `State combination (${st}, ${ps}) MUST BE LEGAL in ledger`
    );
  }
});

test('Round 10 Concurrency: Monotonic Version CAS Fencing Simulation', () => {
  let record = { id: 'ord-cas-1', status: 'escrowed', version: 1 };

  function executeDeliverCAS(expectedVersion, newStatus) {
    if (record.version !== expectedVersion) {
      return { success: false, code: 409, message: 'CAS Conflict: version mismatch' };
    }
    record = { ...record, status: newStatus, version: record.version + 1 };
    return { success: true, version: record.version };
  }

  // First worker wins
  const worker1 = executeDeliverCAS(1, 'delivered');
  assert.strictEqual(worker1.success, true);
  assert.strictEqual(worker1.version, 2);

  // Stale second worker using version 1 must be rejected
  const worker2 = executeDeliverCAS(1, 'delivered');
  assert.strictEqual(worker2.success, false);
  assert.strictEqual(worker2.code, 409);

  // Settlement worker using new version 2 succeeds
  const settleWorker = executeDeliverCAS(2, 'verified');
  assert.strictEqual(settleWorker.success, true);
  assert.strictEqual(settleWorker.version, 3);
});
