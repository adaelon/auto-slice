import type { ContinuationLauncher } from "../continuation/index.js";
import type { CompressionTaskLauncher } from "../handoff/index.js";
import { CodexAppServerDevelopmentTask } from "./codex-app-server-development-task.js";
import type { CodexAppServerDevelopmentTaskOptions } from "./codex-app-server-development-task.js";
import { ProductionRuntimeError } from "./errors.js";
import type { ProductionTaskHostPorts } from "./file-production-runtime.js";

function unavailableHandoff(): ProductionRuntimeError {
  return new ProductionRuntimeError(
    "handoff_export_failed",
    "This App Server composition has no production Compression Task launcher configured.",
  );
}

function unavailableContinuation(): ProductionRuntimeError {
  return new ProductionRuntimeError(
    "continuation_start_failed",
    "This App Server composition has no production Continuation Task launcher configured.",
  );
}

const FAIL_CLOSED_COMPRESSION_LAUNCHER: CompressionTaskLauncher = {
  start: () => Promise.reject(unavailableHandoff()),
  awaitHandoff: () => Promise.reject(unavailableHandoff()),
};

const FAIL_CLOSED_CONTINUATION_LAUNCHER: ContinuationLauncher = {
  start: () => Promise.reject(unavailableContinuation()),
  awaitReady: () => Promise.reject(unavailableContinuation()),
  grantWrite: () => Promise.reject(unavailableContinuation()),
  awaitProgress: () => Promise.reject(unavailableContinuation()),
};

export interface CodexAppServerTaskHostOptions extends CodexAppServerDevelopmentTaskOptions {
  readonly compression_launcher?: CompressionTaskLauncher;
  readonly continuation_launcher?: ContinuationLauncher;
}

export class CodexAppServerTaskHost implements ProductionTaskHostPorts {
  private readonly developmentTask: CodexAppServerDevelopmentTask;

  public readonly development_tasks: CodexAppServerDevelopmentTask;
  public readonly thread_control: CodexAppServerDevelopmentTask;
  public readonly compression_launcher: CompressionTaskLauncher;
  public readonly continuation_launcher: ContinuationLauncher;

  public constructor(options: CodexAppServerTaskHostOptions = {}) {
    this.developmentTask = new CodexAppServerDevelopmentTask(options);
    this.development_tasks = this.developmentTask;
    this.thread_control = this.developmentTask;
    this.compression_launcher = options.compression_launcher ?? FAIL_CLOSED_COMPRESSION_LAUNCHER;
    this.continuation_launcher = options.continuation_launcher ?? FAIL_CLOSED_CONTINUATION_LAUNCHER;
  }

  public dispose(): Promise<void> {
    return this.developmentTask.dispose();
  }
}
