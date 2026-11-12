import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const ACTIVE_PROJECT_REF = 'rorfuxoelnylsvpinzbo';

function getSanitizedSupabaseUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // Enforce https
  url = url.replace(/^http:\/\//i, 'https://');
  url = url.replace('https://db.', 'https://');
  if (url.includes('lbkhvciymyzzjijuhbri')) {
    url = url.replace('lbkhvciymyzzjijuhbri', ACTIVE_PROJECT_REF);
  }
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

let _cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_cachedClient) return _cachedClient;

  const rawUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const cleanUrl = getSanitizedSupabaseUrl(rawUrl);

  // Server-side ACP endpoints strictly require service role or backend write credentials
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;

  if (!cleanUrl || !key) {
    return null;
  }

  try {
    _cachedClient = createClient(cleanUrl, key, {
      auth: { persistSession: false }
    });
    return _cachedClient;
  } catch (err) {
    console.warn('[Supabase] Failed to initialize client safely:', err);
    return null;
  }
}

export function setSupabaseClientForTesting(client: SupabaseClient | null): void {
  _cachedClient = client;
  (globalThis as Record<string, unknown>).__agentuniverTestSupabaseClient = client;
}
