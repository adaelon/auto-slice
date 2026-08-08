import { spawnSync } from "node:child_process";

import type {
  GitCommandOptions,
  GitCommandPort,
  GitCommandResult,
} from "./types.js";

const MAXIMUM_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export class GitProcessRunner implements GitCommandPort {
  public run(
    workspaceRoot: string,
    args: readonly string[],
    options: GitCommandOptions = {},
  ): GitCommandResult {
    const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ...options.extra_environment,
      },
      maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
    return {
      exit_code: result.status,
      stdout,
      stderr,
      failure_message: result.error?.message ?? null,
    };
  }
}
