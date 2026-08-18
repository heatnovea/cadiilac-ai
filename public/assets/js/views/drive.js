/* Drive: folders, uploads of any file type, sharing and quota display. */

import { el, toast, ICONS, formatBytes, formatDate, modal, promptDialog, confirmDialog, copyToClipboard, download } from "../util.js";
import { api } from "../api.js";
import { state, refreshMeters } from "../app.js";

export async function render({ view, actions }) {
  let folderId = null;
  let folders = await api.listFolders();
  let files = [];
  let shares = await api.listShares();
  let query = "";
  let sort = { key: "created_at", dir: -1 };

  const pad = el("div", { class: "view-pad" });
  const breadcrumb = el("div", { class: "breadcrumb" });
  const dropzone = el("div", { class: "dropzone", text: "Drop files here, or use Upload. Every file type is accepted." });
  const table = el("table", { class: "files" });
  const usageLine = el("p", { class: "muted", style: "font-size:13.5px;margin-top:6px" });

  const search = el("input", { placeholder: "Search this folder" });
  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    paint();
  };

  const toolbar = el("div", { class: "drive-toolbar", style: "margin-top:18px" }, [
    breadcrumb,
    el("div", { style: "margin-left:auto;display:flex;gap:8px;flex-wrap:wrap" }, [
      el("div", { class: "searchbox" }, [el("span", { html: ICONS.search }), search]),
      el("button", { class: "btn btn-sm", html: `${ICONS.folder}<span>New folder</span>`, onclick: createFolder }),
      el("button", { class: "btn btn-sm btn-primary", html: `${ICONS.plus}<span>Upload</span>`, onclick: pickFiles }),
    ]),
  ]);

  pad.append(
    el("div", {}, [el("h2", { style: "font-size:22px;letter-spacing:-.025em", text: "Drive" }), usageLine]),
    toolbar,
    dropzone,
    table
  );
  view.append(pad);

  /* ------------------------------------------------------------- painting */

  function updateUsage() {
    const storage = state.storage;
    if (!storage) return;
    usageLine.textContent = `${formatBytes(storage.used)} of ${formatBytes(storage.limit)} used · ${state.plan.label}`;
  }

  function paintBreadcrumb() {
    breadcrumb.innerHTML = "";
    breadcrumb.append(
      el("button", { html: `${ICONS.drive}<span style="margin-left:6px">My Drive</span>`, onclick: () => open(null) })
    );
    if (folderId) {
      const folder = folders.find((item) => item.id === folderId);
      breadcrumb.append(el("span", { class: "faint", html: ICONS.chevron }), el("button", { text: folder?.name || "Folder" }));
    }
  }

  function sortRows(rows) {
    return rows.sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const comparison =
        typeof left === "string" ? left.localeCompare(right) : Number(new Date(left)) - Number(new Date(right)) || left - right;
      return comparison * sort.dir;
    });
  }

  async function paint() {
    updateUsage();
    paintBreadcrumb();
    files = await api.listFiles(folderId);
    const visibleFolders = folderId ? [] : folders.filter((folder) => !query || folder.name.toLowerCase().includes(query));
    const visibleFiles = sortRows(files.filter((file) => !query || file.name.toLowerCase().includes(query)));

    table.innerHTML = "";
    const header = el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Name", onclick: () => setSort("name") }),
        el("th", { text: "Size", onclick: () => setSort("size") }),
        el("th", { text: "Type" }),
        el("th", { text: "Modified", onclick: () => setSort("created_at") }),
        el("th", { text: "" }),
      ]),
    ]);
    const body = el("tbody");
    table.append(header, body);

    if (!visibleFolders.length && !visibleFiles.length) {
      body.append(
        el("tr", {}, [
          el("td", { colspan: "5" }, [
            el("div", { class: "empty" }, [
              el("h3", { text: query ? "Nothing matches that search" : "This folder is empty" }),
              el("p", { text: "Upload files of any type — documents, audio, video, archives, datasets." }),
            ]),
          ]),
        ])
      );
      return;
    }

    for (const folder of visibleFolders) {
      body.append(
        el("tr", { ondblclick: () => open(folder.id), onclick: () => open(folder.id) }, [
          el("td", {}, [el("div", { class: "file-name" }, [el("span", { html: ICONS.folder }), el("span", { text: folder.name })])]),
          el("td", { class: "faint", text: "—" }),
          el("td", { class: "faint", text: "Folder" }),
          el("td", { class: "faint", text: formatDate(folder.created_at) }),
          el("td", {}, [
            el("div", { class: "row-actions" }, [
              el("button", { class: "btn btn-icon", title: "Rename", text: "✎", onclick: async (event) => {
                event.stopPropagation();
                const name = await promptDialog("Rename folder", { value: folder.name });
                if (!name) return;
                await api.renameFolder(folder.id, name);
                folders = await api.listFolders();
                paint();
              } }),
              el("button", { class: "btn btn-icon", title: "Delete", html: ICONS.trash, onclick: async (event) => {
                event.stopPropagation();
                if (!(await confirmDialog("Delete folder?", "Files inside this folder are deleted too.", "Delete"))) return;
                await api.deleteFolder(folder.id);
                folders = await api.listFolders();
                await refreshMeters();
                paint();
              } }),
            ]),
          ]),
        ])
      );
    }

    for (const file of visibleFiles) {
      const share = shares.find((item) => item.file_id === file.id && item.access === "link");
      body.append(
        el("tr", { onclick: () => openDetails(file) }, [
          el("td", {}, [
            el("div", { class: "file-name" }, [
              el("span", { html: ICONS.file }),
              el("span", { text: file.name }),
              share ? el("span", { class: "badge badge-accent", text: "Shared" }) : null,
            ]),
          ]),
          el("td", { class: "faint", text: formatBytes(file.size) }),
          el("td", { class: "faint", text: (file.mime || "").split("/").pop() || "file" }),
          el("td", { class: "faint", text: formatDate(file.created_at) }),
          el("td", {}, [
            el("div", { class: "row-actions" }, [
              el("button", { class: "btn btn-icon", title: "Download", html: ICONS.download, onclick: (event) => {
                event.stopPropagation();
                downloadFile(file);
              } }),
              el("button", { class: "btn btn-icon", title: "Share", html: ICONS.share, onclick: (event) => {
                event.stopPropagation();
                openShare(file);
              } }),
              el("button", { class: "btn btn-icon", title: "Delete", html: ICONS.trash, onclick: async (event) => {
                event.stopPropagation();
                if (!(await confirmDialog("Delete file?", `“${file.name}” will be permanently removed.`, "Delete"))) return;
                await api.deleteFile(file.id);
                await refreshMeters();
                paint();
                toast("File deleted.");
              } }),
            ]),
          ]),
        ])
      );
    }
  }

  function setSort(key) {
    sort = { key, dir: sort.key === key ? -sort.dir : -1 };
    paint();
  }

  function open(id) {
    folderId = id;
    paint();
  }

  /* -------------------------------------------------------------- actions */

  async function createFolder() {
    const name = await promptDialog("New folder", { placeholder: "Semester 2", confirmLabel: "Create" });
    if (!name) return;
    await api.createFolder(name, null);
    folders = await api.listFolders();
    paint();
  }

  function pickFiles() {
    const input = el("input", { type: "file", multiple: true, class: "hidden" });
    input.onchange = () => uploadAll(Array.from(input.files || []));
    document.body.append(input);
    input.click();
    input.remove();
  }

  async function uploadAll(list) {
    if (!list.length) return;
    const tray = el("div", { class: "upload-tray" }, [el("header", { text: `Uploading ${list.length} file${list.length === 1 ? "" : "s"}` })]);
    document.body.append(tray);

    for (const file of list) {
      const bar = el("span", { style: "width:2%" });
      const item = el("div", { class: "upload-item" }, [
        el("div", { class: "meter-row" }, [el("span", { text: file.name }), el("span", { class: "faint", text: formatBytes(file.size) })]),
        el("div", { class: "meter-bar" }, [bar]),
      ]);
      tray.append(item);
      try {
        await api.uploadFile(file, folderId, (percent) => {
          bar.style.width = `${percent}%`;
        });
      } catch (error) {
        item.append(el("span", { style: "color:var(--danger)", text: error.message }));
        toast(error.message, "error", 6000);
      }
    }

    await refreshMeters();
    await paint();
    setTimeout(() => tray.remove(), 1200);
  }

  async function downloadFile(file) {
    try {
      const blob = await api.fileBlob(file.id);
      if (blob) return download(file.name, blob, file.mime);
      const url = await api.fileUrl(file.id);
      window.open(url, "_blank", "noopener");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function openDetails(file) {
    await modal({
      title: file.name,
      width: 520,
      render: (body) => {
        const share = shares.find((item) => item.file_id === file.id);
        body.append(
          el("div", { class: "panel-block" }, [
            el("div", { class: "kv" }, [el("span", { text: "Size" }), el("span", { text: formatBytes(file.size) })]),
            el("div", { class: "kv" }, [el("span", { text: "Type" }), el("span", { text: file.mime || "unknown" })]),
            el("div", { class: "kv" }, [el("span", { text: "Uploaded" }), el("span", { text: formatDate(file.created_at) })]),
            el("div", { class: "kv" }, [
              el("span", { text: "Sharing" }),
              el("span", { text: share?.access === "link" ? `Anyone with the link · ${share.allow_download ? "download enabled" : "view only"}` : "Private" }),
            ]),
          ]),
          el("div", { class: "row" }, [
            el("button", { class: "btn btn-sm", html: `${ICONS.download}<span>Download</span>`, onclick: () => downloadFile(file) }),
            el("button", { class: "btn btn-sm", html: `${ICONS.share}<span>Share</span>`, onclick: () => {
              body.closest(".modal-backdrop").remove();
              openShare(file);
            } }),
            el("button", { class: "btn btn-sm", text: "Rename", onclick: async () => {
              const name = await promptDialog("Rename file", { value: file.name });
              if (!name) return;
              await api.renameFile(file.id, name);
              body.closest(".modal-backdrop").remove();
              paint();
            } }),
            el("button", { class: "btn btn-sm", text: "Move", onclick: async () => {
              const target = await pickFolder();
              if (target === undefined) return;
              await api.moveFile(file.id, target);
              body.closest(".modal-backdrop").remove();
              paint();
              toast("File moved.");
            } }),
          ])
        );
        return {};
      },
      actions: [{ label: "Close", value: null }],
    });
  }

  function pickFolder() {
    return modal({
      title: "Move to folder",
      render: (body) => {
        const select = el("select", { class: "select" });
        select.append(el("option", { value: "", text: "My Drive (root)" }));
        for (const folder of folders) select.append(el("option", { value: folder.id, text: folder.name }));
        body.append(select);
        return { value: () => select.value || null };
      },
      actions: [
        { label: "Cancel", value: undefined },
        { label: "Move", variant: "primary" },
      ],
    });
  }

  async function openShare(file) {
    const existing = shares.find((item) => item.file_id === file.id);
    await modal({
      title: `Share “${file.name}”`,
      width: 540,
      render: (body) => {
        let access = existing?.access || "private";
        let allowDownload = existing?.allow_download ?? true;

        const linkRow = el("div", { class: "row hidden" });
        const linkInput = el("input", { class: "input mono", readonly: true, value: "" });
        linkRow.append(
          linkInput,
          el("button", { class: "btn btn-sm", text: "Copy", onclick: async () => {
            await copyToClipboard(linkInput.value);
            toast("Share link copied.");
          } })
        );

        const downloadToggle = el("label", { class: "row", style: "gap:8px;font-size:14px" }, [
          el("input", { type: "checkbox", ...(allowDownload ? { checked: true } : {}) }),
          el("span", { text: "Allow downloads (otherwise the file is view only)" }),
        ]);
        downloadToggle.querySelector("input").onchange = (event) => {
          allowDownload = event.target.checked;
          apply();
        };

        const segmented = el("div", { class: "segmented" });
        for (const option of [
          { id: "private", label: "Private" },
          { id: "link", label: "Anyone with link" },
        ]) {
          segmented.append(
            el("button", {
              class: access === option.id ? "is-active" : "",
              text: option.label,
              onclick: () => {
                access = option.id;
                segmented.querySelectorAll("button").forEach((node) => node.classList.remove("is-active"));
                segmented.querySelectorAll("button").forEach((node) => {
                  if (node.textContent === option.label) node.classList.add("is-active");
                });
                apply();
              },
            })
          );
        }

        async function apply() {
          const share = await api.createShare(file.id, { access, allow_download: allowDownload });
          shares = await api.listShares();
          const url = `${location.origin}/share.html?t=${share.token}`;
          linkInput.value = url;
          linkRow.classList.toggle("hidden", access !== "link");
        }

        body.append(segmented, downloadToggle, linkRow);
        if (existing) apply();
        return {};
      },
      actions: [{ label: "Done", variant: "primary", value: true }],
    });
    shares = await api.listShares();
    paint();
  }

  /* ------------------------------------------------------------ drag drop */

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      stop(event);
      dropzone.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      stop(event);
      dropzone.classList.remove("is-over");
    })
  );
  dropzone.addEventListener("drop", (event) => uploadAll(Array.from(event.dataTransfer?.files || [])));
  dropzone.addEventListener("click", pickFiles);

  actions.append(el("button", { class: "btn btn-sm btn-primary", html: `${ICONS.plus}<span>Upload</span>`, onclick: pickFiles }));

  await paint();
  return {};
}
