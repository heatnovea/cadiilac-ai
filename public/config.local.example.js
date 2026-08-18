/**
 * Copy to `public/config.local.js` and add the reference below to the <head> of
 * index.html, auth.html, app.html and share.html to point the app at a real
 * Supabase project:
 *
 *   <script src="/config.local.js"></script>
 *
 * Only browser-safe values belong here. The anon key is public by design and is
 * protected by Row Level Security; never place the service role key, the
 * OpenRouter key or the ElevenLabs key in this file.
 */

window.CADIILAC_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-SUPABASE-ANON-KEY",
  storageBucket: "drive",
};
