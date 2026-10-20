import { createClient } from '@supabase/supabase-js';

const ACTIVE_PROJECT_REF = 'rorfuxoelnylsvpinzbo';
const ACTIVE_SUPABASE_URL = 'https://rorfuxoelnylsvpinzbo.supabase.co';

function getSanitizedSupabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return ACTIVE_SUPABASE_URL;
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // Replace database host alias if mistakenly provided in environment variables
  url = url.replace('https://db.', 'https://');
  // Auto-migrate legacy/deprecated Supabase project references cached in runtime
  if (url.includes('lbkhvciymyzzjijuhbri')) {
    url = url.replace('lbkhvciymyzzjijuhbri', ACTIVE_PROJECT_REF);
  }
  return url;
}

const rawUrl = (import.meta.env.PUBLIC_SUPABASE_URL as string) || '';
const cleanUrl = rawUrl ? getSanitizedSupabaseUrl(rawUrl) : ACTIVE_SUPABASE_URL;
const supabaseAnonKey = ((import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) || '').trim();

export const isSupabaseConfigured = Boolean(cleanUrl && supabaseAnonKey);

function initializeSupabase() {
  if (!isSupabaseConfigured) return null;
  try {
    return createClient(cleanUrl, supabaseAnonKey);
  } catch (err) {
    console.warn('Failed to initialize Supabase client:', err);
    return null;
  }
}

export const supabase = initializeSupabase();

