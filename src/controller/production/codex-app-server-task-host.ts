import {
  AppServerContinuationTaskLauncher,
  type ContinuationLauncher,
} from "../continuation/index.js";
import {
  AppServerCompressionTaskLauncher,
  type CompressionTaskLauncher,
} from "../handoff/index.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexAppServerDevelopmentTask } from "./codex-app-server-development-task.js";
import type { CodexAppServerDevelopmentTaskOptions } from "./codex-app-server-development-task.js";
import {
  CodexAppServerFreshTaskSessions,
  type CodexAppServerFreshTaskSessionsOptions,
} from "./app-server-fresh-task-session.js";
import type { ProductionTaskHostPorts } from "./file-production-runtime.js";

export interface CodexAppServerTaskHostOptions extends CodexAppServerDevelopmentTaskOptions {
  readonly compression_launcher?: CompressionTaskLauncher;
  readonly continuation_launcher?: ContinuationLauncher;
  readonly fresh_task_sessions?: CodexAppServerFreshTaskSessionsOptions;
  readonly handoff_artifact_storage_root?: string;
  readonly compression_maximum_final_result_bytes?: number;
  readonly continuation_maximum_handoff_markdown_bytes?: number;
}

export class CodexAppServerTaskHost implements ProductionTaskHostPorts {
  private readonly client: CodexAppServerClient;
  private readonly developmentTask: CodexAppServerDevelopmentTask;
  private disposePromise: Promise<void> | null = null;

  public readonly development_tasks: CodexAppServerDevelopmentTask;
  public readonly thread_control: CodexAppServerDevelopmentTask;
  public readonly fresh_task_sessions: CodexAppServerFreshTaskSessions;
  public readonly compression_launcher: CompressionTaskLauncher;
  public readonly continuation_launcher: ContinuationLauncher;

  public constructor(options: CodexAppServerTaskHostOptions = {}) {
    this.client = new CodexAppServerClient(options);
    this.fresh_task_sessions = new CodexAppServerFreshTaskSessions(
      this.client,
      options.fresh_task_sessions,
    );
    this.developmentTask = new CodexAppServerDevelopmentTask(options, this.client);
    this.development_tasks = this.developmentTask;
    this.thread_control = this.developmentTask;
    this.compression_launcher = options.compression_launcher ??
      new AppServerCompressionTaskLauncher({
        client: this.client,
        fresh_task_sessions: this.fresh_task_sessions,
        ...(options.handoff_artifact_storage_root === undefined
          ? {}
          : { artifact_storage_root: options.handoff_artifact_storage_root }),
        ...(options.compression_maximum_final_result_bytes === undefined
          ? {}
          : { maximum_final_result_bytes: options.compression_maximum_final_result_bytes }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.continuation_launcher = options.continuation_launcher ??
      new AppServerContinuationTaskLauncher({
        fresh_task_sessions: this.fresh_task_sessions,
        ...(options.continuation_maximum_handoff_markdown_bytes === undefined
          ? {}
          : {
            maximum_handoff_markdown_bytes:
              options.continuation_maximum_handoff_markdown_bytes,
          }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    await this.developmentTask.dispose();
    this.fresh_task_sessions.dispose();
    await this.client.dispose();
  }
}
