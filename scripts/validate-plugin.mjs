#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const requestedRoot = process.argv[2] ?? ".";
const pluginRoot = path.resolve(requestedRoot);
const configuredCodexHome = process.env.CODEX_HOME?.trim();
const codexHome = configuredCodexHome ? path.resolve(configuredCodexHome) : path.join(homedir(), ".codex");
const validatorPath = path.join(
  codexHome,
  "skills",
  ".system",
  "plugin-creator",
  "scripts",
  "validate_plugin.py",
);

if (!existsSync(validatorPath)) {
  process.stderr.write(`Official plugin validator not found: ${validatorPath}\n`);
  process.exitCode = 2;
} else {
  const configuredPython = process.env.PYTHON?.trim();
  const python = configuredPython || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, [validatorPath, pluginRoot], {
    cwd: pluginRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error !== undefined) {
    process.stderr.write(`Could not run the official plugin validator: ${result.error.message}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = result.status ?? 2;
  }
}
