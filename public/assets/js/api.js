/** Chooses the backend implementation and exposes it as a single `api` object. */

import { DEMO_MODE } from "./config.js";
import { createLocalBackend } from "./backend/local.js";

let backend;

if (DEMO_MODE) {
  backend = createLocalBackend();
} else {
  const { createSupabaseBackend } = await import("./backend/supabase.js");
  backend = createSupabaseBackend();
}

export const api = backend;
export const isDemo = backend.mode === "demo";
