import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseClient } from '../_supabase.ts';

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

  // 前置门禁检查：若未提供内部密钥且未提供任何任务令牌，直接 401 拒绝，杜绝未鉴权枚举（P1-5）
  if (!authorized && !taskToken) {
    return res.status(401).json({
      success: false,
      error: { code: 'ACP_AUTH_FAILED', message: 'Missing or invalid authorization credentials' }
    });
  }

  try {
    const { data: taskRecord, error: fetchErr } = await supabase
      .from('agent_tasks')
      .select('id, status, payoutStatus, taskToken, budgetUsd, userEmail, version')
      .eq('id', taskId)
      .single();

    if (fetchErr) {
      if (fetchErr.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: { code: 'ACP_TASK_NOT_FOUND', message: `Task '${taskId}' not found` }
        });
      }
      return res.status(503).json({
        success: false,
        error: { code: 'ACP_DB_ERROR', message: `Database fetch error: ${fetchErr.message}`, retryable: true }
      });
    }
    if (!taskRecord) {
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

    const isCustomerRejection = req.body?.customer_rejected === true;

    // If task is settled, only permit clawback if explicitly requested via customer_rejected within dispute window
    if (taskRecord.payoutStatus === 'settled' || taskRecord.status === 'verified') {
      if (isCustomerRejection) {
        const currentVersion = Number(taskRecord.version);
        const { data: clawbackRes, error: clawbackErr } = await (supabase as any).rpc('acp_clawback_task', {
          p_task_id: taskId,
          p_expected_version: currentVersion,
          p_reason: (req.body?.reason as string) || 'Customer rejected deliverable within dispute window'
        });

        if (clawbackErr) {
          return res.status(503).json({
            success: false,
            error: { code: 'ACP_RPC_UNAVAILABLE', message: `Clawback RPC unavailable: ${clawbackErr.message}` }
          });
        }

        if (clawbackRes && clawbackRes.success) {
          return res.status(200).json({
            success: true,
            task_id: taskId,
            status: 'disputed',
            payout_status: 'clawed_back',
            meta: { clawback: true },
            message: 'Funds successfully clawed back from developer guarantee deposit.'
          });
        }

        if (clawbackRes?.code === 'ACP_CLAWBACK_WINDOW_EXPIRED' || clawbackRes?.code === 'ACP_VERSION_CONFLICT') {
          return res.status(409).json({
            success: false,
            error: clawbackRes
          });
        }

        return res.status(400).json({
          success: false,
          error: clawbackRes || { code: 'ACP_CLAWBACK_REJECTED', message: 'Failed to claw back funds from settled task' }
        });
      }

      return res.status(400).json({
        success: false,
        error: {
          code: 'ACP_INVALID_REFUND_STATE',
          message: 'Task funds have already been verified and settled to developer'
        }
      });
    }

    // Customer rejection allows refund directly from delivered, disputed, failed, or escrowed
    const allowableStates = ['disputed', 'failed', 'escrowed', 'delivered'];
    if (!allowableStates.includes(taskRecord.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ACP_INVALID_REFUND_STATE',
          message: `Task is in status '${taskRecord.status}' which cannot be refunded directly`
        }
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
    // Single-transaction acp_refund_task RPC (Claude Spec: Single TX CAS + Ledger)
    const { data: rpcRes, error: rpcErr } = await (supabase as any).rpc('acp_refund_task', {
      p_task_id: taskId,
      p_expected_version: currentVersion,
      p_reason: (req.body?.reason as string) || null
    });

    if (rpcErr) {
      return res.status(503).json({
        success: false,
        error: { code: 'ACP_RPC_UNAVAILABLE', message: `Database refund RPC unavailable: ${rpcErr.message}`, retryable: true }
      });
    }

    if (rpcRes) {
      if (rpcRes.success) {
        return res.status(200).json({
          success: true,
          task_id: taskId,
          status: 'refunded',
          meta: rpcRes.idempotent ? { idempotent_replay: true } : undefined,
          refunded_at: now
        });
      }
      if (rpcRes.code === 'ACP_VERSION_CONFLICT') {
        return res.status(409).json({ success: false, error: rpcRes });
      }
      if (rpcRes.code === 'ACP_REFUND_BLOCKED_BY_SETTLEMENT') {
        return res.status(409).json({ success: false, error: rpcRes });
      }
      if (rpcRes.code === 'ACP_INVALID_REFUND_STATE' || rpcRes.code === 'ACP_ALREADY_REFUNDED') {
        return res.status(400).json({ success: false, error: rpcRes });
      }
      return res.status(400).json({ success: false, error: rpcRes });
    }

    return res.status(500).json({
      success: false,
      error: { code: 'ACP_RPC_NO_RESPONSE', message: 'No response received from refund RPC' }
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'ACP_REFUND_INTERNAL_ERROR', message: err?.message || 'Internal error processing refund' }
    });
  }
}
