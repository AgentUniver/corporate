import { createClient } from '@supabase/supabase-js';

const ACTIVE_PROJECT_REF = 'rorfuxoelnylsvpinzbo';
const ACTIVE_SUPABASE_URL = 'https://rorfuxoelnylsvpinzbo.supabase.co';
const ACTIVE_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvcmZ1eG9lbG55bHN2cGluemJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MTk2NDgsImV4cCI6MjEwNTk5NTY0OH0.RM4q_An173aCA0uT5Msw709FcMDm78JD2tdBiY0DP84';

function getSanitizedSupabaseUrl(rawUrl: string): string {
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

const rawUrl = (import.meta.env.PUBLIC_SUPABASE_URL as string) || ACTIVE_SUPABASE_URL;
const cleanUrl = getSanitizedSupabaseUrl(rawUrl);
let rawAnonKey = (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) || ACTIVE_SUPABASE_ANON_KEY;
if (!rawAnonKey || rawAnonKey.includes('lbkhvciymyzzjijuhbri') || cleanUrl.includes(ACTIVE_PROJECT_REF) && !rawAnonKey.includes(ACTIVE_PROJECT_REF)) {
  rawAnonKey = ACTIVE_SUPABASE_ANON_KEY;
}
const supabaseAnonKey = rawAnonKey;

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

