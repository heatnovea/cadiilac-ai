/* Public share page: resolves a share token without requiring an account. */

import { el, $, formatBytes, formatDate, toast, ICONS, download } from "./util.js";
import { api } from "./api.js";

const root = $("#share-root");
const token = new URLSearchParams(location.search).get("t");

function empty(title, message) {
  root.innerHTML = "";
  root.append(el("div", { class: "empty" }, [el("h3", { text: title }), el("p", { text: message })]));
}

function preview(file, url) {
  const mime = file.mime || "";
  if (!url) return el("p", { class: "muted", text: "Preview unavailable — download the file to open it." });
  if (mime.startsWith("image/")) return el("img", { src: url, alt: file.name });
  if (mime.startsWith("video/")) return el("video", { src: url, controls: true });
  if (mime.startsWith("audio/")) return el("audio", { src: url, controls: true, style: "width:100%;padding:28px" });
  if (mime === "application/pdf") return el("iframe", { src: url, title: file.name, style: "height:70vh" });
  if (mime.startsWith("text/") || mime === "application/json") {
    const pre = el("pre", { text: "Loading preview…" });
    fetch(url)
      .then((response) => response.text())
      .then((text) => {
        pre.textContent = text.slice(0, 200000);
      })
      .catch(() => {
        pre.textContent = "Preview unavailable.";
      });
    return pre;
  }
  return el("div", { class: "empty" }, [el("h3", { text: "No inline preview" }), el("p", { text: "This file type can only be downloaded." })]);
}

async function main() {
  if (!token) return empty("Missing share link", "This URL does not contain a share token.");

  let result = null;
  try {
    result = await api.resolveShare(token);
  } catch (error) {
    return empty("Could not open this file", error.message);
  }
  if (!result) return empty("Link unavailable", "This share link has been revoked, or the file no longer exists.");

  const { share, file, url, owner } = result;
  const card = el("div", { class: "share-card" });

  card.append(
    el("header", {}, [
      el("span", { html: ICONS.file }),
      el("div", {}, [
        el("strong", { style: "display:block;font-weight:560", text: file.name }),
        el("span", { class: "faint", style: "font-size:13px", text: `Shared by ${owner || "a Cadiilac user"}` }),
      ]),
      share.allow_download
        ? el("button", {
            class: "btn btn-sm btn-primary",
            style: "margin-left:auto",
            html: `${ICONS.download}<span>Download</span>`,
            onclick: async () => {
              try {
                const response = await fetch(url);
                download(file.name, await response.blob(), file.mime);
              } catch {
                toast("Download failed.", "error");
              }
            },
          })
        : el("span", { class: "badge", style: "margin-left:auto", text: "View only" }),
    ]),
    el("div", { class: "share-preview" }, [preview(file, url)]),
    el("div", { class: "share-meta" }, [
      el("span", { text: formatBytes(file.size) }),
      el("span", { text: file.mime || "unknown type" }),
      el("span", { text: `Shared ${formatDate(share.created_at)}` }),
    ])
  );

  root.innerHTML = "";
  root.append(card);
}

main();
