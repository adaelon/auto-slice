#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContractLoadError, loadFrozenContracts } from "../contracts/index.js";

export interface ControllerIo {
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
}

const DEFAULT_IO: ControllerIo = {
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = "Usage: auto-slice-controller inspect-contracts [workspace_root]";

export function runController(argv: readonly string[], io: ControllerIo = DEFAULT_IO): number {
  const [command, requestedRoot] = argv;
  if (command === "--help" || command === "-h") {
    io.writeStdout(USAGE);
    return 0;
  }
  if (command !== "inspect-contracts" || argv.length > 2) {
    io.writeStderr(USAGE);
    return 2;
  }

  const workspaceRoot = requestedRoot === undefined ? process.cwd() : requestedRoot;
  const result = loadFrozenContracts(workspaceRoot);
  if (result instanceof ContractLoadError) {
    io.writeStderr(
      JSON.stringify({
        status: "CONTRACT_LOAD_FAILED",
        error: result.toJSON(),
      }),
    );
    return 1;
  }

  io.writeStdout(
    JSON.stringify(
      {
        status: "CONTRACTS_LOADED",
        contracts: result,
      },
      null,
      2,
    ),
  );
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = runController(process.argv.slice(2));
}
