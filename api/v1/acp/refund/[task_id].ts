import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseClient } from '../_supabase';

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
    return res.status(405).json({
      success: false,
      error: { code: 'ACP_METHOD_NOT_ALLOWED', message: 'Method not allowed' }
    });
  }

  const taskId = (req.query.task_id as string) || '';
  if (!taskId) {
    return res.status(400).json({
      success: false,
      error: { code: 'ACP_INVALID_TASK_ID', message: 'Missing task_id parameter' }
    });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({
      success: false,
      error: { code: 'ACP_DB_UNAVAILABLE', message: 'Database service unavailable' }
    });
  }

  const internalKey = (process.env.ACP_INTERNAL_KEY || '').trim();
  const acpKey = (req.headers['acp-key'] as string) || '';
  const authHeader = (req.headers['authorization'] as string) || '';
  const taskToken = (req.headers['x-task-token'] as string) || '';
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
      .select('id, status, taskToken, budgetUsd, userEmail')
      .eq('id', taskId)
      .single();

    if (fetchErr || !taskRecord) {
      return res.status(404).json({
        success: false,
        error: { code: 'ACP_TASK_NOT_FOUND', message: `Task '${taskId}' not found` }
      });
    }

    if (!authorized) {
      if (
        taskToken &&
        typeof taskRecord.taskToken === 'string' &&
        taskRecord.taskToken.length >= 10 &&
        taskToken === taskRecord.taskToken
      ) {
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(401).json({
        success: false,
        error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing task capability token' }
      });
    }

    // Idempotent return if already refunded
    if (taskRecord.status === 'refunded') {
      return res.status(200).json({
        success: true,
        task_id: taskId,
        status: 'refunded',
        meta: { idempotent_replay: true }
      });
    }

    // Cannot refund verified orders (funds already settled to developer)
    if (taskRecord.status === 'verified') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ACP_INVALID_REFUND_STATE',
          message: 'Task funds have already been verified and settled to developer'
        }
      });
    }

    // Only allow refunding orders that are in disputed, failed, or escrowed state
    if (!['disputed', 'failed', 'escrowed'].includes(taskRecord.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ACP_INVALID_REFUND_STATE',
          message: `Task is in status '${taskRecord.status}' which cannot be refunded directly`
        }
      });
    }

    const now = new Date().toISOString();
    const { data: updatedRows, error: updateErr } = await supabase
      .from('agent_tasks')
      .update({
        status: 'refunded',
        payoutStatus: 'refunded',
        updatedAt: now
      })
      .eq('id', taskId)
      .in('status', ['disputed', 'failed', 'escrowed'])
      .select('id, status');

    if (updateErr || !updatedRows || updatedRows.length === 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ACP_REFUND_CONFLICT',
          message: 'Concurrent modification: task status moved before refund could execute'
        }
      });
    }

    return res.status(200).json({
      success: true,
      task_id: taskId,
      status: 'refunded',
      refunded_at: now
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'ACP_REFUND_INTERNAL_ERROR', message: err?.message || 'Internal error processing refund' }
    });
  }
}
