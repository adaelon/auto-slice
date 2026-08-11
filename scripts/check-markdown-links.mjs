#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const roots = [path.join(repoRoot, "README.md"), path.join(repoRoot, "docs")];
const linkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/gu;

function collectMarkdown(candidate) {
  if (!existsSync(candidate)) return [];
  if (statSync(candidate).isFile()) return candidate.endsWith(".md") ? [candidate] : [];
  return readdirSync(candidate, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => collectMarkdown(path.join(candidate, entry.name)));
}

function decodeTarget(value) {
  const withoutTitle = value.trim().replace(/^<|>$/gu, "").split(/\s+["']/u, 1)[0] ?? "";
  const [pathname] = withoutTitle.split("#", 1);
  return decodeURIComponent(pathname ?? "");
}

const failures = [];
const checkedFiles = roots.flatMap(collectMarkdown);
let checkedLinks = 0;
for (const file of checkedFiles) {
  const markdown = readFileSync(file, "utf8");
  for (const match of markdown.matchAll(linkPattern)) {
    const raw = match[1] ?? "";
    if (/^(?:https?:|mailto:|#)/iu.test(raw)) continue;
    const target = decodeTarget(raw);
    if (target.length === 0) continue;
    checkedLinks += 1;
    const resolved = path.resolve(path.dirname(file), target.replaceAll("/", path.sep));
    if (!existsSync(resolved)) {
      failures.push({
        source: path.relative(repoRoot, file).replaceAll(path.sep, "/"),
        target: raw,
      });
    }
  }
}

const report = {
  schema_version: 1,
  markdown_files: checkedFiles.length,
  relative_links: checkedLinks,
  failures,
  result: failures.length === 0 ? "PASS" : "FAIL",
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (failures.length > 0) process.exitCode = 1;
