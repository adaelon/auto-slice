import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_POLICY_SCHEMA_VERSION,
  ModelPolicyError,
  ModelRouter,
  type HostModelCapabilitySnapshot,
  type ModelDecision,
  type ModelPolicyFailureReason,
  type WorkRole,
} from "../src/controller/model-policy/index.js";

const NOW = "2026-08-08T00:00:00.000Z";

function capabilities(
  models: HostModelCapabilitySnapshot["models"] = [
    {
      model: "gpt-5.6-sol",
      reasoning_efforts: ["medium", "max"],
    },
  ],
): HostModelCapabilitySnapshot {
  return {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    source: "codex-host-test",
    captured_at: NOW,
    expires_at: "2026-08-08T00:05:00.000Z",
    models,
  };
}

function router(): ModelRouter {
  return new ModelRouter(() => new Date(NOW));
}

function unwrap(result: ModelDecision | ModelPolicyError): ModelDecision {
  if (result instanceof ModelPolicyError) {
    assert.fail(`${result.code}/${result.reason}: ${result.message}`);
  }
  return result;
}

function expectFailure(
  result: ModelDecision | ModelPolicyError,
  reason: ModelPolicyFailureReason,
): ModelPolicyError {
  assert.ok(result instanceof ModelPolicyError);
  assert.equal(result.code, "model_policy_unavailable");
  assert.equal(result.reason, reason);
  return result;
}

void test("maps every work role to the frozen model policy", () => {
  const cases = [
    ["DEVELOPMENT", { mode: "model", model: "gpt-5.6-sol", effort: "max" }],
    ["CONTINUATION", { mode: "model", model: "gpt-5.6-sol", effort: "max" }],
    ["COMPRESSION", { mode: "model", model: "gpt-5.6-sol", effort: "medium" }],
    ["DETERMINISTIC", { mode: "none" }],
  ] as const satisfies readonly (readonly [WorkRole, ModelDecision])[];

  for (const [role, expected] of cases) {
    assert.deepEqual(unwrap(router().resolve(role, capabilities())), expected);
  }
});

void test("fails closed when the exact model or reasoning effort is unavailable", () => {
  expectFailure(
    router().resolve("DEVELOPMENT", capabilities([
      { model: "gpt-5.6-terra", reasoning_efforts: ["max"] },
    ])),
    "model_unavailable",
  );
  expectFailure(
    router().resolve("DEVELOPMENT", capabilities([
      { model: "gpt-5.6-sol", reasoning_efforts: ["medium"] },
      { model: "gpt-5.6-terra", reasoning_efforts: ["max"] },
    ])),
    "reasoning_effort_unavailable",
  );
  expectFailure(
    router().resolve("COMPRESSION", capabilities([
      { model: "gpt-5.6-sol", reasoning_efforts: ["max"] },
    ])),
    "reasoning_effort_unavailable",
  );
});

void test("rejects unknown roles instead of choosing a default", () => {
  expectFailure(router().resolve("REVIEW", capabilities()), "unknown_role");
  expectFailure(router().resolve(undefined, capabilities()), "unknown_role");
});

void test("rejects malformed, future, duplicate, and expired Host capability snapshots", () => {
  const valid = capabilities();
  const malformedCases: readonly [unknown, ModelPolicyFailureReason][] = [
    [{ ...valid, schema_version: 2 }, "invalid_capability_snapshot"],
    [{ ...valid, source: "" }, "invalid_capability_snapshot"],
    [{ ...valid, captured_at: "not-a-date" }, "invalid_capability_snapshot"],
    [{ ...valid, captured_at: "2026-08-08T00:00:00.001Z" }, "future_capability_snapshot"],
    [
      {
        ...valid,
        captured_at: "2026-08-07T23:59:00.000Z",
        expires_at: NOW,
      },
      "expired_capability_snapshot",
    ],
    [
      {
        ...valid,
        captured_at: "2026-08-07T23:59:00.000Z",
        expires_at: "2026-08-07T23:59:59.999Z",
      },
      "expired_capability_snapshot",
    ],
    [
      capabilities([
        { model: "gpt-5.6-sol", reasoning_efforts: ["max"] },
        { model: "gpt-5.6-sol", reasoning_efforts: ["medium"] },
      ]),
      "invalid_capability_snapshot",
    ],
    [
      capabilities([{ model: "gpt-5.6-sol", reasoning_efforts: ["max", "max"] }]),
      "invalid_capability_snapshot",
    ],
  ];

  for (const [snapshot, reason] of malformedCases) {
    expectFailure(router().resolve("DEVELOPMENT", snapshot), reason);
  }
});

void test("DETERMINISTIC resolves without reading capabilities or constructing a provider request", () => {
  let capabilityReads = 0;
  let providerRequests = 0;
  const inaccessibleCapabilities = new Proxy({}, {
    get: () => {
      capabilityReads += 1;
      throw new Error("capabilities must not be read for deterministic work");
    },
  });

  const decision = unwrap(router().resolve("DETERMINISTIC", inaccessibleCapabilities));
  if (decision.mode === "model") {
    providerRequests += 1;
  }

  assert.deepEqual(decision, { mode: "none" });
  assert.equal(capabilityReads, 0);
  assert.equal(providerRequests, 0);
});

void test("fails closed when the Router clock cannot establish snapshot freshness", () => {
  const invalidClockRouter = new ModelRouter(() => new Date(Number.NaN));
  expectFailure(
    invalidClockRouter.resolve("DEVELOPMENT", capabilities()),
    "clock_unavailable",
  );
});
