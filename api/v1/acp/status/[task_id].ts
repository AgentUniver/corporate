import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const taskId = (req.query.task_id as string) || '';

  try {
    const { data, error } = await supabase.from('agent_tasks').select('*').eq('id', taskId).single();
    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    return res.status(200).json({
      success: true,
      task: data
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Database query error' });
  }
}
