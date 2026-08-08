#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);

function required(index, label) {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

switch (mode) {
  case "success":
    process.stdout.write("check-ok\n");
    process.stderr.write("check-note\n");
    break;
  case "claim-pass-nonzero":
    process.stdout.write("LLM says every check passed.\n");
    process.stderr.write("deterministic runner disagrees.\n");
    process.exitCode = 7;
    break;
  case "hang":
    setInterval(() => undefined, 1_000);
    break;
  case "output":
    process.stdout.write("x".repeat(Number(required(0, "output byte count"))));
    setInterval(() => undefined, 1_000);
    break;
  case "write-file": {
    const target = path.resolve(required(0, "target path"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, required(1, "file contents"), "utf8");
    break;
  }
  case "capture-env": {
    const target = path.resolve(required(0, "target path"));
    const allowedName = required(1, "allowed environment name");
    const forbiddenName = required(2, "forbidden environment name");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({
      allowed: process.env[allowedName] ?? null,
      forbidden: process.env[forbiddenName] ?? null,
    })}\n`, "utf8");
    break;
  }
  case "tree-parent": {
    const marker = path.resolve(required(0, "marker path"));
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "delayed-write", marker],
      { detached: false, stdio: "ignore", windowsHide: true },
    ).unref();
    setInterval(() => undefined, 1_000);
    break;
  }
  case "delayed-write": {
    const marker = path.resolve(required(0, "marker path"));
    setTimeout(() => {
      mkdirSync(path.dirname(marker), { recursive: true });
      writeFileSync(marker, "orphan-survived\n", "utf8");
    }, 650);
    break;
  }
  default:
    throw new Error(`Unknown fixture mode: ${String(mode)}.`);
}
