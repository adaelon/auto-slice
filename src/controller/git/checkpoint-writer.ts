import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import { sha256Bytes } from "../state/index.js";
import { CheckpointWriteError } from "./errors.js";
import type {
  CheckpointDocument,
  CheckpointWriteReceipt,
} from "./types.js";

export interface CheckpointWriterOptions {
  readonly rename?: (oldPath: string, newPath: string) => void;
  readonly temporaryNameFactory?: () => string;
}

function isSingleLine(value: string): boolean {
  return value.length > 0 && !/[\r\n]/u.test(value);
}

function validateDocument(document: CheckpointDocument): void {
  const timestamp = Date.parse(document.updated_at);
  const runtimeSchemaVersion: unknown = document.schema_version;
  const scalarValues = [
    document.run_id,
    document.completed_slice_id,
    document.head,
    document.current_summary,
    document.owned_diff_digest,
    document.verification_receipt_digest,
  ];
  if (
    runtimeSchemaVersion !== 1 ||
    !Number.isFinite(timestamp) ||
    !scalarValues.every(isSingleLine) ||
    (document.next_slice_id !== null && !isSingleLine(document.next_slice_id)) ||
    document.next_steps.length > 5 ||
    document.unfinished.length > 10 ||
    document.cold_start_reading_sequence.length > 16 ||
    ![...document.next_steps, ...document.unfinished, ...document.cold_start_reading_sequence]
      .every(isSingleLine)
  ) {
    throw new CheckpointWriteError(
      "checkpoint_invalid",
      "Checkpoint V1 contains an invalid scalar, timestamp, or bounded list.",
    );
  }
}

function numbered(values: readonly string[], emptyValue: string): string {
  const entries = values.length === 0 ? [emptyValue] : values;
  return entries.map((value, index) => `${String(index + 1)}. ${value}`).join("\n");
}

function bullets(values: readonly string[], emptyValue: string): string {
  const entries = values.length === 0 ? [emptyValue] : values;
  return entries.map((value) => `- ${value}`).join("\n");
}

export function renderCheckpoint(document: CheckpointDocument): string {
  validateDocument(document);
  const nextSlice = document.next_slice_id ?? "无（Run 完成）";
  return [
    `# SESSION_CHECKPOINT — ${document.updated_at}`,
    "",
    "## 新鲜度自检",
    "",
    `- 写入时最新 commit：\`${document.head}\`。`,
    "- 读入时请对比 `git log --oneline -3`；若不一致，以 Git 为准。",
    "",
    "## 当前在做什么",
    "",
    document.current_summary,
    "",
    "## 下一步（可直接接手）",
    "",
    numbered(document.next_steps, "Run 已完成，无后继动作。"),
    "",
    "## 未提交 / 未完成",
    "",
    bullets(document.unfinished, "无"),
    "",
    "## 冷启动读序",
    "",
    numbered(document.cold_start_reading_sequence, "读取本文件并核对 Git。"),
    "",
    "## Auto Slice 完成回执",
    "",
    `- Run：\`${document.run_id}\`。`,
    `- 已完成 Slice：\`${document.completed_slice_id}\`。`,
    `- 下一 Slice：\`${nextSlice}\`。`,
    `- Commit mode：\`${document.commit_mode}\`。`,
    `- Owned diff：\`${document.owned_diff_digest}\`。`,
    `- Verification receipt：\`${document.verification_receipt_digest}\`。`,
    "",
  ].join("\n");
}

export class CheckpointWriter {
  private readonly rename: (oldPath: string, newPath: string) => void;
  private readonly temporaryNameFactory: () => string;

  public constructor(options: CheckpointWriterOptions = {}) {
    this.rename = options.rename ?? renameSync;
    this.temporaryNameFactory = options.temporaryNameFactory ??
      (() => `.auto-slice-checkpoint-${String(process.pid)}-${randomUUID()}.tmp`);
  }

  public atomicRewrite(
    workspace: WorkspaceIdentity,
    document: CheckpointDocument,
  ): CheckpointWriteReceipt | CheckpointWriteError {
    let temporaryPath: string | null = null;
    let descriptor: number | null = null;
    try {
      const content = renderCheckpoint(document);
      const temporaryName = this.temporaryNameFactory();
      if (
        !isSingleLine(temporaryName) ||
        path.basename(temporaryName) !== temporaryName ||
        temporaryName === "." ||
        temporaryName === ".."
      ) {
        return new CheckpointWriteError(
          "checkpoint_invalid",
          "Checkpoint temporary name must be one safe path segment.",
        );
      }
      const targetPath = path.join(workspace.canonical_root, "SESSION_CHECKPOINT.md");
      temporaryPath = path.join(workspace.canonical_root, temporaryName);
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.rename(temporaryPath, targetPath);
      temporaryPath = null;
      return {
        path: "SESSION_CHECKPOINT.md",
        digest: sha256Bytes(content),
        bytes: Buffer.byteLength(content, "utf8"),
      };
    } catch (error: unknown) {
      if (error instanceof CheckpointWriteError) {
        return error;
      }
      return new CheckpointWriteError(
        "checkpoint_refresh_failed",
        "Checkpoint flush or atomic rename failed.",
        { cause: error },
      );
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Best-effort close after the primary filesystem failure.
        }
      }
      if (temporaryPath !== null && existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Preserve the primary failure; the caller receives fail-closed state.
        }
      }
    }
  }
}
