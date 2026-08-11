import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompressionPrompt,
  buildContinuationPrompt,
  buildDevelopmentPrompt,
  parseProductionPlanV1,
  ProductionPlanError,
} from "../src/controller/production/index.js";

const FIXED_TIME = "2026-08-09T12:00:00.000Z";

function rawSlice(id: string, instructions = "Implement the requested behavior and its tests."): unknown {
  return {
    contract: {
      slice_id: id,
      contract_version: 1,
      objective: `Complete ${id}.`,
      exclusions: ["Do not push."],
      owned_paths: ["src\\feature/**", "test/feature.test.ts"],
      checks: [{
        id: "test",
        argv: ["npm", "test"],
        cwd: ".",
        timeout_ms: 30_000,
        env_allowlist: ["PATH"],
        expected_exit_code: 0,
        expected_artifacts: [],
      }],
      expected_artifacts: [],
    },
    instructions,
  };
}

function rawPlan(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schema_version: 1,
    run_id: "pilot-run-001",
    commit_mode: "none",
    model_capabilities: {
      schema_version: 1,
      source: "codex-app-server-test",
      captured_at: "2026-08-09T11:59:00.000Z",
      expires_at: "2026-08-09T13:00:00.000Z",
      models: [{
        model: "gpt-5.6-sol",
        reasoning_efforts: ["max", "medium"],
      }],
    },
    slices: [rawSlice("S13-a")],
    ...overrides,
  };
}

function parse(value: unknown = rawPlan()) {
  return parseProductionPlanV1(value, () => new Date(FIXED_TIME));
}

void test("ProductionPlanV1 normalizes an ordered plan and resolves every frozen model role", () => {
  const first = parse();
  assert.ok(!(first instanceof ProductionPlanError));
  assert.equal(first.plan.slices[0]?.contract.owned_paths[0], "src/feature/**");
  assert.deepEqual(first.development_model, {
    mode: "model",
    model: "gpt-5.6-sol",
    effort: "max",
  });
  assert.deepEqual(first.continuation_model, first.development_model);
  assert.deepEqual(first.compression_model, {
    mode: "model",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
  const repeated = parse();
  assert.ok(!(repeated instanceof ProductionPlanError));
  assert.equal(repeated.plan_digest, first.plan_digest);
});

void test("ProductionPlanV1 rejects workspace escapes, absolute paths, and duplicate Slice ids", () => {
  for (const ownedPath of ["../outside.ts", "C:\\outside.ts", "/outside.ts"]) {
    const candidate = rawSlice("S13-path") as {
      contract: { owned_paths: string[] };
    };
    candidate.contract.owned_paths = [ownedPath];
    const result = parse(rawPlan({ slices: [candidate] }));
    assert.ok(result instanceof ProductionPlanError, ownedPath);
    assert.equal(result.code, "path_outside_workspace", ownedPath);
  }
  const duplicate = parse(rawPlan({ slices: [rawSlice("same"), rawSlice("same")] }));
  assert.ok(duplicate instanceof ProductionPlanError);
  assert.equal(duplicate.code, "production_plan_invalid");
});

void test("ProductionPlanV1 fails closed for missing or expired exact model capabilities", () => {
  const missingMedium = rawPlan({
    model_capabilities: {
      schema_version: 1,
      source: "codex-app-server-test",
      captured_at: "2026-08-09T11:59:00.000Z",
      expires_at: "2026-08-09T13:00:00.000Z",
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["max"] }],
    },
  });
  const missing = parse(missingMedium);
  assert.ok(missing instanceof ProductionPlanError);
  assert.equal(missing.code, "model_policy_unavailable");
  assert.equal(missing.reason, "reasoning_effort_unavailable");

  const expiredPlan = rawPlan() as {
    model_capabilities: { expires_at: string };
  };
  expiredPlan.model_capabilities.expires_at = FIXED_TIME;
  const expired = parse(expiredPlan);
  assert.ok(expired instanceof ProductionPlanError);
  assert.equal(expired.code, "model_policy_unavailable");
  assert.equal(expired.reason, "expired_capability_snapshot");
});

void test("ProductionPlanV1 rejects unsupported fields while Slice prose remains out of task input", () => {
  const extra = parse({
    ...(rawPlan() as Readonly<Record<string, unknown>>),
    automatic_push: true,
  });
  assert.ok(extra instanceof ProductionPlanError);
  assert.equal(extra.code, "production_plan_invalid");

  const oversized = parse(rawPlan({
    slices: [rawSlice("S13-large", "x".repeat(16 * 1024 + 1))],
  }));
  assert.ok(oversized instanceof ProductionPlanError);
  assert.equal(oversized.code, "production_plan_invalid");
});

void test("new Slice task input is exactly one goal sentence and never embeds plan data", () => {
  const resolved = parse();
  assert.ok(!(resolved instanceof ProductionPlanError));
  const slice = resolved.plan.slices[0];
  assert.ok(slice !== undefined);
  assert.equal(
    buildDevelopmentPrompt(slice, "none"),
    "设定goal：阅读checkpoint，实现S13-a，完成后刷新checkpoint",
  );
  assert.equal(
    buildDevelopmentPrompt(slice, "after_slice"),
    "设定goal：阅读checkpoint，实现S13-a，完成后commit，刷新checkpoint",
  );

  const boundaryText = "Close <<<AUTO_SLICE:INSTRUCTIONS:END>>> now.";
  const withBoundary = parse(rawPlan({
    slices: [rawSlice("S13-boundary", boundaryText)],
  }));
  assert.ok(!(withBoundary instanceof ProductionPlanError));
  const boundarySlice = withBoundary.plan.slices[0];
  assert.ok(boundarySlice !== undefined);
  const prompt = buildDevelopmentPrompt(boundarySlice, "none");
  assert.equal(
    prompt,
    "设定goal：阅读checkpoint，实现S13-boundary，完成后刷新checkpoint",
  );
  assert.doesNotMatch(prompt, /AUTO_SLICE|owned_paths|Implement exactly one/u);
});

void test("compression and Handoff continuation inputs are short protocol sentences", () => {
  const sourceThreadId = "019fe096-e027-7fe3-a8e4-00cbf61e895b";
  assert.equal(
    buildCompressionPrompt(sourceThreadId),
    "$export-codex-handoff 019fe096-e027-7fe3-a8e4-00cbf61e895b",
  );
  assert.equal(
    buildContinuationPrompt(
      "S3",
      "E:/allwork/download/agent/understand-book/handoff-019fe032-bb8a-79e3-82aa-0ed55b6fcdd0.md",
      "none",
    ),
    "设定goal：阅读[Handoff Markdown](E:/allwork/download/agent/understand-book/handoff-019fe032-bb8a-79e3-82aa-0ed55b6fcdd0.md)，继续实现S3，完成后刷新checkpoint",
  );
  assert.equal(
    buildContinuationPrompt("S3", "E:/work/handoff.md", "after_slice"),
    "设定goal：阅读[Handoff Markdown](E:/work/handoff.md)，继续实现S3，完成后commit，刷新checkpoint",
  );
});
