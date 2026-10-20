import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseClient } from '../_supabase';
import { validateDeliverableSchema } from '../../../../src/lib/arbitration/validator';

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
        return res.status(400).json({
          success: false,
          error: { code: 'ACP_INVALID_JSON', message: 'Malformed JSON payload in request body' }
        });
      }
    } else {
      body = req.body;
    }
  }

  const { output, agent_slug } = body;
  if (output === undefined || output === null) {
    return res.status(400).json({
      success: false,
      error: { code: 'ACP_INPUT_INVALID', message: 'Missing required field: output' }
    });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ success: false, error: { code: 'ACP_DB_UNAVAILABLE', message: 'Database service unavailable' } });
  }

  // Dual-track authentication check (P0-3 Hardened)
  const internalKey = (process.env.ACP_INTERNAL_KEY || '').trim();
  const acpKey = (req.headers['acp-key'] as string) || '';
  const authHeader = (req.headers['authorization'] as string) || '';
  const taskToken = (req.headers['x-task-token'] as string) || (body?.task_token as string) || '';
  let authorized = false;
  let targetQuantity: number | undefined = undefined;
  let targetSla: string | undefined = undefined;

  let existingTaskRecord: any = null;
  try {
    const { data: taskCheck, error: checkErr } = await supabase
      .from('agent_tasks')
      .select('id, taskToken, quantity, slaThreshold, status, resultPayload, deliverableFingerprint, agent_slug, agentId')
      .eq('id', taskId)
      .single();

    if (!checkErr && taskCheck) {
      existingTaskRecord = taskCheck;
      targetQuantity = taskCheck.quantity;
      targetSla = taskCheck.slaThreshold;
    }
  } catch {}

  if (!existingTaskRecord) {
    return res.status(404).json({
      success: false,
      error: { code: 'ACP_TASK_NOT_FOUND', message: `Task '${taskId}' not found in ledger` }
    });
  }

  if (internalKey) {
    if (acpKey && acpKey === internalKey) {
      authorized = true;
    } else if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === internalKey) {
      authorized = true;
    }
  }

  if (!authorized && taskToken) {
    // Strict token equality (no startsWith bypass)
    if (typeof existingTaskRecord.taskToken === 'string' &&
        existingTaskRecord.taskToken.length >= 10 &&
        existingTaskRecord.taskToken === taskToken) {
      authorized = true;
    }
  }

  if (!authorized) {
    return res.status(401).json({
      success: false,
      error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing authorization credentials' }
    });
  }

  // Idempotent return if already delivered or verified
  if (existingTaskRecord.status === 'delivered' || existingTaskRecord.status === 'verified') {
    return res.status(200).json({
      success: true,
      task_id: taskId,
      status: existingTaskRecord.status,
      output: existingTaskRecord.resultPayload,
      deliverable_fingerprint: existingTaskRecord.deliverableFingerprint,
      meta: { idempotent_replay: true }
    });
  }

  // Prevent delivery on terminal or refunded tasks
  if (existingTaskRecord.status === 'refunded' || existingTaskRecord.status === 'disputed' || existingTaskRecord.status === 'failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'ACP_INVALID_TASK_STATE', message: `Cannot deliver output for task in state '${existingTaskRecord.status}'` }
    });
  }

  const deliveredAt = new Date().toISOString();

  // Validate deliverable schema and generate SHA-256 fingerprint (P0-2 Gate)
  const validation = await validateDeliverableSchema(output, targetQuantity, targetSla);
  const deliverableFingerprint = {
    sha256Checksum: validation.sha256Checksum,
    verifiedCount: validation.verifiedCount,
    integrityScore: validation.integrityScore,
    verifiedAt: deliveredAt
  };

  if (!validation.valid || validation.integrityScore < 60) {
    return res.status(422).json({
      success: false,
      error: { code: 'ACP_DELIVERABLE_INVALID', message: `Output failed schema validation: ${validation.errors.join('; ')}` },
      deliverable_fingerprint: deliverableFingerprint
    });
  }

  try {
    const { data, error } = await supabase
      .from('agent_tasks')
      .update({
        status: 'delivered',
        resultPayload: output,
        deliverableFingerprint: deliverableFingerprint,
        deliveredAt: deliveredAt,
        updatedAt: deliveredAt,
        ...(agent_slug && !existingTaskRecord.agent_slug && !existingTaskRecord.agentId ? { agent_slug, agentId: agent_slug } : {})
      })
      .eq('id', taskId)
      .in('status', ['pending', 'escrowed', 'processing'])
      .select('id, status, deliveredAt, deliverableFingerprint');

    if (error) {
      return res.status(500).json({
        success: false,
        error: { code: 'ACP_LEDGER_UPDATE_FAILED', message: error.message || 'Database ledger update error' }
      });
    }

    if (!data || data.length === 0) {
      return res.status(409).json({
        success: false,
        error: { code: 'ACP_TASK_STATE_CONFLICT', message: `Task '${taskId}' was not in deliverable state` }
      });
    }

    return res.status(200).json({
      success: true,
      task_id: taskId,
      agent_slug: agent_slug,
      status: 'delivered',
      delivered_at: deliveredAt,
      deliverable_fingerprint: deliverableFingerprint,
      message: 'Delivery confirmed and logged into Supabase ledger with SHA-256 provenance.'
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'ACP_INTERNAL_ERROR', message: err?.message || 'Failed to confirm task delivery' }
    });
  }
}
