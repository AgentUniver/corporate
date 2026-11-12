import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const ACTIVE_PROJECT_REF = 'rorfuxoelnylsvpinzbo';
let _cachedClient: SupabaseClient | null = null;

function getSanitizedSupabaseUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  url = url.replace(/^http:\/\//i, 'https://');
  url = url.replace('https://db.', 'https://');
  if (url.includes('lbkhvciymyzzjijuhbri')) {
    url = url.replace('lbkhvciymyzzjijuhbri', ACTIVE_PROJECT_REF);
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname ? url : null;
  } catch {
    return null;
  }
}

// Self-contained client lookup avoids relative .ts imports that fail under Vercel Node ESM.
function resolveSupabaseClient(): SupabaseClient | null {
  const testClient = (globalThis as Record<string, unknown>).__agentuniverTestSupabaseClient as SupabaseClient | null | undefined;
  if (testClient !== undefined) {
    return testClient;
  }
  if (_cachedClient) return _cachedClient;

  const rawUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const cleanUrl = getSanitizedSupabaseUrl(rawUrl);
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;

  if (!cleanUrl || !key) {
    return null;
  }

  try {
    _cachedClient = createClient(cleanUrl, key, { auth: { persistSession: false } });
    return _cachedClient;
  } catch (err) {
    console.warn('[KeepAlive] Failed to initialize Supabase client safely:', err);
    return null;
  }
}

interface VercelRequest extends IncomingMessage {
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: unknown) => VercelResponse;
}

/**
 * Verifies optional CRON_SECRET bearer authorization when configured.
 */
function isAuthorizedCronRequest(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${cronSecret}`;
}

/**
 * Lightweight Supabase trickle keep-alive endpoint invoked by Vercel Cron and GitHub Actions.
 * Executes a head-only read query against agent_tasks to keep the Free-tier database active.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED'
    });
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED'
    });
  }

  const supabase = resolveSupabaseClient();
  if (!supabase) {
    return res.status(503).json({
      ok: false,
      error: 'SUPABASE_NOT_CONFIGURED'
    });
  }

  try {
    const { error } = await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true });

    if (error) {
      console.warn('[KeepAlive] Supabase probe error:', error.code || error.message);
      return res.status(503).json({
        ok: false,
        database_alive: false,
        error: 'SUPABASE_PROBE_FAILED'
      });
    }

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    return res.status(200).json({
      ok: true,
      service: 'agentuniver-keepalive',
      database_alive: true,
      timestamp: new Date().toISOString()
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn('[KeepAlive] Unexpected probe failure:', message);
    return res.status(503).json({
      ok: false,
      database_alive: false,
      error: 'SUPABASE_PROBE_EXCEPTION'
    });
  }
}
