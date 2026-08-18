/**
 * In-browser backend used when no Supabase credentials are configured.
 *
 * It mirrors the Supabase backend's interface exactly so the entire product can
 * be developed and demoed offline. Metadata lives in localStorage, file blobs in
 * IndexedDB, and AI responses are generated locally instead of via OpenRouter.
 */

import { uid } from "../util.js";
import { PLANS, planOf } from "../config.js";

const SESSION_KEY = "cadiilac.demo.session";
const USERS_KEY = "cadiilac.demo.users";
const DATA_KEY = (userId) => `cadiilac.demo.data.${userId}`;

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

/* ---------------------------------------------------------------- blob store */

const DB_NAME = "cadiilac-drive";
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("blobs");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function blobPut(key, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function blobGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readonly");
    const request = tx.objectStore("blobs").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function blobDelete(key) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------- helpers */

const emptyData = () => ({
  notes: [],
  versions: [],
  folders: [],
  files: [],
  shares: [],
  apiKeys: [],
  conversations: [],
  studySessions: [],
  usage: [],
});

const nowIso = () => new Date().toISOString();

function hash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export function createLocalBackend() {
  let session = read(SESSION_KEY, null);
  const listeners = new Set();

  const users = () => read(USERS_KEY, {});
  const saveUsers = (value) => write(USERS_KEY, value);

  const data = () => (session ? read(DATA_KEY(session.userId), emptyData()) : emptyData());
  const saveData = (value) => session && write(DATA_KEY(session.userId), value);

  const profile = () => {
    const record = users()[session?.userId];
    return record ? record.profile : null;
  };

  const saveProfile = (next) => {
    const all = users();
    all[session.userId].profile = next;
    saveUsers(all);
    return next;
  };

  const emit = () => listeners.forEach((fn) => fn(session ? { user: { id: session.userId, email: session.email } } : null));

  const requireSession = () => {
    if (!session) throw new Error("Not signed in");
    return session;
  };

  function defaultProfile(email, name, plan = "free") {
    return {
      id: uid("user"),
      email,
      name: name || email.split("@")[0],
      plan,
      created_at: nowIso(),
      credits: { balance: planOf(plan).creditAllowance, window_start: nowIso(), used_total: 0 },
      settings: {
        theme: "system",
        density: "comfortable",
        animations: "on",
        ai: {
          personality: "Focused study partner",
          formality: "balanced",
          length: "balanced",
          tone: "warm",
          encouragement: "medium",
          teaching_style: "socratic",
          creativity: 0.6,
          custom_instructions: "",
          voice_id: "rachel",
          voice_speed: 1,
        },
      },
    };
  }

  /** Credits refill on a rolling window, exactly like the edge function does. */
  function refreshCredits() {
    const current = profile();
    if (!current) return null;
    const plan = planOf(current.plan);
    const windowMs = plan.creditWindowHours * 3600 * 1000;
    const start = new Date(current.credits.window_start).getTime();
    const elapsed = Date.now() - start;
    if (elapsed >= windowMs) {
      const windows = Math.floor(elapsed / windowMs);
      const granted = plan.id === "cloud" ? Math.min(plan.maxCredits, current.credits.balance + plan.creditAllowance * windows) : plan.creditAllowance;
      current.credits = {
        ...current.credits,
        balance: Math.min(plan.maxCredits, granted),
        window_start: new Date(start + windows * windowMs).toISOString(),
      };
      saveProfile(current);
    }
    return current;
  }

  function creditState() {
    const current = refreshCredits();
    const plan = planOf(current.plan);
    const resetsAt = new Date(new Date(current.credits.window_start).getTime() + plan.creditWindowHours * 3600 * 1000);
    return {
      balance: current.credits.balance,
      max: plan.maxCredits,
      allowance: plan.creditAllowance,
      windowHours: plan.creditWindowHours,
      usedTotal: current.credits.used_total,
      resetsAt: resetsAt.toISOString(),
    };
  }

  function spendCredits(cost, kind) {
    const current = refreshCredits();
    if (current.credits.balance < cost) {
      const error = new Error("You are out of AI credits for this period.");
      error.code = "no_credits";
      throw error;
    }
    current.credits.balance -= cost;
    current.credits.used_total += cost;
    saveProfile(current);
    const store = data();
    store.usage.unshift({ id: uid("usage"), kind, cost, created_at: nowIso() });
    store.usage = store.usage.slice(0, 200);
    saveData(store);
  }

  function weekStart() {
    const date = new Date();
    const day = (date.getDay() + 6) % 7;
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - day);
    return date;
  }

  /* --------------------------------------------------------------- local ai */

  function localAnswer(messages, context) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const prompt = (last?.content || "").trim();
    const short = prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt;
    const lines = [
      `**Demo mode** — no OpenRouter key is configured, so this reply is generated locally.`,
      "",
      `You asked: “${short || "(empty prompt)"}”.`,
      "",
      "Once you add `OPENROUTER_API_KEY` to the Supabase Edge Functions, the same request is routed to the configured model and answered by Cadiilac AI with your personality settings applied.",
    ];
    if (context) lines.push("", `Document context detected (${context.length} characters) and would be sent with the prompt.`);
    return lines.join("\n");
  }

  function localTool(tool, text) {
    const clean = text.replace(/\s+/g, " ").trim();
    const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
    const keywords = [...new Set(clean.toLowerCase().match(/\b[a-z]{6,}\b/g) || [])].slice(0, 8);
    switch (tool) {
      case "summarize":
        return `Summary (demo): ${sentences.slice(0, 2).join(" ") || clean.slice(0, 160)}`;
      case "rewrite":
        return `Rewritten (demo): ${clean}`;
      case "simplify":
        return `In plain language (demo): ${sentences.slice(0, 1).join(" ") || clean.slice(0, 140)}`;
      case "expand":
        return `${clean}\n\nExpanded (demo): this section would be developed with additional detail, examples and context by the configured model.`;
      case "grammar":
        return clean.replace(/\s+([,.;:])/g, "$1");
      case "concise":
        return sentences.slice(0, 1).join(" ") || clean.slice(0, 120);
      case "study-notes":
        return `Study notes (demo):\n${sentences.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
      case "flashcards":
        return JSON.stringify({
          cards: keywords.slice(0, 6).map((word) => ({ front: `Define “${word}”`, back: `Demo definition of ${word} drawn from your note.` })),
        });
      case "quiz":
        return JSON.stringify({
          questions: keywords.slice(0, 4).map((word, index) => ({
            question: `Which statement best describes “${word}”?`,
            options: [`A correct description of ${word}`, `An unrelated definition`, `A partially correct claim`, `None of these`],
            answer: 0,
            explanation: `Demo explanation for ${word}; the configured model produces real rationale.`,
            index,
          })),
        });
      case "key-concepts":
        return JSON.stringify({ concepts: keywords.map((word) => ({ term: word, note: `Why ${word} matters in this document.` })) });
      case "questions":
        return sentences.slice(0, 4).map((s, i) => `${i + 1}. What does “${s.slice(0, 60)}” imply?`).join("\n");
      default:
        return `${clean}`;
    }
  }

  /* ------------------------------------------------------------------- api */

  return {
    mode: "demo",

    /* auth */
    async getSession() {
      if (!session) return null;
      refreshCredits();
      return { user: { id: session.userId, email: session.email }, profile: profile() };
    },
    onAuthChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async signUp({ email, password, name, plan = "free" }) {
      const all = users();
      const key = email.toLowerCase();
      if (Object.values(all).some((u) => u.email === key)) throw new Error("An account with that email already exists.");
      const userId = uid("u");
      all[userId] = { email: key, password: hash(password), profile: { ...defaultProfile(key, name, plan), id: userId } };
      saveUsers(all);
      session = { userId, email: key };
      write(SESSION_KEY, session);
      write(DATA_KEY(userId), emptyData());
      emit();
      return { user: { id: userId, email: key } };
    },
    async signIn({ email, password }) {
      const all = users();
      const key = email.toLowerCase();
      const entry = Object.entries(all).find(([, u]) => u.email === key);
      if (!entry || entry[1].password !== hash(password)) throw new Error("Incorrect email or password.");
      session = { userId: entry[0], email: key };
      write(SESSION_KEY, session);
      emit();
      return { user: { id: entry[0], email: key } };
    },
    async signOut() {
      session = null;
      localStorage.removeItem(SESSION_KEY);
      emit();
    },
    async updateProfile(patch) {
      requireSession();
      return saveProfile({ ...profile(), ...patch });
    },
    async updateSettings(patch) {
      requireSession();
      const current = profile();
      const settings = { ...current.settings, ...patch, ai: { ...current.settings.ai, ...(patch.ai || {}) } };
      return saveProfile({ ...current, settings });
    },
    async setPlan(plan) {
      requireSession();
      const current = profile();
      const next = planOf(plan);
      current.plan = plan;
      current.credits = { ...current.credits, balance: Math.min(next.maxCredits, next.creditAllowance), window_start: nowIso() };
      return saveProfile(current);
    },

    /* notes */
    async listNotes() {
      requireSession();
      return [...data().notes].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },
    async noteQuota() {
      requireSession();
      const start = weekStart();
      const created = data().notes.filter((n) => new Date(n.created_at) >= start).length;
      const plan = planOf(profile().plan);
      return { used: created, limit: plan.notesPerWeek, resetsAt: new Date(start.getTime() + 7 * 86400000).toISOString() };
    },
    async createNote(note) {
      requireSession();
      const quota = await this.noteQuota();
      if (quota.used >= quota.limit) {
        const error = new Error(`Free plan limit reached: ${quota.limit} notes this week. Upgrade to Cadiilac Cloud for unlimited notes.`);
        error.code = "note_limit";
        throw error;
      }
      const store = data();
      const record = { id: uid("note"), created_at: nowIso(), updated_at: nowIso(), ...note };
      store.notes.unshift(record);
      saveData(store);
      return record;
    },
    async updateNote(id, patch) {
      requireSession();
      const store = data();
      const index = store.notes.findIndex((n) => n.id === id);
      if (index === -1) throw new Error("Note not found");
      const previous = store.notes[index];
      const next = { ...previous, ...patch, updated_at: nowIso() };
      store.notes[index] = next;
      if (planOf(profile().plan).features.backups && patch.content !== undefined && patch.content !== previous.content) {
        store.versions.unshift({ id: uid("ver"), note_id: id, created_at: nowIso(), content: previous.content, title: previous.title });
        store.versions = store.versions.filter((v) => v.note_id !== id).concat(store.versions.filter((v) => v.note_id === id).slice(0, 25));
      }
      saveData(store);
      return next;
    },
    async deleteNote(id) {
      requireSession();
      const store = data();
      store.notes = store.notes.filter((n) => n.id !== id);
      store.versions = store.versions.filter((v) => v.note_id !== id);
      saveData(store);
    },
    async listVersions(noteId) {
      requireSession();
      return data().versions.filter((v) => v.note_id === noteId);
    },

    /* drive */
    async listFolders() {
      requireSession();
      return data().folders;
    },
    async createFolder(name, parentId = null) {
      requireSession();
      const store = data();
      const folder = { id: uid("fld"), name, parent_id: parentId, created_at: nowIso() };
      store.folders.push(folder);
      saveData(store);
      return folder;
    },
    async renameFolder(id, name) {
      requireSession();
      const store = data();
      const folder = store.folders.find((f) => f.id === id);
      if (folder) folder.name = name;
      saveData(store);
      return folder;
    },
    async deleteFolder(id) {
      requireSession();
      const store = data();
      const targets = store.files.filter((f) => f.folder_id === id);
      await Promise.all(targets.map((file) => blobDelete(file.storage_key)));
      store.files = store.files.filter((f) => f.folder_id !== id);
      store.folders = store.folders.filter((f) => f.id !== id);
      saveData(store);
    },
    async listFiles(folderId = null) {
      requireSession();
      return data().files.filter((f) => (f.folder_id || null) === (folderId || null));
    },
    async storageUsage() {
      requireSession();
      const used = data().files.reduce((sum, file) => sum + file.size, 0);
      return { used, limit: planOf(profile().plan).storageBytes };
    },
    async uploadFile(file, folderId = null, onProgress) {
      requireSession();
      const usage = await this.storageUsage();
      if (usage.used + file.size > usage.limit) {
        const error = new Error("Not enough storage space. Free up files or upgrade to Cadiilac Cloud.");
        error.code = "storage_full";
        throw error;
      }
      const key = uid("blob");
      // Simulated progress keeps the upload UI identical across backends.
      for (let percent = 20; percent <= 80 && onProgress; percent += 20) {
        onProgress(percent);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await blobPut(key, file);
      if (onProgress) onProgress(100);
      const store = data();
      const record = {
        id: uid("file"),
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        folder_id: folderId,
        storage_key: key,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.files.unshift(record);
      saveData(store);
      return record;
    },
    async renameFile(id, name) {
      requireSession();
      const store = data();
      const file = store.files.find((f) => f.id === id);
      if (file) {
        file.name = name;
        file.updated_at = nowIso();
      }
      saveData(store);
      return file;
    },
    async moveFile(id, folderId) {
      requireSession();
      const store = data();
      const file = store.files.find((f) => f.id === id);
      if (file) file.folder_id = folderId;
      saveData(store);
      return file;
    },
    async deleteFile(id) {
      requireSession();
      const store = data();
      const file = store.files.find((f) => f.id === id);
      if (file) await blobDelete(file.storage_key);
      store.files = store.files.filter((f) => f.id !== id);
      store.shares = store.shares.filter((s) => s.file_id !== id);
      saveData(store);
    },
    async fileUrl(id) {
      requireSession();
      const file = data().files.find((f) => f.id === id);
      if (!file) throw new Error("File not found");
      const blob = await blobGet(file.storage_key);
      if (!blob) throw new Error("File contents unavailable");
      return URL.createObjectURL(blob);
    },
    async fileBlob(id) {
      requireSession();
      const file = data().files.find((f) => f.id === id);
      return file ? blobGet(file.storage_key) : null;
    },

    /* sharing */
    async listShares() {
      requireSession();
      return data().shares;
    },
    async createShare(fileId, options) {
      requireSession();
      const store = data();
      const existing = store.shares.find((s) => s.file_id === fileId);
      const share = existing || { id: uid("share"), file_id: fileId, token: uid("t").replace("t_", ""), created_at: nowIso(), views: 0 };
      Object.assign(share, options);
      if (!existing) store.shares.push(share);
      saveData(store);
      return share;
    },
    async deleteShare(id) {
      requireSession();
      const store = data();
      store.shares = store.shares.filter((s) => s.id !== id);
      saveData(store);
    },
    async resolveShare(token) {
      // Public route: scan every demo user, mirroring an unauthenticated lookup.
      for (const userId of Object.keys(users())) {
        const store = read(DATA_KEY(userId), emptyData());
        const share = store.shares.find((s) => s.token === token && s.access === "link");
        if (!share) continue;
        const file = store.files.find((f) => f.id === share.file_id);
        if (!file) continue;
        const blob = await blobGet(file.storage_key);
        return { share, file, url: blob ? URL.createObjectURL(blob) : null, owner: users()[userId].profile.name };
      }
      return null;
    },

    /* conversations */
    async listConversations() {
      requireSession();
      return [...data().conversations].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },
    async createConversation(title = "New conversation") {
      requireSession();
      const store = data();
      const conversation = { id: uid("conv"), title, messages: [], created_at: nowIso(), updated_at: nowIso() };
      store.conversations.unshift(conversation);
      saveData(store);
      return conversation;
    },
    async updateConversation(id, patch) {
      requireSession();
      const store = data();
      const index = store.conversations.findIndex((c) => c.id === id);
      if (index === -1) throw new Error("Conversation not found");
      store.conversations[index] = { ...store.conversations[index], ...patch, updated_at: nowIso() };
      saveData(store);
      return store.conversations[index];
    },
    async deleteConversation(id) {
      requireSession();
      const store = data();
      store.conversations = store.conversations.filter((c) => c.id !== id);
      saveData(store);
    },

    /* ai */
    async credits() {
      requireSession();
      return creditState();
    },
    async chat({ messages, context }) {
      requireSession();
      spendCredits(1, "chat");
      await new Promise((resolve) => setTimeout(resolve, 350));
      return { content: localAnswer(messages, context), credits: creditState(), model: "demo/local" };
    },
    async tool({ tool, text }) {
      requireSession();
      spendCredits(1, `tool:${tool}`);
      await new Promise((resolve) => setTimeout(resolve, 260));
      return { content: localTool(tool, text || ""), credits: creditState(), model: "demo/local" };
    },
    async speak({ text }) {
      requireSession();
      spendCredits(2, "tts");
      // Falls back to the browser speech engine when ElevenLabs is not configured.
      return { audioUrl: null, speak: text, credits: creditState() };
    },
    async listUsage() {
      requireSession();
      return data().usage;
    },

    /* study */
    async listStudySessions() {
      requireSession();
      return data().studySessions;
    },
    async recordStudySession(entry) {
      requireSession();
      const store = data();
      const record = { id: uid("study"), created_at: nowIso(), ...entry };
      store.studySessions.unshift(record);
      store.studySessions = store.studySessions.slice(0, 100);
      saveData(store);
      return record;
    },

    /* api keys */
    async listApiKeys() {
      requireSession();
      return data().apiKeys;
    },
    async createApiKey(name) {
      requireSession();
      if (!planOf(profile().plan).features.api) throw new Error("Cadiilac API access requires Cadiilac Cloud.");
      const store = data();
      const secret = `cad_live_${uid("k").replace("k_", "")}${uid("s").replace("s_", "")}`.replace(/-/g, "");
      const record = {
        id: uid("key"),
        name,
        prefix: secret.slice(0, 16),
        created_at: nowIso(),
        last_used_at: null,
        revoked: false,
        requests: 0,
      };
      store.apiKeys.unshift(record);
      saveData(store);
      return { key: record, secret };
    },
    async revokeApiKey(id) {
      requireSession();
      const store = data();
      const key = store.apiKeys.find((k) => k.id === id);
      if (key) key.revoked = true;
      saveData(store);
    },

    /* backups */
    async createBackup() {
      requireSession();
      const store = data();
      const payload = { notes: store.notes, created_at: nowIso() };
      store.backups = [{ id: uid("bk"), created_at: payload.created_at, notes: store.notes.length }, ...(store.backups || [])].slice(0, 20);
      saveData(store);
      return payload;
    },
    async listBackups() {
      requireSession();
      return data().backups || [];
    },
  };
}

export { PLANS };
