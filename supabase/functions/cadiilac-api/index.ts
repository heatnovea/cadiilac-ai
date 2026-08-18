/**
 * Cadiilac AI — account and public API surface.
 *
 * Handles credit reporting, plan changes, API key lifecycle and backups for the
 * web app, and acts as the documented public endpoint for Cadiilac Cloud API
 * keys (`Authorization: Bearer cad_live_...`). AI actions are forwarded to the
 * ai-chat function so credit accounting lives in exactly one place.
 */

import {
  admin,
  authenticate,
  handleError,
  hashKey,
  HttpError,
  json,
  planOf,
  preflight,
  rateLimit,
  readJson,
  refreshCredits,
} from "../_shared/mod.ts";

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `cad_live_${body}`;
}

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  try {
    const db = admin();
    const caller = await authenticate(request, db);
    const body = await readJson<{ action?: string; plan?: string; name?: string; key_id?: string }>(request);
    const action = body.action ?? "credits";

    await rateLimit(db, caller.userId, `api:${action}`, 60, 60);

    switch (action) {
      case "credits":
        return json(await refreshCredits(db, caller));

      case "set_plan": {
        // Production billing calls this from the checkout webhook with the
        // service role; the in-app switch is kept for development environments.
        if (Deno.env.get("ALLOW_SELF_SERVE_PLAN_SWITCH") !== "true") {
          throw new HttpError(403, "Plan changes are handled by checkout.", "billing_required");
        }
        const plan = body.plan === "cloud" ? "cloud" : "free";
        const limits = planOf(plan);
        const { data } = await db
          .from("profiles")
          .update({
            plan,
            credits: Math.min(limits.maxCredits, Math.max(caller.profile.credits, limits.creditAllowance)),
            credits_reset_at: new Date(Date.now() + limits.creditWindowHours * 3600_000).toISOString(),
          })
          .eq("id", caller.userId)
          .select()
          .single();
        return json(data);
      }

      case "create_key": {
        if (!planOf(caller.profile.plan).features.api) {
          throw new HttpError(403, "API access requires Cadiilac Cloud.", "plan_required");
        }
        const name = (body.name ?? "").trim().slice(0, 60) || "Untitled key";
        const secret = newSecret();
        const { data, error } = await db
          .from("api_keys")
          .insert({ user_id: caller.userId, name, prefix: secret.slice(0, 16), key_hash: await hashKey(secret) })
          .select()
          .single();
        if (error) throw new HttpError(500, error.message);
        return json({ key: data, secret });
      }

      case "revoke_key": {
        if (!body.key_id) throw new HttpError(400, "Missing key id.");
        const { error } = await db
          .from("api_keys")
          .update({ revoked: true })
          .eq("id", body.key_id)
          .eq("user_id", caller.userId);
        if (error) throw new HttpError(500, error.message);
        return json({ ok: true });
      }

      case "backup": {
        if (!planOf(caller.profile.plan).features.backups) {
          throw new HttpError(403, "Cloud backups require Cadiilac Cloud.", "plan_required");
        }
        const { data: notes } = await db
          .from("notes")
          .select("id, title, content, strokes, style, created_at, updated_at")
          .eq("user_id", caller.userId);
        const { data, error } = await db
          .from("backups")
          .insert({ user_id: caller.userId, notes: notes?.length ?? 0, payload: { notes: notes ?? [] } })
          .select()
          .single();
        if (error) throw new HttpError(500, error.message);
        return json(data);
      }

      case "chat":
      case "tool":
      case "speak": {
        // Public API surface: forward to the dedicated function, preserving the
        // caller's credentials so credits are spent once, in one place.
        const base = Deno.env.get("SUPABASE_URL");
        const target = action === "speak" ? "tts" : "ai-chat";
        const response = await fetch(`${base}/functions/v1/${target}`, {
          method: "POST",
          headers: {
            Authorization: request.headers.get("Authorization") ?? "",
            "Content-Type": "application/json",
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          },
          body: JSON.stringify(body),
        });
        return json(await response.json(), response.status);
      }

      default:
        throw new HttpError(400, `Unknown action “${action}”.`);
    }
  } catch (error) {
    return handleError(error);
  }
});
