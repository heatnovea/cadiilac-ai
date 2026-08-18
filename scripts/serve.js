/* Minimal static server for local development — no dependencies. */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../public/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function resolve(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let target = join(ROOT, clean);
  try {
    if ((await stat(target)).isDirectory()) target = join(target, "index.html");
    return target;
  } catch {
    return clean === "/" ? join(ROOT, "index.html") : null;
  }
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  const file = await resolve(pathname);

  if (!file) {
    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>404</h1><p>Not found.</p>");
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end("Server error");
  }
}).listen(PORT, () => {
  console.log(`Cadiilac AI running at http://localhost:${PORT}`);
});
