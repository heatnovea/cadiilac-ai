/**
 * Cadiilac AI — public runtime configuration.
 *
 * Only browser-safe values belong here. The Supabase anon key is designed to be
 * public and is protected by Row Level Security; the OpenRouter and ElevenLabs
 * keys live exclusively in the Supabase Edge Functions (see supabase/functions).
 *
 * To point the app at a real project either edit the values below or serve a
 * `/config.local.js` that sets `window.CADIILAC_CONFIG` before this module loads.
 */

const PLACEHOLDER_URL = "https://YOUR-PROJECT.supabase.co";
const PLACEHOLDER_KEY = "YOUR-SUPABASE-ANON-KEY";

const defaults = {
  supabaseUrl: PLACEHOLDER_URL,
  supabaseAnonKey: PLACEHOLDER_KEY,
  // Overridable when functions are served from a custom domain.
  functionsUrl: "",
  storageBucket: "drive",
  supportEmail: "support@cadiilac.ai",
};

const overrides = typeof window !== "undefined" && window.CADIILAC_CONFIG ? window.CADIILAC_CONFIG : {};

export const CONFIG = { ...defaults, ...overrides };

/** True when real Supabase credentials have been supplied. */
export const isConfigured =
  Boolean(CONFIG.supabaseUrl) &&
  Boolean(CONFIG.supabaseAnonKey) &&
  CONFIG.supabaseUrl !== PLACEHOLDER_URL &&
  CONFIG.supabaseAnonKey !== PLACEHOLDER_KEY;

/**
 * With no credentials the app runs against an in-browser backend so the entire
 * product can be explored, developed and demoed offline.
 */
export const DEMO_MODE = !isConfigured;

export const PLANS = {
  free: {
    id: "free",
    label: "Free",
    storageBytes: 5 * 1024 * 1024 * 1024,
    notesPerWeek: 15,
    creditAllowance: 75,
    creditWindowHours: 24,
    maxCredits: 75,
    features: { backups: false, personality: false, api: false },
  },
  cloud: {
    id: "cloud",
    label: "Cadiilac Cloud",
    storageBytes: 20 * 1024 * 1024 * 1024,
    notesPerWeek: Infinity,
    creditAllowance: 250,
    creditWindowHours: 12,
    maxCredits: 500,
    features: { backups: true, personality: true, api: true },
  },
};

export const planOf = (plan) => PLANS[plan] || PLANS.free;
