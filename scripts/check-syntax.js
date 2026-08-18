/* Parses every browser module so syntax errors fail fast, with no toolchain. */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import vm from "node:vm";

const ROOTS = [new URL("../public/assets/js/", import.meta.url).pathname, new URL("./", import.meta.url).pathname];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (extname(entry.name) === ".js") files.push(path);
  }
  return files;
}

let failed = 0;
for (const root of ROOTS) {
  for (const file of await walk(root)) {
    const source = await readFile(file, "utf8");
    try {
      new vm.SourceTextModule(source, { identifier: file });
    } catch (error) {
      failed += 1;
      console.error(`✗ ${file}\n  ${error.message}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed to parse.`);
  process.exit(1);
}
console.log("All modules parsed successfully.");
