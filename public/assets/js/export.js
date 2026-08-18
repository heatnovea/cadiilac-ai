/* Note export: PDF (via print), HTML, Markdown and plain text. */

import { download } from "./util.js";

const safeName = (title) => (title || "Untitled note").replace(/[^\w\-. ]+/g, "").trim() || "note";

function documentStyles(style = {}) {
  return `
    :root { color-scheme: light; }
    body {
      margin: 0;
      background: ${style.pageColor || "#ffffff"};
      color: ${style.color || "#111113"};
      font-family: ${style.font || "Inter"}, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: ${style.size || 16}px;
      line-height: ${style.lineHeight || 1.65};
      text-align: ${style.align || "left"};
    }
    .page { position: relative; padding: ${style.margin || 64}px; max-width: ${style.pageWidth || 816}px; margin: 0 auto; }
    .strokes { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    img { max-width: 100%; }
    mark { padding: 0 2px; border-radius: 3px; }
    .checklist-item { display: flex; gap: 9px; align-items: flex-start; }
    @media print { body { background: #fff; } .page { box-shadow: none; } }
  `;
}

export function buildHtml(note, strokesDataUrl) {
  const style = note.style || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeText(note.title || "Untitled note")}</title>
<style>${documentStyles(style)}</style>
</head>
<body>
<div class="page">
${strokesDataUrl ? `<img class="strokes" src="${strokesDataUrl}" alt="" />` : ""}
<div class="content">${note.content || ""}</div>
</div>
</body>
</html>`;
}

function escapeText(value = "") {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function htmlToMarkdown(html = "") {
  const root = document.createElement("div");
  root.innerHTML = html;

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const inner = Array.from(node.childNodes).map(walk).join("");
    switch (node.tagName) {
      case "H1":
        return `\n# ${inner}\n\n`;
      case "H2":
        return `\n## ${inner}\n\n`;
      case "H3":
        return `\n### ${inner}\n\n`;
      case "B":
      case "STRONG":
        return `**${inner}**`;
      case "I":
      case "EM":
        return `*${inner}*`;
      case "U":
        return `_${inner}_`;
      case "MARK":
        return `==${inner}==`;
      case "CODE":
        return `\`${inner}\``;
      case "A":
        return `[${inner}](${node.getAttribute("href") || ""})`;
      case "IMG":
        return `![${node.getAttribute("alt") || "image"}](${node.getAttribute("src") || ""})`;
      case "LI":
        return `- ${inner}\n`;
      case "OL":
      case "UL":
        return `\n${inner}\n`;
      case "BR":
        return "\n";
      case "DIV":
      case "P":
        if (node.classList.contains("checklist-item")) {
          const checked = node.querySelector("input")?.checked;
          return `- [${checked ? "x" : " "}] ${inner.trim()}\n`;
        }
        return `${inner}\n\n`;
      default:
        return inner;
    }
  };

  return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html = "") {
  const root = document.createElement("div");
  root.innerHTML = html.replace(/<(br|\/p|\/div|\/h[1-6]|\/li)>/gi, "\n$&");
  return root.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

export function exportNote(note, format, strokesDataUrl) {
  const name = safeName(note.title);
  if (format === "html") return download(`${name}.html`, buildHtml(note, strokesDataUrl), "text/html");
  if (format === "md") return download(`${name}.md`, `# ${note.title || "Untitled note"}\n\n${htmlToMarkdown(note.content)}\n`, "text/markdown");
  if (format === "txt") return download(`${name}.txt`, `${note.title || "Untitled note"}\n\n${htmlToText(note.content)}\n`, "text/plain");
  if (format === "pdf") {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(buildHtml(note, strokesDataUrl));
    doc.close();
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 1500);
    };
    return undefined;
  }
  return undefined;
}
