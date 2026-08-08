#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const compiledTestRoot = path.resolve("dist/test");

function collectTests(directory) {
  const tests = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(entryPath);
    }
  }
  return tests;
}

const testFiles = collectTests(compiledTestRoot);
if (testFiles.length === 0) {
  process.stderr.write(`No compiled tests found under ${compiledTestRoot}.\n`);
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=spec", ...testFiles],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    process.stderr.write(`Could not start the Node test runner: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
