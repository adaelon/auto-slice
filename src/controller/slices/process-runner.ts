import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import type { Sha256Digest } from "../state/index.js";
import { SliceExecutionError } from "./errors.js";
import { resolveWorkspaceDirectory } from "./path-utils.js";
import type { CheckExecutionReceipt, CheckProcessOutcome, CheckSpec } from "./types.js";

const DEFAULT_MAXIMUM_OUTPUT_BYTES = 1024 * 1024;

export interface CheckProcessRunnerOptions {
  readonly maximumOutputBytes?: number;
}

function resolveEnvironment(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const availableNames = Object.keys(process.env);
  for (const requestedName of allowlist) {
    const actualName = availableNames.find(
      (candidate) => candidate.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US"),
    );
    if (actualName !== undefined) {
      const value = process.env[actualName];
      if (value !== undefined) {
        environment[actualName] = value;
      }
    }
  }
  return environment;
}

function resolveExecutable(argv: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("Cannot execute an empty argv array.");
  }
  if (command === "npm" || command === "npm.cmd") {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    const npmCli = candidates.find((candidate) => existsSync(candidate));
    if (npmCli === undefined) {
      throw new Error("npm-cli.js could not be located without a command shell.");
    }
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command, args };
}

function digest(hash: ReturnType<typeof createHash>): Sha256Digest {
  return `sha256:${hash.digest("hex")}`;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): boolean {
  const processId = child.pid;
  let treeTerminationSucceeded = false;
  if (processId !== undefined) {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      treeTerminationSucceeded = result.error === undefined && result.status === 0;
    } else {
      try {
        process.kill(-processId, "SIGKILL");
        treeTerminationSucceeded = true;
      } catch {
        // The process may have exited between the limit/timeout and the kill.
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // A completed process needs no further termination.
  }
  return treeTerminationSucceeded;
}

export class CheckProcessRunner {
  private readonly maximumOutputBytes: number;

  public constructor(options: CheckProcessRunnerOptions = {}) {
    const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
      throw new TypeError("maximumOutputBytes must be a positive integer.");
    }
    this.maximumOutputBytes = maximumOutputBytes;
  }

  public async run(check: CheckSpec, workspace: WorkspaceIdentity): Promise<CheckExecutionReceipt> {
    const startedAt = process.hrtime.bigint();
    const resolvedCwd = resolveWorkspaceDirectory(workspace, check.cwd);
    if (resolvedCwd instanceof SliceExecutionError) {
      return this.immediateFailure(check, startedAt, "CHECK_PATH_OUTSIDE_WORKSPACE", resolvedCwd.message);
    }
    let executable: ReturnType<typeof resolveExecutable>;
    try {
      executable = resolveExecutable(check.argv);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.immediateFailure(check, startedAt, "CHECK_SPAWN_FAILED", message);
    }

    return await new Promise<CheckExecutionReceipt>((resolve) => {
      const stdoutHash = createHash("sha256");
      const stderrHash = createHash("sha256");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let processTreeTerminated = false;
      let failureDetail: string | null = null;
      let settled = false;
      let child: ChildProcessWithoutNullStreams;

      let timeout: NodeJS.Timeout | null = null;
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        let outcome: CheckProcessOutcome;
        if (outputLimitExceeded) {
          outcome = "CHECK_OUTPUT_LIMIT_EXCEEDED";
        } else if (timedOut) {
          outcome = "CHECK_TIMEOUT";
        } else if (failureDetail !== null) {
          outcome = "CHECK_SPAWN_FAILED";
        } else if (exitCode !== check.expected_exit_code) {
          outcome = "CHECK_NONZERO_EXIT";
        } else {
          outcome = "PASS";
        }
        resolve({
          check_id: check.id,
          argv: check.argv,
          cwd: check.cwd,
          expected_exit_code: check.expected_exit_code,
          exit_code: exitCode,
          signal,
          outcome,
          stdout_digest: digest(stdoutHash),
          stderr_digest: digest(stderrHash),
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
          timed_out: timedOut,
          output_limit_exceeded: outputLimitExceeded,
          process_tree_terminated: processTreeTerminated,
          failure_detail: failureDetail,
        });
      };

      try {
        child = spawn(executable.command, [...executable.args], {
          cwd: resolvedCwd,
          detached: process.platform !== "win32",
          env: resolveEnvironment(check.env_allowlist),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        child.stdin.end();
      } catch (error: unknown) {
        failureDetail = error instanceof Error ? error.message : String(error);
        finish(null, null);
        return;
      }

      const observeOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        if (stream === "stdout") {
          stdoutHash.update(chunk);
          stdoutBytes += chunk.length;
        } else {
          stderrHash.update(chunk);
          stderrBytes += chunk.length;
        }
        if (
          !outputLimitExceeded &&
          (stdoutBytes > this.maximumOutputBytes || stderrBytes > this.maximumOutputBytes)
        ) {
          outputLimitExceeded = true;
          failureDetail = `${stream} exceeded ${String(this.maximumOutputBytes)} bytes.`;
          processTreeTerminated = terminateProcessTree(child);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        observeOutput("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        observeOutput("stderr", chunk);
      });
      child.on("error", (error) => {
        failureDetail = error.message;
      });
      child.on("close", (code, signal) => {
        finish(code, signal);
      });
      timeout = setTimeout(() => {
        if (!settled && !outputLimitExceeded) {
          timedOut = true;
          failureDetail = `Check exceeded timeout ${String(check.timeout_ms)} ms.`;
          processTreeTerminated = terminateProcessTree(child);
        }
      }, check.timeout_ms);
    });
  }

  private immediateFailure(
    check: CheckSpec,
    startedAt: bigint,
    outcome: "CHECK_PATH_OUTSIDE_WORKSPACE" | "CHECK_SPAWN_FAILED",
    failureDetail: string,
  ): CheckExecutionReceipt {
    const emptyDigest: Sha256Digest = `sha256:${createHash("sha256").digest("hex")}`;
    return {
      check_id: check.id,
      argv: check.argv,
      cwd: check.cwd,
      expected_exit_code: check.expected_exit_code,
      exit_code: null,
      signal: null,
      outcome,
      stdout_digest: emptyDigest,
      stderr_digest: emptyDigest,
      stdout_bytes: 0,
      stderr_bytes: 0,
      duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      timed_out: false,
      output_limit_exceeded: false,
      process_tree_terminated: false,
      failure_detail: failureDetail,
    };
  }
}
