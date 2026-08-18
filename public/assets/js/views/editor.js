/* Note editor: typed document layer + drawing canvas + contextual AI tools. */

import { el, $, toast, debounce, modal, promptDialog, confirmDialog, ICONS, formatRelative } from "../util.js";
import { api } from "../api.js";
import { state, navigate, refreshMeters } from "../app.js";
import { exportNote, htmlToText } from "../export.js";
import { openStudySession } from "./study.js";

const PAGE_SIZES = {
  letter: { label: "Letter", width: 816, height: 1056 },
  a4: { label: "A4", width: 794, height: 1123 },
  wide: { label: "Wide", width: 1000, height: 1200 },
  square: { label: "Square", width: 900, height: 900 },
};

const FONTS = ["Inter", "Newsreader", "Lora", "Source Serif 4", "JetBrains Mono", "Georgia", "Helvetica"];

const AI_ACTIONS = [
  { group: "Write", items: [
    { tool: "rewrite", label: "Rewrite with AI" },
    { tool: "expand", label: "Expand" },
    { tool: "concise", label: "Make concise" },
    { tool: "grammar", label: "Fix grammar" },
    { tool: "continue", label: "Continue writing" },
    { tool: "tone", label: "Change tone…", needsTone: true },
  ] },
  { group: "Understand", items: [
    { tool: "summarize", label: "Summarize with AI" },
    { tool: "explain", label: "Explain" },
    { tool: "simplify", label: "Simplify" },
  ] },
  { group: "Study", items: [
    { tool: "study-notes", label: "Turn into study notes" },
    { tool: "flashcards", label: "Create flashcards" },
    { tool: "quiz", label: "Create quiz" },
    { tool: "questions", label: "Generate questions" },
  ] },
];

const defaultStyle = () => ({
  font: "Inter",
  size: 16,
  color: "#111113",
  highlight: "#ffe066",
  pageColor: "#ffffff",
  lineHeight: 1.65,
  margin: 64,
  align: "left",
  pageSize: "letter",
  penColor: "#1c4ed8",
  penSize: 2.5,
  highlighterSize: 16,
});

export async function renderEditor({ view, actions, params, setTitle }) {
  const notes = await api.listNotes();
  const note = notes.find((item) => item.id === params.id);
  if (!note) {
    toast("That note no longer exists.", "error");
    navigate("notes");
    return {};
  }

  const style = { ...defaultStyle(), ...(note.style || {}) };
  let strokes = Array.isArray(note.strokes) ? note.strokes.slice() : [];
  let tool = "text";
  let zoom = 1;
  let dirty = false;
  let history = [{ content: note.content || "", strokes: JSON.stringify(strokes) }];
  let historyIndex = 0;

  setTitle(note.title || "Untitled note");

  /* ------------------------------------------------------------ structure */

  const root = el("div", { class: "editor" });
  const toolbar = el("div", { class: "toolbar" });
  const stage = el("div", { class: "canvas-stage" });
  const page = el("div", { class: "page" });
  const surface = el("div", { class: "page-surface" });
  const doc = el("div", {
    class: "doc",
    id: "doc",
    contenteditable: "true",
    spellcheck: "true",
    "data-placeholder": "Start writing, or pick the pen to hand-write…",
  });
  const canvas = el("canvas", { id: "docCanvas", class: "is-idle" });
  const status = el("div", { class: "editor-status" });

  doc.innerHTML = note.content || "";
  surface.append(canvas, doc);
  page.append(surface);
  stage.append(page);
  root.append(toolbar, stage, status);
  view.append(root);

  const ctx = canvas.getContext("2d");

  function applyStyle() {
    const size = PAGE_SIZES[style.pageSize] || PAGE_SIZES.letter;
    page.style.setProperty("--page-width", `${size.width}px`);
    page.style.setProperty("--page-min-height", `${size.height}px`);
    page.style.setProperty("--page-color", style.pageColor);
    doc.style.setProperty("--doc-font", `"${style.font}"`);
    doc.style.setProperty("--doc-size", `${style.size}px`);
    doc.style.setProperty("--doc-color", style.color);
    doc.style.setProperty("--doc-line", style.lineHeight);
    doc.style.setProperty("--doc-margin", `${style.margin}px`);
    doc.style.setProperty("--doc-align", style.align);
    page.style.transform = `scale(${zoom})`;
    page.style.marginBottom = `${(zoom - 1) * (size.height || 0)}px`;
    resizeCanvas();
  }

  function resizeCanvas() {
    const size = PAGE_SIZES[style.pageSize] || PAGE_SIZES.letter;
    const height = Math.max(size.height, doc.scrollHeight);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }

  function drawStroke(stroke) {
    const points = stroke.points;
    if (!points.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.globalAlpha = stroke.tool === "highlighter" ? 0.34 : 1;
    ctx.beginPath();
    if (stroke.tool === "rect") {
      const [start, end] = [points[0], points[points.length - 1]];
      ctx.rect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
    } else if (stroke.tool === "ellipse") {
      const [start, end] = [points[0], points[points.length - 1]];
      ctx.ellipse((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, Math.abs(end[0] - start[0]) / 2, Math.abs(end[1] - start[1]) / 2, 0, 0, Math.PI * 2);
    } else if (stroke.tool === "line") {
      ctx.moveTo(points[0][0], points[0][1]);
      ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
    } else {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i += 1) {
        const previous = points[i - 1];
        const point = points[i];
        ctx.quadraticCurveTo(previous[0], previous[1], (previous[0] + point[0]) / 2, (previous[1] + point[1]) / 2);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(drawStroke);
  }

  /* -------------------------------------------------------------- drawing */

  let current = null;

  const pointFromEvent = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * canvas.width / (window.devicePixelRatio || 1), ((event.clientY - rect.top) / rect.height) * canvas.height / (window.devicePixelRatio || 1)];
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (tool === "text") return;
    canvas.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (tool === "eraser") {
      eraseAt(point);
      current = { erasing: true };
      return;
    }
    current = {
      tool,
      color: tool === "highlighter" ? style.highlight : style.penColor,
      size: tool === "highlighter" ? style.highlighterSize : style.penSize,
      points: [point],
    };
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    const point = pointFromEvent(event);
    if (current.erasing) return eraseAt(point);
    if (["rect", "ellipse", "line"].includes(current.tool)) {
      current.points = [current.points[0], point];
      redraw();
      drawStroke(current);
      return;
    }
    current.points.push(point);
    redraw();
    drawStroke(current);
  });

  const endStroke = () => {
    if (!current) return;
    if (!current.erasing && current.points.length > 1) {
      strokes.push(current);
      pushHistory();
      queueSave();
    }
    current = null;
    redraw();
  };

  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointerleave", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  function eraseAt(point) {
    const before = strokes.length;
    strokes = strokes.filter((stroke) => !stroke.points.some(([x, y]) => Math.hypot(x - point[0], y - point[1]) < Math.max(10, stroke.size)));
    if (strokes.length !== before) {
      redraw();
      pushHistory();
      queueSave();
    }
  }

  /* --------------------------------------------------------------- saving */

  const queueSave = debounce(save, 900);

  async function save() {
    if (!dirtyState()) return;
    setStatus("Saving…");
    try {
      await api.updateNote(note.id, {
        title: note.title,
        content: doc.innerHTML,
        strokes,
        style,
      });
      note.content = doc.innerHTML;
      note.strokes = strokes;
      note.style = style;
      note.updated_at = new Date().toISOString();
      dirty = false;
      setStatus(`Saved ${formatRelative(note.updated_at)}`);
    } catch (error) {
      setStatus("Save failed");
      toast(error.message, "error");
    }
  }

  const dirtyState = () => dirty || doc.innerHTML !== note.content || JSON.stringify(strokes) !== JSON.stringify(note.strokes || []);

  function setStatus(text) {
    statusText.textContent = text;
  }

  function pushHistory() {
    const snapshot = { content: doc.innerHTML, strokes: JSON.stringify(strokes) };
    const top = history[historyIndex];
    if (top && top.content === snapshot.content && top.strokes === snapshot.strokes) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot);
    if (history.length > 80) history.shift();
    historyIndex = history.length - 1;
  }

  function restore(index) {
    const snapshot = history[index];
    if (!snapshot) return;
    historyIndex = index;
    doc.innerHTML = snapshot.content;
    strokes = JSON.parse(snapshot.strokes);
    redraw();
    dirty = true;
    queueSave();
  }

  const pushHistoryDebounced = debounce(pushHistory, 600);

  doc.addEventListener("input", () => {
    dirty = true;
    setStatus("Unsaved changes");
    pushHistoryDebounced();
    queueSave();
    resizeCanvas();
  });

  doc.addEventListener("paste", (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const image = items.find((item) => item.type.startsWith("image/"));
    if (image) {
      event.preventDefault();
      const reader = new FileReader();
      reader.onload = () => exec("insertHTML", `<img src="${reader.result}" alt="pasted image" />`);
      reader.readAsDataURL(image.getAsFile());
    }
  });

  /* ------------------------------------------------------------ formatting */

  function exec(command, value = null) {
    doc.focus();
    document.execCommand(command, false, value);
    dirty = true;
    pushHistory();
    queueSave();
  }

  function toolbarButton({ label, iconHtml, onClick, active: isActive, title }) {
    return el("button", {
      class: `btn btn-icon${isActive ? " is-active" : ""}`,
      title: title || label,
      "aria-label": title || label,
      html: iconHtml || `<span style="font-size:13px">${label}</span>`,
      onclick: onClick,
    });
  }

  function select(options, value, onChange, width = "auto") {
    const node = el("select", { class: "tool-select", style: `width:${width}` });
    for (const option of options) {
      node.append(el("option", { value: String(option.value), text: option.label, ...(String(option.value) === String(value) ? { selected: true } : {}) }));
    }
    node.onchange = () => onChange(node.value);
    return node;
  }

  function renderToolbar() {
    toolbar.innerHTML = "";

    toolbar.append(
      toolbarButton({ label: "Back", iconHtml: ICONS.chevron.replace('d="m6 4 4 4-4 4"', 'd="m10 4-4 4 4 4"'), title: "All notes", onClick: () => navigate("notes") }),
      el("input", {
        class: "input",
        style: "width:210px;height:30px;border-color:transparent;background:transparent;font-weight:540",
        value: note.title || "",
        placeholder: "Untitled note",
        oninput: (event) => {
          note.title = event.target.value;
          setTitle(note.title || "Untitled note");
          dirty = true;
          queueSave();
        },
      }),
      el("div", { class: "toolbar-sep" })
    );

    toolbar.append(
      toolbarButton({ label: "Undo", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h7a3 3 0 0 1 0 6H7"/><path d="M5.6 4.4 3 7l2.6 2.6"/></svg>', title: "Undo", onClick: () => restore(historyIndex - 1) }),
      toolbarButton({ label: "Redo", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 7H6a3 3 0 0 0 0 6h3"/><path d="M10.4 4.4 13 7l-2.6 2.6"/></svg>', title: "Redo", onClick: () => restore(historyIndex + 1) }),
      el("div", { class: "toolbar-sep" })
    );

    toolbar.append(
      select(FONTS.map((font) => ({ value: font, label: font })), style.font, (value) => {
        style.font = value;
        applyStyle();
        queueSave();
      }, "130px"),
      select([12, 13, 14, 15, 16, 18, 20, 24, 30].map((size) => ({ value: size, label: `${size}px` })), style.size, (value) => {
        style.size = Number(value);
        applyStyle();
        queueSave();
      }, "76px"),
      select([
        { value: "p", label: "Body" },
        { value: "h1", label: "Heading 1" },
        { value: "h2", label: "Heading 2" },
        { value: "h3", label: "Heading 3" },
      ], "p", (value) => exec("formatBlock", value), "108px")
    );

    toolbar.append(
      toolbarButton({ label: "B", title: "Bold (Ctrl+B)", iconHtml: '<span style="font-weight:700;font-size:13px">B</span>', onClick: () => exec("bold") }),
      toolbarButton({ label: "I", title: "Italic (Ctrl+I)", iconHtml: '<span style="font-style:italic;font-size:13px">I</span>', onClick: () => exec("italic") }),
      toolbarButton({ label: "U", title: "Underline (Ctrl+U)", iconHtml: '<span style="text-decoration:underline;font-size:13px">U</span>', onClick: () => exec("underline") })
    );

    const textColor = el("input", { type: "color", class: "color-swatch", value: style.color, title: "Text colour" });
    textColor.oninput = () => exec("foreColor", textColor.value);
    const highlightColor = el("input", { type: "color", class: "color-swatch", value: style.highlight, title: "Highlight colour" });
    highlightColor.oninput = () => {
      style.highlight = highlightColor.value;
      exec("hiliteColor", highlightColor.value);
    };
    toolbar.append(textColor, highlightColor, el("div", { class: "toolbar-sep" }));

    toolbar.append(
      toolbarButton({ label: "•", title: "Bulleted list", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="3.4" cy="4.6" r=".9" fill="currentColor"/><circle cx="3.4" cy="8" r=".9" fill="currentColor"/><circle cx="3.4" cy="11.4" r=".9" fill="currentColor"/><path d="M6.4 4.6h6.4M6.4 8h6.4M6.4 11.4h6.4"/></svg>', onClick: () => exec("insertUnorderedList") }),
      toolbarButton({ label: "1.", title: "Numbered list", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.4 4.6h6.4M6.4 8h6.4M6.4 11.4h6.4M2.6 3.6h.9v2.2M2.4 9.4h1.4l-1.4 2h1.4"/></svg>', onClick: () => exec("insertOrderedList") }),
      toolbarButton({ label: "☑", title: "Checklist item", iconHtml: ICONS.check, onClick: insertChecklistItem }),
      toolbarButton({ label: "Link", title: "Insert link", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.8.8"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.8-.8"/></svg>', onClick: insertLink }),
      toolbarButton({ label: "Image", title: "Insert image", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6"/><circle cx="6" cy="6.6" r="1"/><path d="m3.4 11.4 3-2.8 2.4 2 2-1.6 2.8 2.4"/></svg>', onClick: insertImage }),
      select([
        { value: "left", label: "Left" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" },
        { value: "justify", label: "Justify" },
      ], style.align, (value) => {
        style.align = value;
        exec(`justify${value[0].toUpperCase()}${value.slice(1)}`);
        applyStyle();
      }, "84px"),
      el("div", { class: "toolbar-sep" })
    );

    const tools = [
      { id: "text", label: "Text", iconHtml: '<span style="font-size:13px">T</span>' },
      { id: "pen", label: "Pen", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.4 1.9 14 4.5l-8.3 8.3-3.2.6.6-3.2z"/></svg>' },
      { id: "highlighter", label: "Highlighter", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 10.6 9.6 5l2.4 2.4-5.6 5.6H4z"/><path d="M2.6 14.2h10.8"/></svg>' },
      { id: "line", label: "Line", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 12 10-8"/></svg>' },
      { id: "rect", label: "Rectangle", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="10" height="8" rx="1.4"/></svg>' },
      { id: "ellipse", label: "Ellipse", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="8" cy="8" rx="5.4" ry="4.2"/></svg>' },
      { id: "eraser", label: "Eraser", iconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m7.4 12.6-4-4 5-5 4 4-3 3z"/><path d="M4 12.6h8.4"/></svg>' },
    ];

    for (const item of tools) {
      toolbar.append(
        toolbarButton({
          label: item.label,
          title: item.label,
          iconHtml: item.iconHtml,
          active: tool === item.id,
          onClick: () => {
            tool = item.id;
            canvas.classList.toggle("is-idle", tool === "text");
            renderToolbar();
          },
        })
      );
    }

    const penColor = el("input", { type: "color", class: "color-swatch", value: style.penColor, title: "Pen colour" });
    penColor.oninput = () => {
      style.penColor = penColor.value;
      queueSave();
    };
    toolbar.append(
      penColor,
      select([1, 1.5, 2.5, 4, 6, 9].map((size) => ({ value: size, label: `${size}px` })), style.penSize, (value) => {
        style.penSize = Number(value);
        queueSave();
      }, "72px"),
      select([10, 16, 22, 30].map((size) => ({ value: size, label: `Hl ${size}` })), style.highlighterSize, (value) => {
        style.highlighterSize = Number(value);
        queueSave();
      }, "78px"),
      el("div", { class: "toolbar-sep" }),
      toolbarButton({ label: "Page", title: "Page and document settings", iconHtml: ICONS.settings, onClick: openPageSettings }),
      toolbarButton({ label: "Find", title: "Find in document", iconHtml: ICONS.search, onClick: findInDocument }),
      select([0.75, 0.9, 1, 1.25, 1.5].map((value) => ({ value, label: `${Math.round(value * 100)}%` })), zoom, (value) => {
        zoom = Number(value);
        applyStyle();
      }, "80px")
    );
  }

  function insertChecklistItem() {
    exec(
      "insertHTML",
      '<div class="checklist-item"><input type="checkbox" /><span>New task</span></div>'
    );
  }

  async function insertLink() {
    const url = await promptDialog("Insert link", { label: "URL", placeholder: "https://", confirmLabel: "Insert" });
    if (url) exec("createLink", url);
  }

  function insertImage() {
    const input = el("input", { type: "file", accept: "image/*", class: "hidden" });
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => exec("insertHTML", `<img src="${reader.result}" alt="${file.name}" />`);
      reader.readAsDataURL(file);
    };
    document.body.append(input);
    input.click();
    input.remove();
  }

  async function openPageSettings() {
    await modal({
      title: "Document settings",
      width: 520,
      render: (body) => {
        const row = (label, node) => body.append(el("label", { class: "field" }, [el("span", { class: "field-label", text: label }), node]));
        const pageColor = el("input", { type: "color", class: "color-swatch", style: "width:100%;height:38px", value: style.pageColor });
        pageColor.oninput = () => {
          style.pageColor = pageColor.value;
          applyStyle();
          queueSave();
        };
        row("Page colour", pageColor);

        const textColor = el("input", { type: "color", class: "color-swatch", style: "width:100%;height:38px", value: style.color });
        textColor.oninput = () => {
          style.color = textColor.value;
          applyStyle();
          queueSave();
        };
        row("Default text colour", textColor);

        const size = el("select", { class: "select" });
        for (const [id, config] of Object.entries(PAGE_SIZES)) {
          size.append(el("option", { value: id, text: `${config.label} · ${config.width}×${config.height}`, ...(style.pageSize === id ? { selected: true } : {}) }));
        }
        size.onchange = () => {
          style.pageSize = size.value;
          applyStyle();
          queueSave();
        };
        row("Page size", size);

        const spacing = el("input", { class: "input", type: "range", min: "1.2", max: "2.4", step: "0.05", value: String(style.lineHeight) });
        spacing.oninput = () => {
          style.lineHeight = Number(spacing.value);
          applyStyle();
          queueSave();
        };
        row("Line spacing", spacing);

        const margin = el("input", { class: "input", type: "range", min: "24", max: "120", step: "4", value: String(style.margin) });
        margin.oninput = () => {
          style.margin = Number(margin.value);
          applyStyle();
          queueSave();
        };
        row("Margins", margin);
        return {};
      },
      actions: [{ label: "Done", variant: "primary", value: true }],
    });
  }

  async function findInDocument() {
    const term = await promptDialog("Find in document", { label: "Search for", confirmLabel: "Find" });
    if (!term) return;
    const found = window.find ? window.find(term, false, false, true) : false;
    if (!found) {
      const hits = (htmlToText(doc.innerHTML).match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
      toast(hits ? `${hits} match${hits === 1 ? "" : "es"} in this document.` : "No matches found.", hits ? "info" : "error");
    }
  }

  /* -------------------------------------------------------------- ai tools */

  let menuNode = null;

  function closeMenu() {
    menuNode?.remove();
    menuNode = null;
  }

  document.addEventListener("click", (event) => {
    if (menuNode && !menuNode.contains(event.target)) closeMenu();
  });

  function openAiMenu(x, y) {
    closeMenu();
    const selection = String(window.getSelection() || "").trim();
    menuNode = el("div", { class: "context-menu" });
    menuNode.append(
      el("div", { class: "group-label", text: selection ? `Selection · ${selection.length} chars` : "Whole document" })
    );
    for (const group of AI_ACTIONS) {
      menuNode.append(el("div", { class: "group-label", text: group.group }));
      for (const item of group.items) {
        menuNode.append(
          el("button", { type: "button", html: `${ICONS.sparkle}<span>${item.label}</span>`, onclick: () => runAiAction(item, selection) })
        );
      }
    }
    menuNode.append(
      el("div", { class: "group-label", text: "Session" }),
      el("button", { type: "button", html: `${ICONS.timer}<span>Start focused study session</span>`, onclick: () => {
        closeMenu();
        openStudySession({ ...note, content: doc.innerHTML });
      } })
    );
    document.body.append(menuNode);
    const rect = menuNode.getBoundingClientRect();
    menuNode.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
    menuNode.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`;
  }

  doc.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openAiMenu(event.clientX, event.clientY);
  });

  async function runAiAction(action, selection) {
    closeMenu();
    let tone = null;
    if (action.needsTone) {
      tone = await promptDialog("Change tone", { label: "Desired tone", placeholder: "e.g. academic, friendly, concise", confirmLabel: "Rewrite" });
      if (!tone) return;
    }
    const text = selection || htmlToText(doc.innerHTML).slice(0, 6000);
    if (!text.trim()) return toast("Write something first, or select the text you want to work on.", "error");

    const panel = openAiPanel(action.label);
    try {
      const result = await api.tool({
        tool: action.tool,
        text,
        tone,
        title: note.title,
        context: selection ? htmlToText(doc.innerHTML).slice(0, 3000) : null,
      });
      await refreshMeters();
      panel.setContent(result.content, { hasSelection: Boolean(selection) });
    } catch (error) {
      panel.setError(error.message);
    }
  }

  function openAiPanel(title) {
    $(".ai-panel")?.remove();
    const bodyNode = el("div", { class: "body" }, [el("div", { class: "row", style: "gap:9px" }, [el("span", { class: "spinner" }), el("span", { class: "muted", text: "Cadiilac AI is working…" })])]);
    const footer = el("footer");
    const panel = el("div", { class: "ai-panel" }, [
      el("header", {}, [
        el("span", { html: ICONS.sparkle }),
        el("span", { text: title }),
        el("button", { class: "btn btn-icon", style: "margin-left:auto", html: ICONS.close, onclick: () => panel.remove() }),
      ]),
      bodyNode,
      footer,
    ]);
    document.body.append(panel);

    return {
      setError(message) {
        bodyNode.innerHTML = "";
        bodyNode.append(el("span", { style: "color:var(--danger)", text: message }));
      },
      setContent(content, { hasSelection }) {
        bodyNode.textContent = content;
        footer.innerHTML = "";
        footer.append(
          el("button", {
            class: "btn btn-sm btn-primary",
            text: hasSelection ? "Replace selection" : "Insert at cursor",
            onclick: () => {
              doc.focus();
              exec("insertHTML", content.replace(/\n/g, "<br />"));
              panel.remove();
            },
          }),
          el("button", {
            class: "btn btn-sm",
            text: "Append to note",
            onclick: () => {
              doc.innerHTML += `<p>${content.replace(/\n/g, "<br />")}</p>`;
              dirty = true;
              pushHistory();
              queueSave();
              panel.remove();
            },
          }),
          el("button", {
            class: "btn btn-sm",
            text: "Copy",
            onclick: async () => {
              await navigator.clipboard.writeText(content);
              toast("Copied to clipboard.");
            },
          })
        );
      },
    };
  }

  /* --------------------------------------------------------- top bar tools */

  const statusText = el("span", { text: `Saved ${formatRelative(note.updated_at)}` });
  status.append(
    statusText,
    el("span", { class: "faint", id: "wordCount" }),
    el("span", { class: "faint", style: "margin-left:auto", text: state.plan.features.backups ? "Cloud backups on" : "Free plan — upgrade for version history" })
  );

  const updateWordCount = () => {
    const words = htmlToText(doc.innerHTML).split(/\s+/).filter(Boolean).length;
    $("#wordCount", status).textContent = `${words} word${words === 1 ? "" : "s"} · ${strokes.length} strokes`;
  };
  doc.addEventListener("input", updateWordCount);

  actions.append(
    el("button", { class: "btn btn-sm", html: `${ICONS.sparkle}<span>AI tools</span>`, onclick: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      openAiMenu(rect.left - 60, rect.bottom + 6);
    } }),
    el("button", { class: "btn btn-sm", html: `${ICONS.timer}<span>Study</span>`, onclick: () => openStudySession({ ...note, content: doc.innerHTML }) }),
    el("button", { class: "btn btn-sm", html: `${ICONS.download}<span>Export</span>`, onclick: openExport }),
    state.plan.features.backups
      ? el("button", { class: "btn btn-sm", text: "History", onclick: openHistory })
      : null,
    el("button", { class: "btn btn-sm btn-danger", html: ICONS.trash, title: "Delete note", onclick: async () => {
      if (!(await confirmDialog("Delete note?", "This permanently removes the document and its drawings.", "Delete"))) return;
      await api.deleteNote(note.id);
      toast("Note deleted.");
      navigate("notes");
    } })
  );

  async function openExport() {
    const format = await modal({
      title: "Export note",
      description: "Drawings are flattened into the exported page.",
      render: (body) => {
        let picked = "pdf";
        const group = el("div", { class: "row" });
        for (const option of [
          { id: "pdf", label: "PDF" },
          { id: "html", label: "HTML" },
          { id: "md", label: "Markdown" },
          { id: "txt", label: "Plain text" },
        ]) {
          const button = el("button", { class: `btn${option.id === picked ? " btn-primary" : ""}`, text: option.label });
          button.onclick = () => {
            picked = option.id;
            group.querySelectorAll(".btn").forEach((node) => node.classList.remove("btn-primary"));
            button.classList.add("btn-primary");
          };
          group.append(button);
        }
        body.append(group);
        return { value: () => picked };
      },
      actions: [
        { label: "Cancel", value: null },
        { label: "Export", variant: "primary" },
      ],
    });
    if (!format) return;
    exportNote({ ...note, content: doc.innerHTML, style }, format, strokes.length ? canvas.toDataURL("image/png") : null);
  }

  async function openHistory() {
    const versions = await api.listVersions(note.id);
    await modal({
      title: "Version history",
      description: versions.length ? "Restore any earlier revision of this document." : "No earlier versions yet — they are captured as you edit.",
      render: (body) => {
        for (const version of versions) {
          body.append(
            el("div", { class: "kv" }, [
              el("span", { text: formatRelative(version.created_at) }),
              el("button", {
                class: "btn btn-sm",
                text: "Restore",
                onclick: () => {
                  doc.innerHTML = version.content;
                  dirty = true;
                  pushHistory();
                  queueSave();
                  toast("Version restored.");
                  body.closest(".modal-backdrop").remove();
                },
              }),
            ])
          );
        }
        return {};
      },
      actions: [{ label: "Close", value: null }],
    });
  }

  /* --------------------------------------------------------------- wiring */

  const onKey = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "s") {
      event.preventDefault();
      queueSave.flush();
    }
    if (event.key === "z" && !event.shiftKey) {
      event.preventDefault();
      restore(historyIndex - 1);
    }
    if ((event.key === "z" && event.shiftKey) || event.key === "y") {
      event.preventDefault();
      restore(historyIndex + 1);
    }
    if (event.key === "f") {
      event.preventDefault();
      findInDocument();
    }
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", resizeCanvas);

  renderToolbar();
  applyStyle();
  updateWordCount();

  return {
    destroy() {
      queueSave.flush();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resizeCanvas);
      closeMenu();
      $(".ai-panel")?.remove();
    },
  };
}
