#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runControllerCli } from "../../../dist/src/controller/main.js";
import { CodexAppServerTaskHost } from "../../../dist/src/controller/production/index.js";

const scenario = process.argv[2];
if (scenario !== "production-firewall-short" && scenario !== "production-firewall-large") {
  process.stderr.write("S14 production runner requires a frozen firewall scenario.\n");
  process.exitCode = 64;
} else {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fake-codex-app-server.mjs",
  );
  const io = {
    writeStdout: (line) => process.stdout.write(`${line}\n`),
    writeStderr: (line) => process.stderr.write(`${line}\n`),
  };

  process.exitCode = await runControllerCli(
    ["run-plan", ...process.argv.slice(3)],
    io,
    () => new CodexAppServerTaskHost({
      command: process.execPath,
      args: [fixturePath, scenario],
      request_timeout_ms: 10_000,
    }),
  );
}
