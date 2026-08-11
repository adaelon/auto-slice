import { CodexAppServerTaskHost } from "./codex-app-server-task-host.js";
import { ProductionPlanError, ProductionRuntimeError } from "./errors.js";
import {
  runProductionPlanFile,
  type ProductionTaskHostPorts,
} from "./file-production-runtime.js";

export interface ProductionCommandIo {
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
}

export type ProductionTaskHostFactory = () => ProductionTaskHostPorts;

export const RUN_PLAN_USAGE =
  "Usage: auto-slice-controller run-plan <plan_json_path> <workspace_root> [storage_root]";

function unexpectedFailure(error: unknown): ProductionRuntimeError {
  return new ProductionRuntimeError(
    "production_run_invalid",
    "Production CLI composition failed outside its deterministic error boundary.",
    { cause: error },
  );
}

export async function runProductionPlanCommand(
  argv: readonly string[],
  io: ProductionCommandIo,
  createTaskHost: ProductionTaskHostFactory = () => new CodexAppServerTaskHost(),
): Promise<number> {
  const [planPath, workspaceRoot, storageRoot] = argv;
  if (
    planPath === undefined ||
    planPath.trim().length === 0 ||
    workspaceRoot === undefined ||
    workspaceRoot.trim().length === 0 ||
    argv.length > 3
  ) {
    io.writeStderr(RUN_PLAN_USAGE);
    return 2;
  }

  let taskHost: ProductionTaskHostPorts;
  try {
    taskHost = createTaskHost();
  } catch (error: unknown) {
    io.writeStderr(JSON.stringify({
      status: "PRODUCTION_RUN_FAILED",
      error: unexpectedFailure(error).toJSON(),
    }));
    return 1;
  }

  let result;
  try {
    result = await runProductionPlanFile({
      plan_path: planPath,
      workspace_root: workspaceRoot,
      ...(storageRoot === undefined ? {} : { storage_root: storageRoot }),
      task_host: taskHost,
    });
  } catch (error: unknown) {
    result = unexpectedFailure(error);
    try {
      await taskHost.dispose();
    } catch {
      // Preserve the primary deterministic failure below.
    }
  }

  if (result instanceof ProductionPlanError || result instanceof ProductionRuntimeError) {
    io.writeStderr(JSON.stringify({
      status: "PRODUCTION_RUN_FAILED",
      error: result.toJSON(),
    }));
    return 1;
  }

  io.writeStdout(JSON.stringify({
    status: result.decision.outcome === "DONE"
      ? "PRODUCTION_RUN_COMPLETED"
      : "PRODUCTION_CONTINUATION_STARTED",
    workspace_identity: result.workspace_identity,
    storage_root: result.storage_root,
    decision: result.decision,
  }, null, 2));
  return 0;
}
