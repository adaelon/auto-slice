#!/usr/bin/env node

const NOW = "2026-08-08T00:00:00.000Z";

function snapshot(models, overrides = {}) {
  return {
    schema_version: 1,
    source: "codex-host-evidence",
    captured_at: NOW,
    expires_at: "2026-08-08T00:05:00.000Z",
    models,
    ...overrides,
  };
}

function fail(message) {
  throw new Error(message);
}

const policyModule = await import("../dist/src/controller/model-policy/index.js");
const { ModelPolicyError, ModelRouter } = policyModule;
const router = new ModelRouter(() => new Date(NOW));
const fullCapabilities = snapshot([
  { model: "gpt-5.6-sol", reasoning_efforts: ["medium", "max"] },
]);

const expectedPolicies = [
  ["DEVELOPMENT", { mode: "model", model: "gpt-5.6-sol", effort: "max" }],
  ["CONTINUATION", { mode: "model", model: "gpt-5.6-sol", effort: "max" }],
  ["COMPRESSION", { mode: "model", model: "gpt-5.6-sol", effort: "medium" }],
  ["DETERMINISTIC", { mode: "none" }],
];
const policyScenarios = expectedPolicies.map(([role, expected]) => {
  const decision = router.resolve(role, fullCapabilities);
  if (decision instanceof ModelPolicyError || JSON.stringify(decision) !== JSON.stringify(expected)) {
    fail(`Frozen policy mismatch for ${role}.`);
  }
  return {
    role,
    decision,
    result: "PASS",
  };
});
const policyMatrix = {
  schema_version: 1,
  slice_id: "S04",
  scenarios: policyScenarios,
  result: "PASS",
};

const failureInputs = [
  {
    id: "missing_exact_model",
    role: "DEVELOPMENT",
    capabilities: snapshot([
      { model: "gpt-5.6-terra", reasoning_efforts: ["max"] },
    ]),
    expected_reason: "model_unavailable",
  },
  {
    id: "missing_exact_effort",
    role: "DEVELOPMENT",
    capabilities: snapshot([
      { model: "gpt-5.6-sol", reasoning_efforts: ["medium"] },
      { model: "gpt-5.6-terra", reasoning_efforts: ["max"] },
    ]),
    expected_reason: "reasoning_effort_unavailable",
  },
  {
    id: "unknown_role",
    role: "REVIEW",
    capabilities: fullCapabilities,
    expected_reason: "unknown_role",
  },
  {
    id: "expired_snapshot",
    role: "COMPRESSION",
    capabilities: snapshot(
      [{ model: "gpt-5.6-sol", reasoning_efforts: ["medium", "max"] }],
      {
        captured_at: "2026-08-07T23:58:00.000Z",
        expires_at: "2026-08-07T23:59:00.000Z",
      },
    ),
    expected_reason: "expired_capability_snapshot",
  },
];
const failureScenarios = failureInputs.map((scenario) => {
  const decision = router.resolve(scenario.role, scenario.capabilities);
  if (
    !(decision instanceof ModelPolicyError) ||
    decision.code !== "model_policy_unavailable" ||
    decision.reason !== scenario.expected_reason
  ) {
    fail(`Failure closure mismatch for ${scenario.id}.`);
  }
  return {
    id: scenario.id,
    outcome: decision.code,
    reason: decision.reason,
    result: "PASS",
  };
});
const failureMatrix = {
  schema_version: 1,
  slice_id: "S04",
  scenarios: failureScenarios,
  result: "PASS",
};

let capabilityReadCount = 0;
let providerRequestCount = 0;
const inaccessibleCapabilities = new Proxy({}, {
  get: () => {
    capabilityReadCount += 1;
    throw new Error("DETERMINISTIC must not inspect model capabilities.");
  },
});
const deterministicDecision = router.resolve("DETERMINISTIC", inaccessibleCapabilities);
if (deterministicDecision instanceof ModelPolicyError) {
  fail("DETERMINISTIC unexpectedly required model capabilities.");
}
if (deterministicDecision.mode === "model") {
  providerRequestCount += 1;
}
if (capabilityReadCount !== 0 || providerRequestCount !== 0) {
  fail("DETERMINISTIC constructed or prepared a provider request.");
}
const providerRequestReport = {
  schema_version: 1,
  slice_id: "S04",
  role: "DETERMINISTIC",
  decision: deterministicDecision,
  capability_read_count: capabilityReadCount,
  provider_request_count: providerRequestCount,
  result: "PASS",
};

process.stdout.write(JSON.stringify({
  policy_matrix: policyMatrix,
  failure_matrix: failureMatrix,
  provider_request_report: providerRequestReport,
}));
