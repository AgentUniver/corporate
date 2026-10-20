import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseClient } from '../_supabase';
import { evaluateDisputeArbitration } from '../../../../src/lib/arbitration/validator';

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body: any;
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACP-Key, ACP-Version, Authorization, X-Task-Token');
  res.setHeader('ACP-Version', '2.0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ success: false, error: { code: 'ACP_METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }

  const taskId = (req.query.task_id as string) || '';
  if (!taskId) {
    return res.status(400).json({ success: false, error: { code: 'ACP_INVALID_TASK_ID', message: 'Missing task_id' } });
  }

  let body: any = {};
  if (req.body) {
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        return res.status(400).json({ success: false, error: { code: 'ACP_INVALID_JSON', message: 'Malformed JSON payload' } });
      }
    } else {
      body = req.body;
    }
  }

  const disputeReason = body.dispute_reason || body.reason || 'General SLA Non-Conformance Dispute';

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ success: false, error: { code: 'ACP_DB_UNAVAILABLE', message: 'Database service unavailable' } });
  }

  // Dual-track authentication check
  const internalKey = (process.env.ACP_INTERNAL_KEY || '').trim();
  const acpKey = (req.headers['acp-key'] as string) || '';
  const authHeader = (req.headers['authorization'] as string) || '';
  const taskToken = (req.headers['x-task-token'] as string) || (body?.task_token as string) || '';
  let authorized = false;

  if (internalKey) {
    if (acpKey && acpKey === internalKey) {
      authorized = true;
    } else if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === internalKey) {
      authorized = true;
    }
  }

  try {
    const { data: taskRecord, error: fetchErr } = await supabase
      .from('agent_tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (fetchErr) {
      if (fetchErr.code === 'PGRST116') {
        return res.status(404).json({ success: false, error: { code: 'ACP_TASK_NOT_FOUND', message: `Task '${taskId}' not found in ledger` } });
      }
      return res.status(503).json({ success: false, error: { code: 'ACP_DB_ERROR', message: `Database fetch error: ${fetchErr.message}`, retryable: true } });
    }
    if (!taskRecord) {
      return res.status(404).json({ success: false, error: { code: 'ACP_TASK_NOT_FOUND', message: `Task '${taskId}' not found in ledger` } });
    }

    if (!authorized && taskToken) {
      if (typeof taskRecord.taskToken === 'string' &&
          taskRecord.taskToken.length >= 10 &&
          taskRecord.taskToken === taskToken) {
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(401).json({ success: false, error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing authorization credentials' } });
    }

    // Idempotent return if already in terminal state (disputed, refunded, verified)
    if (taskRecord.status === 'disputed' || taskRecord.status === 'refunded' || taskRecord.status === 'verified') {
      return res.status(200).json({
        success: true,
        task_id: taskId,
        status: taskRecord.status,
        verdict: taskRecord.arbitrationVerdict || {
          ruling: taskRecord.status === 'refunded' ? 'refund_client' : 'settle_developer',
          confidence: 1.0,
          rationale: 'Task dispute already resolved previously',
          evidenceHash: '',
          arbitratedAt: taskRecord.updatedAt || new Date().toISOString()
        },
        meta: { idempotent_replay: true },
        message: `Task is already in status '${taskRecord.status}'`
      });
    }

    // Only allow dispute from delivered state
    if (taskRecord.status !== 'delivered' && taskRecord.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'ACP_INVALID_DISPUTE_STATE', message: `Cannot dispute task in state '${taskRecord.status}'` }
      });
    }

    // Evaluate automated zero-human arbitration
    const verdict = await evaluateDisputeArbitration(taskRecord, disputeReason);
    let nextStatus = 'disputed';
    let nextPayout = 'escrowed';
    if (verdict.ruling === 'refund_client') {
      nextStatus = 'refunded';
      nextPayout = 'refunded';
    } else if (verdict.ruling === 'settle_developer') {
      nextStatus = 'verified';
      nextPayout = 'settled';
    }

    const currentVersion = Number(taskRecord.version) || 1;
    const nextVersion = currentVersion + 1;
    const now = new Date().toISOString();
    const { data: updatedRows, error: updateErr } = await supabase
      .from('agent_tasks')
      .update({
        status: nextStatus,
        payoutStatus: nextPayout,
        disputeReason: disputeReason,
        arbitrationVerdict: verdict,
        updatedAt: now,
        version: nextVersion
      })
      .eq('id', taskId)
      .eq('version', currentVersion)
      .in('status', ['delivered', 'completed'])
      .select('id, status, disputeReason, arbitrationVerdict, updatedAt, version');

    if (updateErr) {
      return res.status(503).json({ success: false, error: { code: 'ACP_DB_UPDATE_ERROR', message: `Database update error: ${updateErr.message}`, retryable: true } });
    }
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ success: false, error: { code: 'ACP_DISPUTE_CONFLICT', message: 'Task state conflict during arbitration' } });
    }

    return res.status(200).json({
      success: true,
      task_id: taskId,
      status: nextStatus,
      verdict: verdict,
      message: `Arbitration verdict rendered: ${verdict.ruling}`
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'ACP_INTERNAL_ERROR', message: err?.message || 'Arbitration error' } });
  }
}
