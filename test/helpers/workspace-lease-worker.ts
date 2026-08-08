import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

import { createWorkspaceIdentity } from "../../src/contracts/workspace-identity.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
} from "../../src/controller/workspace/index.js";

const [storageRoot, workspaceRoot, runId, leaseId, readyPath, startPath] = process.argv.slice(2);

if (
  storageRoot === undefined ||
  workspaceRoot === undefined ||
  runId === undefined ||
  leaseId === undefined ||
  readyPath === undefined ||
  startPath === undefined
) {
  process.stderr.write("workspace-lease-worker requires storageRoot workspaceRoot runId leaseId readyPath startPath.\n");
  process.exitCode = 2;
} else {
  const workspace = createWorkspaceIdentity(workspaceRoot);
  const guard = FileWorkspaceGuard.open(storageRoot, { leaseIdFactory: () => leaseId });
  if (guard instanceof WorkspaceGuardError) {
    process.stdout.write(`${JSON.stringify({ outcome: "error", code: guard.code })}\n`);
  } else {
    writeFileSync(readyPath, "ready", "utf8");
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(startPath)) {
      Atomics.wait(waitArray, 0, 0, 5);
    }
    const result = guard.acquire(workspace, runId);
    process.stdout.write(
      `${JSON.stringify(
        result instanceof WorkspaceGuardError
          ? { outcome: "error", code: result.code, run_id: runId }
          : {
              outcome: "acquired",
              run_id: runId,
              lease_id: result.lease_id,
              epoch: result.epoch,
            },
      )}\n`,
    );
  }
}
