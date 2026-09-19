import { createClient } from '@supabase/supabase-js';

function getSanitizedSupabaseUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // Replace database host alias if mistakenly provided in environment variables
  url = url.replace('https://db.', 'https://');
  return url;
}

const rawUrl = (import.meta.env.PUBLIC_SUPABASE_URL as string) || '';
const cleanUrl = getSanitizedSupabaseUrl(rawUrl);
const supabaseAnonKey = (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) || '';

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

