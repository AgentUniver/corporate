import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body: any;
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || 'https://lbkhvciymyzzjijuhbri.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACP-Key, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const taskId = (req.query.task_id as string) || '';
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { output, agent_slug } = body;
  const deliveredAt = new Date().toISOString();

  try {
    const { data, error } = await supabase.from('agent_tasks').update({
      status: 'completed',
      resultPayload: output,
      deliveredAt: deliveredAt
    }).eq('id', taskId).select();

    return res.status(200).json({
      success: true,
      task_id: taskId,
      agent_slug: agent_slug,
      status: 'delivered',
      delivered_at: deliveredAt,
      message: 'Delivery confirmed and logged into Supabase ledger.'
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Failed to confirm task delivery'
    });
  }
}
