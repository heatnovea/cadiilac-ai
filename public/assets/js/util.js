/* Small DOM + formatting helpers shared across the app. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function formatRelative(value) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatDate(value);
}

export function formatCountdown(target) {
  const ms = new Date(target).getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function debounce(fn, delay = 300) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function uid(prefix = "id") {
  const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function toast(message, kind = "info", timeout = 3600) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = el("div", { id: "toasts" });
    document.body.append(host);
  }
  const node = el("div", { class: `toast${kind === "error" ? " is-error" : ""}`, role: "status", text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 200);
  }, timeout);
  return node;
}

/** Lightweight promise-based modal. `render(body, close)` fills the dialog. */
export function modal({ title, description, render, actions = [], width }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
    if (width) dialog.style.width = `min(${width}px, 100%)`;

    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };

    if (title) dialog.append(el("h3", { class: "modal-title", text: title }));
    if (description) dialog.append(el("p", { class: "muted", style: "font-size:14px", text: description }));

    const body = el("div", { class: "modal-body" });
    dialog.append(body);
    const api = render ? render(body, close) : null;

    if (actions.length) {
      const row = el("div", { class: "modal-actions" });
      for (const action of actions) {
        row.append(
          el("button", {
            class: `btn ${action.variant ? `btn-${action.variant}` : ""}`.trim(),
            type: "button",
            onclick: () => {
              const value = action.value !== undefined ? action.value : api && api.value ? api.value() : true;
              if (action.validate && !action.validate(value)) return;
              close(action.close === false ? undefined : value);
            },
            text: action.label,
          })
        );
      }
      dialog.append(row);
    }

    backdrop.append(dialog);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    const focusable = dialog.querySelector("input, textarea, select, button");
    if (focusable) focusable.focus();
  });
}

export function confirmDialog(title, description, confirmLabel = "Confirm") {
  return modal({
    title,
    description,
    actions: [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, variant: "primary" },
    ],
  }).then(Boolean);
}

export function promptDialog(title, { label = "Name", value = "", placeholder = "", confirmLabel = "Save" } = {}) {
  let input;
  return modal({
    title,
    render: (body) => {
      input = el("input", { class: "input", value, placeholder });
      body.append(el("label", { class: "field" }, [el("span", { class: "field-label", text: label }), input]));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.target.closest(".modal").querySelector(".modal-actions .btn-primary").click();
      });
      return { value: () => input.value.trim() };
    },
    actions: [
      { label: "Cancel", value: null },
      { label: confirmLabel, variant: "primary", validate: (v) => Boolean(v) },
    ],
  });
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", { value: text, style: "position:fixed;opacity:0" });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function download(filename, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function icon(path, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export const ICONS = {
  notes: icon('<path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M5.5 6h5M5.5 8.6h5M5.5 11.2h3"/>'),
  ai: icon('<path d="M8 2.2 9.5 6 13.3 7.5 9.5 9 8 12.8 6.5 9 2.7 7.5 6.5 6Z"/>'),
  drive: icon('<path d="M2.5 6.2 5 2.8h6l2.5 3.4"/><path d="M2.5 6.2h11v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"/>'),
  settings: icon('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>'),
  plus: icon('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  search: icon('<circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.4 10.4 3 3"/>'),
  trash: icon('<path d="M3 4.2h10M6.4 4.2V3h3.2v1.2M4.4 4.2l.6 8.4h6l.6-8.4"/>'),
  folder: icon('<path d="M2.6 4.4a1 1 0 0 1 1-1h2.6l1.3 1.6h4.9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1Z"/>'),
  file: icon('<path d="M9.2 2.4H5a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.2Z"/><path d="M9.2 2.4v2.8H12"/>'),
  mic: icon('<rect x="6.1" y="2.2" width="3.8" height="7" rx="1.9"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8v2"/>'),
  send: icon('<path d="m2.6 8 10.8-5-4 12-2-4.6Z"/>'),
  close: icon('<path d="m4 4 8 8M12 4l-8 8"/>'),
  check: icon('<path d="m3.4 8.4 3.1 3.1L12.6 5"/>'),
  chevron: icon('<path d="m6 4 4 4-4 4"/>'),
  sparkle: icon('<path d="M8 2.4 9.2 5.8 12.6 7 9.2 8.2 8 11.6 6.8 8.2 3.4 7 6.8 5.8Z"/><path d="M12.2 10.6v2.2M11.1 11.7h2.2"/>'),
  timer: icon('<circle cx="8" cy="9" r="5"/><path d="M8 6.4V9l1.8 1.2M6.4 2.4h3.2"/>'),
  download: icon('<path d="M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8M3 12.8h10"/>'),
  share: icon('<circle cx="11.6" cy="4" r="1.8"/><circle cx="4.4" cy="8" r="1.8"/><circle cx="11.6" cy="12" r="1.8"/><path d="m6 7.1 4-2.2M6 8.9l4 2.2"/>'),
  logout: icon('<path d="M6 13.4H3.6a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1H6"/><path d="M9.8 10.8 12.6 8 9.8 5.2M12.6 8H6"/>'),
};
