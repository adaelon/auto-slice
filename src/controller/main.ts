#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContractLoadError, loadFrozenContracts } from "../contracts/index.js";
import {
  CONTROL_COMMANDS,
  ControlPlaneError,
  openFileControlPlane,
} from "./control-plane/index.js";
import {
  RUN_PLAN_USAGE,
  runProductionPlanCommand,
  type ProductionTaskHostFactory,
} from "./production/index.js";

export interface ControllerIo {
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
}

const DEFAULT_IO: ControllerIo = {
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
};

const CONTROL_COMMAND_SET = new Set<string>(CONTROL_COMMANDS);
const USAGE = `Usage: auto-slice-controller inspect-contracts [workspace_root] | <start|status|pause|resume|abort|override> <request_json_path> [storage_root]\n${RUN_PLAN_USAGE}`;

export function runController(argv: readonly string[], io: ControllerIo = DEFAULT_IO): number {
  const [command, requestedRoot] = argv;
  if (command === "--help" || command === "-h") {
    io.writeStdout(USAGE);
    return 0;
  }
  if (command === "inspect-contracts" && argv.length <= 2) {
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
  if (
    typeof command !== "string" ||
    !CONTROL_COMMAND_SET.has(command) ||
    requestedRoot === undefined ||
    argv.length > 3
  ) {
    io.writeStderr(USAGE);
    return 2;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(path.resolve(requestedRoot), "utf8")) as unknown;
  } catch {
    io.writeStderr(JSON.stringify({
      status: "COMMAND_REJECTED",
      error: { code: "invalid_command_envelope" },
    }));
    return 1;
  }
  const storageRoot = argv[2] === undefined
    ? path.join(process.cwd(), ".auto-slice")
    : path.resolve(argv[2]);
  const controlPlane = openFileControlPlane(storageRoot);
  if (controlPlane instanceof ControlPlaneError) {
    io.writeStderr(JSON.stringify({ status: "COMMAND_REJECTED", error: controlPlane.toJSON() }));
    return 1;
  }
  const result = controlPlane.execute(command, envelope);
  if (result instanceof ControlPlaneError) {
    io.writeStderr(JSON.stringify({ status: "COMMAND_REJECTED", error: result.toJSON() }));
    return 1;
  }
  io.writeStdout(JSON.stringify(result, null, 2));
  return result.outcome === "REJECTED" ? 1 : 0;
}

export async function runControllerCli(
  argv: readonly string[],
  io: ControllerIo = DEFAULT_IO,
  createProductionTaskHost?: ProductionTaskHostFactory,
): Promise<number> {
  if (argv[0] !== "run-plan") {
    return runController(argv, io);
  }
  return createProductionTaskHost === undefined
    ? await runProductionPlanCommand(argv.slice(1), io)
    : await runProductionPlanCommand(argv.slice(1), io, createProductionTaskHost);
}

function canonicalExecutablePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isControllerEntryPath(
  entryPath: string | undefined,
  modulePath: string,
): boolean {
  return entryPath !== undefined
    && canonicalExecutablePath(entryPath) === canonicalExecutablePath(modulePath);
}

const entryPath = process.argv[1];
if (isControllerEntryPath(entryPath, fileURLToPath(import.meta.url))) {
  void runControllerCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      DEFAULT_IO.writeStderr(JSON.stringify({
        status: "PRODUCTION_RUN_FAILED",
        error: { code: "production_run_invalid" },
      }));
      process.exitCode = 1;
    },
  );
}
