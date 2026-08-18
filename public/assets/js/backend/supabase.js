/**
 * Supabase backend. Mirrors the interface of the demo backend in ./local.js.
 *
 * Only the public anon key is used here; every table is protected by Row Level
 * Security and all metered operations (AI, credits, quotas, share links) run in
 * Edge Functions that hold the private provider keys.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { CONFIG, planOf } from "../config.js";

const nowIso = () => new Date().toISOString();

function weekStart() {
  const date = new Date();
  const day = (date.getDay() + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return date;
}

export function createSupabaseBackend() {
  const client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let userId = null;

  const unwrap = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  async function invoke(name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let message = error.message;
      try {
        const detail = await error.context?.json?.();
        if (detail?.error) message = detail.error;
        if (detail?.code) {
          const wrapped = new Error(message);
          wrapped.code = detail.code;
          throw wrapped;
        }
      } catch (parsed) {
        if (parsed instanceof Error && parsed.code) throw parsed;
      }
      throw new Error(message);
    }
    return data;
  }

  async function requireUser() {
    if (userId) return userId;
    const { data } = await client.auth.getUser();
    if (!data?.user) throw new Error("Not signed in");
    userId = data.user.id;
    return userId;
  }

  async function loadProfile(id) {
    const profile = unwrap(await client.from("profiles").select("*").eq("id", id).maybeSingle());
    if (profile) return profile;
    const { data: userData } = await client.auth.getUser();
    return unwrap(
      await client
        .from("profiles")
        .insert({ id, email: userData?.user?.email, name: userData?.user?.user_metadata?.name || null })
        .select()
        .single()
    );
  }

  return {
    mode: "supabase",
    client,

    /* auth */
    async getSession() {
      const { data } = await client.auth.getSession();
      if (!data.session) return null;
      userId = data.session.user.id;
      const profile = await loadProfile(userId);
      return { user: data.session.user, profile };
    },
    onAuthChange(fn) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        userId = session?.user?.id || null;
        fn(session ? { user: session.user } : null);
      });
      return () => data.subscription.unsubscribe();
    },
    async signUp({ email, password, name, plan = "free" }) {
      const result = unwrap(
        await client.auth.signUp({ email, password, options: { data: { name, requested_plan: plan } } })
      );
      if (result.user) {
        userId = result.user.id;
        await loadProfile(result.user.id);
      }
      return result;
    },
    async signIn({ email, password }) {
      const result = unwrap(await client.auth.signInWithPassword({ email, password }));
      userId = result.user.id;
      return result;
    },
    async signOut() {
      userId = null;
      unwrap(await client.auth.signOut());
    },
    async updateProfile(patch) {
      const id = await requireUser();
      return unwrap(await client.from("profiles").update(patch).eq("id", id).select().single());
    },
    async updateSettings(patch) {
      const id = await requireUser();
      const current = await loadProfile(id);
      const settings = { ...current.settings, ...patch, ai: { ...(current.settings?.ai || {}), ...(patch.ai || {}) } };
      return unwrap(await client.from("profiles").update({ settings }).eq("id", id).select().single());
    },
    async setPlan(plan) {
      // Real billing is handled by the checkout webhook; this switches plan in dev.
      return invoke("cadiilac-api", { action: "set_plan", plan });
    },

    /* notes */
    async listNotes() {
      const id = await requireUser();
      return unwrap(await client.from("notes").select("*").eq("user_id", id).order("updated_at", { ascending: false }));
    },
    async noteQuota() {
      const id = await requireUser();
      const profile = await loadProfile(id);
      const start = weekStart();
      const { count } = await client
        .from("notes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id)
        .gte("created_at", start.toISOString());
      return {
        used: count || 0,
        limit: planOf(profile.plan).notesPerWeek,
        resetsAt: new Date(start.getTime() + 7 * 86400000).toISOString(),
      };
    },
    async createNote(note) {
      const id = await requireUser();
      const { data, error } = await client.rpc("create_note", {
        p_title: note.title,
        p_content: note.content,
        p_strokes: note.strokes || [],
        p_style: note.style || {},
      });
      if (error) {
        const wrapped = new Error(error.message);
        if (/limit/i.test(error.message)) wrapped.code = "note_limit";
        throw wrapped;
      }
      return { ...data, user_id: id };
    },
    async updateNote(id, patch) {
      await requireUser();
      return unwrap(
        await client.from("notes").update({ ...patch, updated_at: nowIso() }).eq("id", id).select().single()
      );
    },
    async deleteNote(id) {
      await requireUser();
      unwrap(await client.from("notes").delete().eq("id", id));
    },
    async listVersions(noteId) {
      await requireUser();
      return unwrap(
        await client.from("note_versions").select("*").eq("note_id", noteId).order("created_at", { ascending: false }).limit(25)
      );
    },

    /* drive */
    async listFolders() {
      const id = await requireUser();
      return unwrap(await client.from("folders").select("*").eq("user_id", id).order("name"));
    },
    async createFolder(name, parentId = null) {
      const id = await requireUser();
      return unwrap(await client.from("folders").insert({ user_id: id, name, parent_id: parentId }).select().single());
    },
    async renameFolder(folderId, name) {
      await requireUser();
      return unwrap(await client.from("folders").update({ name }).eq("id", folderId).select().single());
    },
    async deleteFolder(folderId) {
      await requireUser();
      const files = unwrap(await client.from("files").select("id,storage_key").eq("folder_id", folderId));
      if (files.length) {
        await client.storage.from(CONFIG.storageBucket).remove(files.map((f) => f.storage_key));
        unwrap(await client.from("files").delete().eq("folder_id", folderId));
      }
      unwrap(await client.from("folders").delete().eq("id", folderId));
    },
    async listFiles(folderId = null) {
      const id = await requireUser();
      let query = client.from("files").select("*").eq("user_id", id).order("created_at", { ascending: false });
      query = folderId ? query.eq("folder_id", folderId) : query.is("folder_id", null);
      return unwrap(await query);
    },
    async storageUsage() {
      const id = await requireUser();
      const profile = await loadProfile(id);
      const { data } = await client.rpc("storage_used", { p_user: id });
      return { used: Number(data || 0), limit: planOf(profile.plan).storageBytes };
    },
    async uploadFile(file, folderId = null, onProgress) {
      const id = await requireUser();
      const usage = await this.storageUsage();
      if (usage.used + file.size > usage.limit) {
        const error = new Error("Not enough storage space. Free up files or upgrade to Cadiilac Cloud.");
        error.code = "storage_full";
        throw error;
      }
      const key = `${id}/${crypto.randomUUID()}/${file.name}`;
      if (onProgress) onProgress(15);
      const { error } = await client.storage.from(CONFIG.storageBucket).upload(key, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (error) throw new Error(error.message);
      if (onProgress) onProgress(85);
      const record = unwrap(
        await client
          .from("files")
          .insert({
            user_id: id,
            folder_id: folderId,
            name: file.name,
            size: file.size,
            mime: file.type || "application/octet-stream",
            storage_key: key,
          })
          .select()
          .single()
      );
      if (onProgress) onProgress(100);
      return record;
    },
    async renameFile(fileId, name) {
      await requireUser();
      return unwrap(await client.from("files").update({ name, updated_at: nowIso() }).eq("id", fileId).select().single());
    },
    async moveFile(fileId, folderId) {
      await requireUser();
      return unwrap(await client.from("files").update({ folder_id: folderId }).eq("id", fileId).select().single());
    },
    async deleteFile(fileId) {
      await requireUser();
      const file = unwrap(await client.from("files").select("storage_key").eq("id", fileId).single());
      await client.storage.from(CONFIG.storageBucket).remove([file.storage_key]);
      unwrap(await client.from("files").delete().eq("id", fileId));
    },
    async fileUrl(fileId) {
      await requireUser();
      const file = unwrap(await client.from("files").select("storage_key").eq("id", fileId).single());
      const { data, error } = await client.storage.from(CONFIG.storageBucket).createSignedUrl(file.storage_key, 3600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
    async fileBlob(fileId) {
      await requireUser();
      const file = unwrap(await client.from("files").select("storage_key").eq("id", fileId).single());
      const { data, error } = await client.storage.from(CONFIG.storageBucket).download(file.storage_key);
      if (error) throw new Error(error.message);
      return data;
    },

    /* sharing */
    async listShares() {
      const id = await requireUser();
      return unwrap(await client.from("share_links").select("*").eq("user_id", id));
    },
    async createShare(fileId, options) {
      await requireUser();
      return invoke("create-share-link", { file_id: fileId, ...options });
    },
    async deleteShare(shareId) {
      await requireUser();
      unwrap(await client.from("share_links").delete().eq("id", shareId));
    },
    async resolveShare(token) {
      const { data, error } = await client.functions.invoke("create-share-link", {
        body: { action: "resolve", token },
      });
      if (error) return null;
      return data;
    },

    /* conversations */
    async listConversations() {
      const id = await requireUser();
      return unwrap(
        await client.from("conversations").select("*").eq("user_id", id).order("updated_at", { ascending: false })
      );
    },
    async createConversation(title = "New conversation") {
      const id = await requireUser();
      return unwrap(await client.from("conversations").insert({ user_id: id, title, messages: [] }).select().single());
    },
    async updateConversation(conversationId, patch) {
      await requireUser();
      return unwrap(
        await client
          .from("conversations")
          .update({ ...patch, updated_at: nowIso() })
          .eq("id", conversationId)
          .select()
          .single()
      );
    },
    async deleteConversation(conversationId) {
      await requireUser();
      unwrap(await client.from("conversations").delete().eq("id", conversationId));
    },

    /* ai */
    async credits() {
      return invoke("cadiilac-api", { action: "credits" });
    },
    async chat(payload) {
      return invoke("ai-chat", { action: "chat", ...payload });
    },
    async tool(payload) {
      return invoke("ai-chat", { action: "tool", ...payload });
    },
    async speak(payload) {
      const result = await invoke("tts", payload);
      return { audioUrl: result.audio ? `data:${result.mime};base64,${result.audio}` : null, credits: result.credits };
    },
    async listUsage() {
      const id = await requireUser();
      return unwrap(
        await client.from("ai_usage").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(100)
      );
    },

    /* study */
    async listStudySessions() {
      const id = await requireUser();
      return unwrap(
        await client.from("study_sessions").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(50)
      );
    },
    async recordStudySession(entry) {
      const id = await requireUser();
      return unwrap(await client.from("study_sessions").insert({ user_id: id, ...entry }).select().single());
    },

    /* api keys */
    async listApiKeys() {
      const id = await requireUser();
      return unwrap(await client.from("api_keys").select("*").eq("user_id", id).order("created_at", { ascending: false }));
    },
    async createApiKey(name) {
      return invoke("cadiilac-api", { action: "create_key", name });
    },
    async revokeApiKey(keyId) {
      return invoke("cadiilac-api", { action: "revoke_key", key_id: keyId });
    },

    /* backups */
    async createBackup() {
      return invoke("cadiilac-api", { action: "backup" });
    },
    async listBackups() {
      const id = await requireUser();
      return unwrap(
        await client.from("backups").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(20)
      );
    },
  };
}
