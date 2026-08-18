/* Notes library: grid of documents, search, sort and creation. */

import { el, toast, ICONS, formatRelative, confirmDialog } from "../util.js";
import { api } from "../api.js";
import { state, navigate, refreshMeters } from "../app.js";
import { htmlToText } from "../export.js";
import { renderEditor } from "./editor.js";

export async function render(ctx) {
  if (ctx.params.id) return renderEditor(ctx);

  const { view, actions } = ctx;
  let notes = await api.listNotes();
  let query = "";
  let sort = "updated";

  const grid = el("div", { class: "note-grid" });
  const pad = el("div", { class: "view-pad" });

  const quotaLine = el("p", { class: "muted", style: "font-size:13.5px;margin-top:6px" });
  const head = el("div", {}, [
    el("h2", { style: "font-size:22px;letter-spacing:-.025em", text: "Your notes" }),
    quotaLine,
  ]);

  const controls = el("div", { class: "drive-toolbar", style: "margin-top:18px" });
  const search = el("input", { placeholder: "Search notes", value: query });
  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    paint();
  };
  const sortSelect = el("select", { class: "select", style: "width:auto" });
  for (const option of [
    { value: "updated", label: "Last edited" },
    { value: "created", label: "Date created" },
    { value: "title", label: "Title" },
  ]) {
    sortSelect.append(el("option", { value: option.value, text: option.label }));
  }
  sortSelect.onchange = () => {
    sort = sortSelect.value;
    paint();
  };
  controls.append(el("div", { class: "searchbox" }, [el("span", { html: ICONS.search }), search]), sortSelect);

  pad.append(head, controls, grid);
  view.append(pad);

  function updateQuotaLine() {
    const quota = state.noteQuota;
    if (!quota) return;
    quotaLine.textContent =
      quota.limit === Infinity
        ? `${notes.length} documents · unlimited notes on Cadiilac Cloud`
        : `${quota.used} / ${quota.limit} notes created this week · resets ${formatRelative(quota.resetsAt).replace("ago", "")}`.trim();
  }

  function paint() {
    updateQuotaLine();
    const filtered = notes
      .filter((note) => {
        if (!query) return true;
        return `${note.title || ""} ${htmlToText(note.content || "")}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (sort === "title") return (a.title || "").localeCompare(b.title || "");
        if (sort === "created") return new Date(b.created_at) - new Date(a.created_at);
        return new Date(b.updated_at) - new Date(a.updated_at);
      });

    grid.innerHTML = "";
    if (!filtered.length) {
      grid.append(
        el("div", { class: "empty", style: "grid-column:1/-1" }, [
          el("h3", { text: notes.length ? "No notes match that search" : "Your workspace is empty" }),
          el("p", { text: notes.length ? "Try a different term." : "Create your first document to start writing, drawing and studying with Cadiilac AI." }),
          notes.length ? null : el("button", { class: "btn btn-primary", html: `${ICONS.plus}<span>New note</span>`, onclick: createNote }),
        ])
      );
      return;
    }

    for (const note of filtered) {
      const card = el("div", { class: "note-card", onclick: () => navigate("notes", { id: note.id }) }, [
        el("h3", { text: note.title || "Untitled note" }),
        el("div", { class: "excerpt", text: htmlToText(note.content || "").slice(0, 220) || "Empty document" }),
        el("footer", {}, [
          el("span", { text: formatRelative(note.updated_at) }),
          Array.isArray(note.strokes) && note.strokes.length ? el("span", { class: "badge", text: "Ink" }) : null,
          el("div", { class: "card-actions" }, [
            el("button", {
              class: "btn btn-icon",
              title: "Delete",
              html: ICONS.trash,
              onclick: async (event) => {
                event.stopPropagation();
                if (!(await confirmDialog("Delete note?", `“${note.title || "Untitled note"}” will be removed permanently.`, "Delete"))) return;
                await api.deleteNote(note.id);
                notes = notes.filter((item) => item.id !== note.id);
                await refreshMeters();
                paint();
                toast("Note deleted.");
              },
            }),
          ]),
        ]),
      ]);
      grid.append(card);
    }
  }

  async function createNote() {
    try {
      const note = await api.createNote({
        title: "Untitled note",
        content: "",
        strokes: [],
        style: {},
      });
      await refreshMeters();
      navigate("notes", { id: note.id });
    } catch (error) {
      if (error.code === "note_limit") {
        toast(error.message, "error", 6000);
        navigate("settings", { section: "subscription" });
        return;
      }
      toast(error.message, "error");
    }
  }

  actions.append(el("button", { class: "btn btn-sm btn-primary", html: `${ICONS.plus}<span>New note</span>`, onclick: createNote }));

  paint();
  return {};
}
