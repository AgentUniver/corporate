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

const ACTIVE_PROJECT_REF = 'rorfuxoelnylsvpinzbo';
const DEFAULT_SUPABASE_URL = 'https://rorfuxoelnylsvpinzbo.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvcmZ1eG9lbG55bHN2cGluemJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MTk2NDgsImV4cCI6MjEwNTk5NTY0OH0.RM4q_An173aCA0uT5Msw709FcMDm78JD2tdBiY0DP84';

function getSanitizedSupabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return DEFAULT_SUPABASE_URL;
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  url = url.replace('https://db.', 'https://');
  if (url.includes('lbkhvciymyzzjijuhbri')) {
    url = url.replace('lbkhvciymyzzjijuhbri', ACTIVE_PROJECT_REF);
  }
  try {
    new URL(url);
    return url;
  } catch {
    return DEFAULT_SUPABASE_URL;
  }
}

let _supabaseClient: any = null;
function getSupabaseClient() {
  if (_supabaseClient) return _supabaseClient;

  const rawUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const cleanUrl = getSanitizedSupabaseUrl(rawUrl);

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.PUBLIC_SUPABASE_ANON_KEY ||
    DEFAULT_SUPABASE_KEY;

  if (!cleanUrl || !key) return null;

  try {
    _supabaseClient = createClient(cleanUrl, key, {
      auth: { persistSession: false }
    });
    return _supabaseClient;
  } catch (err) {
    console.warn('[Supabase] Failed to initialize client safely:', err);
    return null;
  }
}

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
  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Database service unavailable' });
  }

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
