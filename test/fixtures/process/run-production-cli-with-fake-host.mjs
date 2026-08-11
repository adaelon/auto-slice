#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runControllerCli } from "../../../dist/src/controller/main.js";
import { CodexAppServerTaskHost } from "../../../dist/src/controller/production/index.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-codex-app-server.mjs",
);
const io = {
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
};

process.exitCode = await runControllerCli(
  ["run-plan", ...process.argv.slice(2)],
  io,
  () => new CodexAppServerTaskHost({
    command: process.execPath,
    args: [fixturePath, "production-write"],
    request_timeout_ms: 10_000,
  }),
);
