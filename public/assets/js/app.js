import { $, el, toast, ICONS, formatBytes, formatCountdown } from "./util.js";
import { api, isDemo } from "./api.js";
import { planOf } from "./config.js";

const view = $("#view");
const titleNode = $("#viewTitle");
const actionsNode = $("#topbarActions");

const ROUTES = {
  notes: { label: "Notes", icon: ICONS.notes, load: () => import("./views/notes.js") },
  ai: { label: "AI", icon: ICONS.ai, load: () => import("./views/ai.js") },
  drive: { label: "Drive", icon: ICONS.drive, load: () => import("./views/drive.js") },
  settings: { label: "Settings", icon: ICONS.settings, load: () => import("./views/settings.js") },
};

export const state = {
  user: null,
  profile: null,
  plan: planOf("free"),
  credits: null,
  storage: null,
  noteQuota: null,
};

let active = null;

/* ------------------------------------------------------------------ theme */

export function applyAppearance(settings = {}) {
  const root = document.documentElement;
  const theme = settings.theme || "system";
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.density = settings.density === "compact" ? "compact" : "comfortable";
  root.dataset.animations = settings.animations === "off" ? "off" : "on";
  localStorage.setItem("cadiilac.theme", theme);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((state.profile?.settings?.theme || "system") === "system") applyAppearance(state.profile?.settings);
});

/* ----------------------------------------------------------------- meters */

export async function refreshMeters() {
  try {
    const [credits, storage, quota] = await Promise.all([api.credits(), api.storageUsage(), api.noteQuota()]);
    state.credits = credits;
    state.storage = storage;
    state.noteQuota = quota;
  } catch (error) {
    console.warn("meters", error);
    return;
  }
  renderMeters();
}

function meter(node, { label, value, detail, ratio, warning }) {
  node.innerHTML = "";
  node.append(
    el("div", { class: "meter-row" }, [el("span", { text: label }), el("strong", { style: "font-weight:540", text: value })]),
    el("div", { class: `meter-bar${warning ? " is-warning" : ""}` }, [
      el("span", { style: `width:${Math.min(100, Math.max(2, ratio * 100))}%` }),
    ]),
    el("div", { class: "faint", style: "font-size:11.5px", text: detail })
  );
}

function renderMeters() {
  const { credits, storage, noteQuota } = state;
  if (credits) {
    meter($("#creditMeter"), {
      label: "AI credits",
      value: `${credits.balance} / ${credits.max === Infinity ? "∞" : credits.max}`,
      detail: `+${credits.allowance} in ${formatCountdown(credits.resetsAt)}`,
      ratio: credits.balance / credits.max,
      warning: credits.balance <= Math.max(3, credits.max * 0.08),
    });
  }
  if (storage) {
    const notesLine =
      noteQuota && noteQuota.limit !== Infinity
        ? `${noteQuota.used} / ${noteQuota.limit} notes this week`
        : "Unlimited notes";
    meter($("#storageMeter"), {
      label: "Storage",
      value: `${formatBytes(storage.used)} / ${formatBytes(storage.limit)}`,
      detail: notesLine,
      ratio: storage.used / storage.limit,
      warning: storage.used / storage.limit > 0.9,
    });
  }
}

/* ------------------------------------------------------------------- chrome */

function renderSidebar() {
  for (const [route, config] of Object.entries(ROUTES)) {
    const node = $(`#nav${route[0].toUpperCase()}${route.slice(1)}`);
    node.innerHTML = `${config.icon}<span>${config.label}</span>`;
    node.onclick = () => navigate(route);
  }

  const chip = $("#userChip");
  const name = state.profile?.name || state.user?.email || "Account";
  chip.innerHTML = "";
  chip.append(
    el("div", { class: "avatar", text: name.slice(0, 1).toUpperCase() }),
    el("div", {}, [
      el("strong", { text: name }),
      el("small", { text: state.plan.label }),
    ]),
    el("button", {
      class: "btn btn-icon",
      style: "margin-left:auto",
      title: "Sign out",
      html: ICONS.logout,
      onclick: async (event) => {
        event.stopPropagation();
        await api.signOut();
        location.href = "/";
      },
    })
  );
  chip.onclick = () => navigate("settings");
}

export function navigate(route, params = {}) {
  const query = new URLSearchParams(params).toString();
  location.hash = `#/${route}${query ? `?${query}` : ""}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "notes";
  const [route, query] = raw.split("?");
  return { route: ROUTES[route] ? route : "notes", params: Object.fromEntries(new URLSearchParams(query || "")) };
}

async function renderRoute() {
  const { route, params } = parseHash();
  if (active?.destroy) active.destroy();
  active = null;
  view.innerHTML = "";
  actionsNode.innerHTML = "";
  titleNode.textContent = ROUTES[route].label;

  document.querySelectorAll(".side-link").forEach((node) => node.classList.toggle("is-active", node.dataset.route === route));
  $("#sidebar").classList.remove("is-open");

  const module = await ROUTES[route].load();
  active = (await module.render({ view, actions: actionsNode, params, setTitle: (t) => (titleNode.textContent = t) })) || {};
}

window.addEventListener("hashchange", renderRoute);

$("#menuToggle").addEventListener("click", () => $("#sidebar").classList.toggle("is-open"));

/* --------------------------------------------------------------- bootstrap */

async function boot() {
  const session = await api.getSession();
  if (!session) {
    location.href = "/auth.html?mode=signin";
    return;
  }
  state.user = session.user;
  state.profile = session.profile;
  state.plan = planOf(session.profile?.plan);
  applyAppearance(session.profile?.settings);
  renderSidebar();

  if (isDemo) {
    const banner = $("#demoBanner");
    banner.classList.remove("hidden");
    banner.append(
      el("span", { html: `${ICONS.sparkle}` }),
      el("span", {
        text: "Demo mode — data is stored in this browser and AI responses are generated locally. Add Supabase, OpenRouter and ElevenLabs keys to go live.",
      })
    );
  }

  await refreshMeters();
  await renderRoute();
  setInterval(renderMeters, 30000);
}

export async function reloadProfile() {
  const session = await api.getSession();
  state.profile = session?.profile || state.profile;
  state.plan = planOf(state.profile?.plan);
  applyAppearance(state.profile?.settings);
  renderSidebar();
  await refreshMeters();
}

boot().catch((error) => {
  console.error(error);
  toast(error.message || "Failed to start Cadiilac AI", "error", 8000);
});
