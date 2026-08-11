import path from "node:path";

import type { CommitMode } from "../state/index.js";
import { ProductionPlanError } from "./errors.js";
import type { ProductionSliceV1 } from "./types.js";

export const MAXIMUM_GOAL_PROMPT_BYTES = 4 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalid(message: string): ProductionPlanError {
  return new ProductionPlanError("development_prompt_invalid", message);
}

function completionClause(commitMode: CommitMode): string {
  return commitMode === "after_slice"
    ? "完成后commit，刷新checkpoint"
    : "完成后刷新checkpoint";
}

function bounded(prompt: string): string | ProductionPlanError {
  if (
    /[\r\n\0]/u.test(prompt) ||
    Buffer.byteLength(prompt, "utf8") > MAXIMUM_GOAL_PROMPT_BYTES
  ) {
    return invalid(
      `Goal task input must be one line of at most ${String(MAXIMUM_GOAL_PROMPT_BYTES)} UTF-8 bytes.`,
    );
  }
  return prompt;
}

function validSliceId(value: string): boolean {
  return value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\s\r\n\0，。：、()[\]{}<>]/u.test(value);
}

export function effectiveCommitMode(
  slice: ProductionSliceV1,
  runMode: CommitMode,
  runtimeOverride?: CommitMode,
): CommitMode {
  return slice.contract.commit_mode_override ?? runtimeOverride ?? runMode;
}

export function buildDevelopmentPrompt(
  slice: ProductionSliceV1,
  commitMode: CommitMode,
): string | ProductionPlanError {
  if (!validSliceId(slice.contract.slice_id)) {
    return invalid("Slice id cannot be rendered as one unambiguous goal sentence.");
  }
  return bounded(
    `设定goal：阅读checkpoint，实现${slice.contract.slice_id}，${completionClause(commitMode)}`,
  );
}

export function buildCompressionPrompt(
  sourceThreadId: string,
): string | ProductionPlanError {
  if (!UUID_PATTERN.test(sourceThreadId)) {
    return invalid("Source Thread id must be one canonical UUID.");
  }
  return bounded(`$export-codex-handoff ${sourceThreadId}`);
}

export function buildContinuationPrompt(
  sliceId: string,
  handoffMarkdownPath: string,
  commitMode: CommitMode,
): string | ProductionPlanError {
  if (!validSliceId(sliceId)) {
    return invalid("Continuation Slice id cannot be rendered as one unambiguous goal sentence.");
  }
  if (
    !path.isAbsolute(handoffMarkdownPath) ||
    /[\r\n\0)]/u.test(handoffMarkdownPath)
  ) {
    return invalid("Handoff Markdown path must be one safe absolute path.");
  }
  const linkPath = handoffMarkdownPath.replaceAll("\\", "/");
  return bounded(
    `设定goal：阅读[Handoff Markdown](${linkPath})，继续实现${sliceId}，${completionClause(commitMode)}`,
  );
}
