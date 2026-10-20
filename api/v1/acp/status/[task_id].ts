import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseClient } from '../_supabase';

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACP-Key, ACP-Version, Authorization, X-Task-Token');
  res.setHeader('ACP-Version', '2.0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
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

  // Dual-track authentication check (P0-3 Hardened)
  const internalKey = (process.env.ACP_INTERNAL_KEY || '').trim();
  const acpKey = (req.headers['acp-key'] as string) || '';
  const authHeader = (req.headers['authorization'] as string) || '';
  // Token must only be supplied via secure header, never query string
  const taskToken = (req.headers['x-task-token'] as string) || '';
  let authorized = false;

  if (internalKey) {
    if (acpKey && acpKey === internalKey) {
      authorized = true;
    } else if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token === internalKey) {
        authorized = true;
      }
    }
  }

  try {
    // Whitelist task fields to avoid leaking PII (emails, payout credentials)
    const { data, error } = await supabase
      .from('agent_tasks')
      .select('id, agent_slug, agentId, status, resultPayload, deliverableFingerprint, deliveredAt, createdAt, taskToken')
      .eq('id', taskId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ success: false, error: { code: 'ACP_TASK_NOT_FOUND', message: 'Task not found' } });
      }
      return res.status(503).json({ success: false, error: { code: 'ACP_DB_ERROR', message: error.message || 'Database query failure' } });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: { code: 'ACP_TASK_NOT_FOUND', message: 'Task not found' } });
    }

    // Verify taskToken if not authorized by internal service key (strict equality)
    if (!authorized) {
      if (taskToken && typeof data.taskToken === 'string' && data.taskToken.length >= 10 && data.taskToken === taskToken) {
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(401).json({
        success: false,
        error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing authorization credentials' }
      });
    }

    return res.status(200).json({
      success: true,
      task: {
        id: data.id,
        agent_slug: data.agent_slug || (data as any).agentId || null,
        status: data.status,
        resultPayload: data.resultPayload,
        deliverable_fingerprint: data.deliverableFingerprint,
        deliveredAt: data.deliveredAt,
        createdAt: data.createdAt
      }
    });
  } catch (err: any) {
    return res.status(503).json({ success: false, error: { code: 'ACP_DB_ERROR', message: err?.message || 'Database query error' } });
  }
}
