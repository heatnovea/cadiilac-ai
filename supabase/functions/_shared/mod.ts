/**
 * Shared helpers for the Cadiilac AI Edge Functions.
 *
 * Provider secrets (OpenRouter, ElevenLabs) and the Supabase service role key
 * are read from the function environment only — they are never exposed to the
 * browser. Quotas, credits and plan gating are decided here, server side.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const PLANS = {
  free: {
    id: "free",
    storageBytes: 5 * 1024 * 1024 * 1024,
    notesPerWeek: 15,
    creditAllowance: 75,
    creditWindowHours: 24,
    maxCredits: 75,
    features: { backups: false, personality: false, api: false },
  },
  cloud: {
    id: "cloud",
    storageBytes: 20 * 1024 * 1024 * 1024,
    notesPerWeek: Number.MAX_SAFE_INTEGER,
    creditAllowance: 250,
    creditWindowHours: 12,
    maxCredits: 500,
    features: { backups: true, personality: true, api: true },
  },
} as const;

export type PlanId = keyof typeof PLANS;
export const planOf = (plan?: string | null) => PLANS[(plan as PlanId) ?? "free"] ?? PLANS.free;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function handleError(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  console.error(error);
  return json({ error: "Unexpected server error." }, 500);
}

export function admin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new HttpError(500, "Supabase service credentials are not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface Caller {
  userId: string;
  profile: Record<string, unknown> & { plan: string; credits: number; credits_reset_at: string };
  viaApiKey: boolean;
  apiKeyId?: string;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashKey(secret: string) {
  return sha256(`${secret}:${Deno.env.get("API_KEY_PEPPER") ?? "cadiilac"}`);
}

/**
 * Resolves the caller from either a Supabase session JWT or a Cadiilac API key
 * (`Authorization: Bearer cad_live_...`). API keys are a Cloud-only feature.
 */
export async function authenticate(request: Request, db: SupabaseClient): Promise<Caller> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Missing authorization header.", "unauthenticated");

  if (token.startsWith("cad_live_")) {
    const keyHash = await hashKey(token);
    const { data: key } = await db
      .from("api_keys")
      .select("id, user_id, revoked")
      .eq("key_hash", keyHash)
      .maybeSingle();
    if (!key || key.revoked) throw new HttpError(401, "Invalid or revoked API key.", "bad_api_key");

    const profile = await loadProfile(db, key.user_id);
    if (!planOf(profile.plan).features.api) {
      throw new HttpError(403, "API access requires Cadiilac Cloud.", "plan_required");
    }
    await db
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString(), requests: (key as { requests?: number }).requests ?? 0 })
      .eq("id", key.id);
    return { userId: key.user_id, profile, viaApiKey: true, apiKeyId: key.id };
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid session.", "unauthenticated");
  return { userId: data.user.id, profile: await loadProfile(db, data.user.id), viaApiKey: false };
}

export async function loadProfile(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error || !data) throw new HttpError(404, "Profile not found.");
  return data as Caller["profile"];
}

/** Sliding-window rate limit backed by the `rate_limits` table. */
export async function rateLimit(db: SupabaseClient, subject: string, route: string, max: number, windowSeconds: number) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count } = await db
    .from("rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("subject", subject)
    .eq("route", route)
    .gte("created_at", since);

  if ((count ?? 0) >= max) {
    throw new HttpError(429, "Too many requests. Please slow down.", "rate_limited");
  }
  await db.from("rate_limits").insert({ subject, route });
}

/** Refills credits when the rolling window has elapsed. */
export async function refreshCredits(db: SupabaseClient, caller: Caller) {
  const plan = planOf(caller.profile.plan);
  const resetsAt = new Date(caller.profile.credits_reset_at);
  if (Number.isNaN(resetsAt.getTime()) || resetsAt.getTime() > Date.now()) {
    return {
      balance: caller.profile.credits,
      max: plan.maxCredits,
      allowance: plan.creditAllowance,
      resetsAt: caller.profile.credits_reset_at,
      usedTotal: (caller.profile as { credits_used_total?: number }).credits_used_total ?? 0,
    };
  }

  const windows = Math.max(1, Math.floor((Date.now() - resetsAt.getTime()) / (plan.creditWindowHours * 3600_000)) + 1);
  const balance = Math.min(plan.maxCredits, caller.profile.credits + plan.creditAllowance * windows);
  const next = new Date(Date.now() + plan.creditWindowHours * 3600_000).toISOString();

  const { data } = await db
    .from("profiles")
    .update({ credits: balance, credits_reset_at: next })
    .eq("id", caller.userId)
    .select()
    .single();
  if (data) caller.profile = data as Caller["profile"];

  return {
    balance,
    max: plan.maxCredits,
    allowance: plan.creditAllowance,
    resetsAt: next,
    usedTotal: (data as { credits_used_total?: number } | null)?.credits_used_total ?? 0,
  };
}

/** Deducts credits atomically; throws when the balance is insufficient. */
export async function spendCredits(db: SupabaseClient, caller: Caller, cost: number, kind: string, model?: string) {
  const credits = await refreshCredits(db, caller);
  if (credits.balance < cost) {
    throw new HttpError(
      402,
      `You are out of AI credits. ${planOf(caller.profile.plan).creditAllowance} more arrive at ${new Date(
        credits.resetsAt
      ).toLocaleTimeString()}.`,
      "no_credits"
    );
  }

  const { data } = await db
    .from("profiles")
    .update({
      credits: credits.balance - cost,
      credits_used_total: (credits.usedTotal ?? 0) + cost,
    })
    .eq("id", caller.userId)
    .select()
    .single();
  if (data) caller.profile = data as Caller["profile"];

  await db.from("ai_usage").insert({ user_id: caller.userId, kind, cost, model });
  return { ...credits, balance: credits.balance - cost };
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

export function preflight(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  return null;
}
