/**
 * Cadiilac AI — share links.
 *
 * Creating a link requires an authenticated owner. Resolving a link is public
 * but only ever returns a short-lived signed URL for a file whose share row is
 * set to `link` access, and download permission is honoured server side.
 */

import { admin, authenticate, handleError, HttpError, json, preflight, rateLimit, readJson } from "../_shared/mod.ts";

const BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "drive";

function token() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  try {
    const db = admin();
    const body = await readJson<{
      action?: string;
      token?: string;
      file_id?: string;
      access?: string;
      allow_download?: boolean;
      expires_in_days?: number | null;
    }>(request);

    /* ------------------------------------------------------ public resolve */
    if (body.action === "resolve") {
      if (!body.token) throw new HttpError(400, "Missing share token.");
      await rateLimit(db, `anon:${body.token}`, "share-resolve", 60, 60);

      const { data: share } = await db
        .from("share_links")
        .select("*")
        .eq("token", body.token)
        .eq("access", "link")
        .maybeSingle();
      if (!share) return json(null);
      if (share.expires_at && new Date(share.expires_at) < new Date()) return json(null);

      const { data: file } = await db
        .from("files")
        .select("id, name, size, mime, storage_key, created_at")
        .eq("id", share.file_id)
        .maybeSingle();
      if (!file) return json(null);

      const { data: signed, error } = await db.storage.from(BUCKET).createSignedUrl(file.storage_key, 900, {
        download: share.allow_download ? file.name : undefined,
      });
      if (error) throw new HttpError(500, "Could not prepare the file for viewing.");

      const { data: owner } = await db.from("profiles").select("name").eq("id", share.user_id).maybeSingle();
      await db.from("share_links").update({ views: (share.views ?? 0) + 1 }).eq("id", share.id);

      const { storage_key: _key, ...safeFile } = file;
      return json({ share: { ...share, user_id: undefined }, file: safeFile, url: signed.signedUrl, owner: owner?.name ?? null });
    }

    /* -------------------------------------------------------- owner writes */
    const caller = await authenticate(request, db);
    await rateLimit(db, caller.userId, "share-create", 30, 60);
    if (!body.file_id) throw new HttpError(400, "Missing file id.");

    const { data: file } = await db.from("files").select("id, user_id").eq("id", body.file_id).maybeSingle();
    if (!file || file.user_id !== caller.userId) throw new HttpError(404, "File not found.");

    const access = body.access === "link" ? "link" : "private";
    const { data: existing } = await db.from("share_links").select("*").eq("file_id", body.file_id).maybeSingle();

    const patch = {
      user_id: caller.userId,
      file_id: body.file_id,
      access,
      allow_download: body.allow_download !== false,
      expires_at: body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString() : null,
      token: existing?.token ?? token(),
    };

    const { data: share, error } = existing
      ? await db.from("share_links").update(patch).eq("id", existing.id).select().single()
      : await db.from("share_links").insert(patch).select().single();
    if (error) throw new HttpError(500, error.message);

    return json(share);
  } catch (error) {
    return handleError(error);
  }
});
