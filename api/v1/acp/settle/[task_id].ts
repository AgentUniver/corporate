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
    return res.status(405).json({ success: false, error: { code: 'ACP_METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }

  const taskId = (req.query.task_id as string) || '';
  if (!taskId) {
    return res.status(400).json({ success: false, error: { code: 'ACP_INVALID_TASK_ID', message: 'Missing task_id' } });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ success: false, error: { code: 'ACP_DB_UNAVAILABLE', message: 'Database service unavailable' } });
  }

  // Dual-track authentication check
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

  // 前置门禁检查：若未提供内部密钥且未提供任何任务令牌，直接 401 拒绝，杜绝未鉴权枚举（P1-5）
  if (!authorized && !taskToken) {
    return res.status(401).json({
      success: false,
      error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing authorization credentials' }
    });
  }

  try {
    const { data: taskRecord, error: fetchErr } = await supabase
      .from('agent_tasks')
      .select('id, status, taskToken, version')
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

    // Idempotent return if already verified
    if (taskRecord.status === 'verified') {
      return res.status(200).json({
        success: true,
        task_id: taskId,
        status: 'verified',
        meta: { idempotent_replay: true },
        message: 'Task is already verified and settled.'
      });
    }

    // Only allow settlement from delivered or legacy completed
    if (taskRecord.status !== 'delivered' && taskRecord.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'ACP_INVALID_SETTLEMENT_STATE', message: `Cannot verify & settle task in state '${taskRecord.status}'` }
      });
    }

    const currentVersion = Number(taskRecord.version);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      return res.status(500).json({
        success: false,
        error: { code: 'ACP_INVALID_LEDGER_VERSION', message: 'Task record lacks valid monotonic version' }
      });
    }

    const now = new Date().toISOString();
    const nextVersion = currentVersion + 1;
    const { data: updatedRows, error: updateErr } = await supabase
      .from('agent_tasks')
      .update({
        status: 'verified',
        payoutStatus: 'settled',
        updatedAt: now,
        version: nextVersion
      })
      .eq('id', taskId)
      .eq('version', currentVersion)
      .in('status', ['delivered', 'completed'])
      .select('id, status, updatedAt, version');

    if (updateErr) {
      return res.status(503).json({ success: false, error: { code: 'ACP_DB_UPDATE_ERROR', message: `Database update error: ${updateErr.message}`, retryable: true } });
    }
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ success: false, error: { code: 'ACP_SETTLEMENT_CONFLICT', message: 'Task state conflict during settlement' } });
    }

    return res.status(200).json({
      success: true,
      task_id: taskId,
      status: 'verified',
      updated_at: now,
      message: 'Escrow verification approved and payment released to developer.'
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'ACP_INTERNAL_ERROR', message: err?.message || 'Settlement error' } });
  }
}
