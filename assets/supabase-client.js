import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = window.RECIPE_WEB_SUPABASE_URL || localStorage.getItem('recipe_web_supabase_url') || '';
const SUPABASE_ANON_KEY =
  window.RECIPE_WEB_SUPABASE_ANON_KEY || localStorage.getItem('recipe_web_supabase_anon_key') || '';

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

export function hasSupabaseConfig() {
  return Boolean(supabase);
}
