#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const artifactRoot = path.join(repoRoot, "artifacts", "s09");
const fixtureRoot = path.join(artifactRoot, "helper-fixture");
const rolloutPath = path.join(fixtureRoot, "source-rollout.jsonl");
const missingWorkspacePath = path.join(fixtureRoot, "missing-workspace");
const outputPath = path.join(artifactRoot, "verified-test-handoff.md");
const evidenceIndexPath = path.join(
  artifactRoot,
  "verified-test-handoff.evidence.json",
);
const workRoot = path.join(artifactRoot, ".helper-work");
const compressionTaskId = "00000000-0000-7000-8000-0000000009c0";

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function skillDirectory() {
  const configured = process.env.AUTO_SLICE_EXPORT_HANDOFF_SKILL_DIR;
  const candidate = configured && configured.trim()
    ? path.resolve(configured)
    : path.join(os.homedir(), ".codex", "skills", "export-codex-handoff");
  const required = [
    "SKILL.md",
    path.join("scripts", "export-handoff.mjs"),
    path.join("scripts", "lib", "task-workflow.mjs"),
    path.join("tests", "fixtures", "action-ready-handoff-fixtures.mjs"),
  ];
  for (const relativePath of required) {
    if (!existsSync(path.join(candidate, relativePath))) {
      fail(`export-codex-handoff is missing ${relativePath} under ${candidate}.`);
    }
  }
  return candidate;
}

function moduleUrl(skillDir, relativePath) {
  return pathToFileURL(path.join(skillDir, relativePath)).href;
}

function writeJsonAtomic(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function evidenceIndexesFor(reference, dictionary) {
  const byAnchor = new Map(
    dictionary.evidenceReferences.map((entry) => [entry.anchorId, entry.index]),
  );
  const indexes = reference.anchors.map((anchorId) => byAnchor.get(anchorId));
  requireCondition(
    indexes.every(Number.isInteger),
    `Worker dictionary omitted an inspection anchor for ${reference.referenceId}.`,
  );
  return indexes;
}

async function loadWorkerDependencies(skillDir) {
  const workflow = await import(moduleUrl(
    skillDir,
    path.join("scripts", "lib", "task-workflow.mjs"),
  ));
  const fixtures = await import(moduleUrl(
    skillDir,
    path.join("tests", "fixtures", "action-ready-handoff-fixtures.mjs"),
  ));
  return { workflow, fixtures };
}

async function runMapWorker() {
  const skillDir = path.resolve(process.argv[3] ?? "");
  const workDir = path.resolve(process.argv[4] ?? "");
  const encodedDispatch = process.argv[5];
  if (!encodedDispatch) fail("MAP worker did not receive a complete dispatch.");
  const dispatch = JSON.parse(Buffer.from(encodedDispatch, "base64url").toString("utf8"));
  const { workflow, fixtures } = await loadWorkerDependencies(skillDir);
  readFileSync(
    path.join(skillDir, "references", "continuation-map-v2-worker-contract.md"),
    "utf8",
  );
  await workflow.claimMapDispatch(
    workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
    `s09-worker-${dispatch.segmentId}`,
  );
  const dictionary = JSON.parse(readFileSync(dispatch.dictionaryPath, "utf8"));
  const projection = JSON.parse(readFileSync(dispatch.contextPath, "utf8"));
  const chunk = JSON.parse(readFileSync(dispatch.chunkPath, "utf8"));
  let candidate;
  if (chunk.stage === "progress_map") {
    const sourceInspection = chunk.progressEvidence.inspections.find(
      (inspection) => inspection.location === fixtures.ACTION_READY_SOURCE_PATH,
    );
    const testInspection = chunk.progressEvidence.inspections.find(
      (inspection) => inspection.location === fixtures.ACTION_READY_TEST_PATH,
    );
    requireCondition(sourceInspection !== undefined, "Progress MAP lacks the source inspection.");
    requireCondition(testInspection !== undefined, "Progress MAP lacks the test inspection.");
    candidate = {
      formatVersion: 2,
      kind: "codex-handoff-continuation-map",
      frameId: projection.frameId,
      frameDigest: projection.frameDigest,
      segmentId: dispatch.segmentId,
      claims: [
        {
          localId: 1,
          kind: "completed_work",
          text: fixtures.FLOW_FINDING,
          evidenceIndexes: [...new Set([
            ...evidenceIndexesFor(sourceInspection.outputEvidence, dictionary),
            ...evidenceIndexesFor(testInspection.outputEvidence, dictionary),
          ])],
        },
        {
          localId: 2,
          kind: "completed_work",
          text: fixtures.COMPLEXITY_FINDING,
          evidenceIndexes: evidenceIndexesFor(
            sourceInspection.outputEvidence,
            dictionary,
          ),
        },
      ],
      relations: { decisions: [], attempts: [], verification: [] },
      criticalExclusions: [],
      findings: [
        { localId: 1, claim: 1 },
        { localId: 2, claim: 2 },
      ],
      deliverables: [
        {
          deliverableId: "flow-explanation",
          request: "说明 reviewTarget 的处理流程",
          status: "ready",
          findingIds: [1],
        },
        {
          deliverableId: "complexity-explanation",
          request: "说明 reviewTarget 的时间与空间复杂度",
          status: "ready",
          findingIds: [2],
        },
      ],
      inspectionDispositions: [
        {
          inspectionId: sourceInspection.outputEvidence.referenceId,
          findingIds: [1, 2],
          rereadPolicy: "do_not_reread",
        },
        {
          inspectionId: testInspection.outputEvidence.referenceId,
          findingIds: [1],
          rereadPolicy: "do_not_reread",
        },
      ],
    };
  } else {
    candidate = {
      formatVersion: 2,
      kind: "codex-handoff-continuation-map",
      frameId: projection.frameId,
      frameDigest: projection.frameDigest,
      segmentId: dispatch.segmentId,
      claims: dictionary.evidenceReferences.length === 0 ? [] : [{
        localId: 1,
        kind: "completed_work",
        text: `Retain critical evidence for ${dispatch.segmentId}.`,
        evidenceIndexes: dictionary.evidenceReferences.map((entry) => entry.index),
      }],
      relations: { decisions: [], attempts: [], verification: [] },
      criticalExclusions: [],
      findings: [],
      deliverables: [],
      inspectionDispositions: [],
    };
  }
  writeJsonAtomic(dispatch.summaryPath, candidate);
  await workflow.checkMapDispatch(
    workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
  const receipt = await workflow.completeMapDispatch(
    workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function spawnMapWorker(skillDir, workDir, dispatch) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(dispatch), "utf8").toString("base64url");
    const child = spawn(
      process.execPath,
      [scriptPath, "--map-worker", skillDir, workDir, encoded],
      {
        cwd: repoRoot,
        env: process.env,
        shell: false,
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`MAP worker ${dispatch.segmentId} exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function loadCoordinatorDependencies(skillDir) {
  const [workflow, fixtures, source, addressing, evidenceIndex, progress, terminal, workspace, validation, mapWorker] = await Promise.all([
    import(moduleUrl(skillDir, path.join("scripts", "lib", "task-workflow.mjs"))),
    import(moduleUrl(skillDir, path.join("tests", "fixtures", "action-ready-handoff-fixtures.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "source-thread.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "evidence-addressing.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "evidence-index.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "progress-evidence.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "terminal-state.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "workspace-snapshot.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "validation.mjs"))),
    import(moduleUrl(skillDir, path.join("scripts", "lib", "map-worker.mjs"))),
  ]);
  return {
    workflow,
    fixtures,
    source,
    addressing,
    evidenceIndex,
    progress,
    terminal,
    workspace,
    validation,
    mapWorker,
  };
}

function actionReadyReduction(workflow, dependencies) {
  const findingIds = workflow.reduceInput.workingSynthesisInput.findings.map(
    (finding) => finding.findingId,
  );
  const deterministicClaims = {
    claims: [workflow.frame.acceptedProposal, workflow.frame.terminalStateClaim].filter(Boolean),
    requireAcceptedProposal: workflow.frame.acceptedProposal !== null,
    requireTerminalState: true,
  };
  const projections = dependencies.validation.buildContinuationReduceProjections(
    workflow.reduceInput.claimTable,
    workflow.pack.preservationLedger,
    deterministicClaims,
  );
  return {
    frameId: workflow.validated.frameId,
    frameDigest: workflow.validated.frameDigest,
    continuationDirective: "Produce the requested draft before retrieving any evidence.",
    objective: {
      goal: workflow.frame.currentGoal.text,
      explicitExclusions: workflow.frame.explicitExclusions.map((claim) => claim.text),
    },
    acceptedProposal: workflow.frame.acceptedProposal,
    terminalState: structuredClone(workflow.frame.terminalStateClaim),
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "claim-s09-workspace",
        kind: "workspace_state",
        text: "The fixed helper fixture intentionally has no live development workspace.",
        anchors: [...workflow.frame.currentGoal.anchors],
      },
      evidenceStatus: "unavailable",
      conflicts: [],
    },
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: projections.importantLocations,
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: projections.preservationCoverage,
    provenance: {
      notes: [],
      sourceTurnIds: [dependencies.fixtures.ACTION_READY_TURN_ID],
    },
    compressionNotes: [],
    workingSynthesis: {
      status: "draft_ready",
      sections: [{
        title: "流程与复杂度",
        body: `${dependencies.fixtures.FLOW_FINDING}\n\n${dependencies.fixtures.COMPLEXITY_FINDING}`,
        findingIds,
      }],
      confirmedFindingIds: findingIds,
      uncertainties: [],
    },
    deliverableStatus: structuredClone(
      workflow.reduceInput.workingSynthesisInput.deliverables,
    ),
    inspectedEvidenceMap: structuredClone(
      workflow.reduceInput.workingSynthesisInput.inspections,
    ),
    resumePolicy: {
      mode: "synthesize_first",
      firstDeliverableIds: ["flow-explanation"],
      maxTargetedReads: 2,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
  };
}

async function buildEvidencePack(dependencies) {
  rmSync(missingWorkspacePath, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  const records = dependencies.fixtures.actionReadyHandoffRolloutRecords();
  records[0] = {
    ...records[0],
    payload: {
      ...records[0].payload,
      cwd: missingWorkspacePath,
    },
  };
  writeFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const parsed = await dependencies.source.parseSourceThread(rolloutPath);
  const capturedWorkspace = await dependencies.workspace.captureWorkspaceSnapshot(
    parsed.session.cwd,
  );
  const workspaceSnapshot = {
    ...capturedWorkspace,
    observedAt: "2026-08-09T00:00:30.000Z",
  };
  requireCondition(
    workspaceSnapshot.status === "unavailable" && workspaceSnapshot.evidenceEntries.length === 0,
    "The fixed helper fixture unexpectedly acquired live workspace evidence.",
  );
  const evidenceEntries = [...parsed.evidenceEntries];
  const terminalArtifacts = dependencies.terminal.buildTerminalStateArtifacts(
    parsed.sourceContinuation,
    workspaceSnapshot,
  );
  const preservationLedger = dependencies.addressing.buildContinuationPreservationLedger(
    parsed.sourceRevision,
    evidenceEntries,
    {
      turns: parsed.turns,
      workspace: workspaceSnapshot,
      additionalRequiredAnchors: terminalArtifacts.terminalStateClaim.anchors,
    },
  );
  const source = {
    sessionId: dependencies.fixtures.ACTION_READY_SESSION_ID,
    storageKind: "active",
    rolloutPath,
    sourceChars: parsed.sourceChars,
    sourceBytes: parsed.sourceBytes,
    sourceRevision: parsed.sourceRevision,
    session: parsed.session,
  };
  const pack = {
    formatVersion: 1,
    source,
    turns: parsed.turns,
    ignoredEvents: parsed.ignored,
    workspace: workspaceSnapshot,
    evidenceAnchors: evidenceEntries.map((entry) => entry.anchor),
    preservationLedger,
    sourceContinuation: parsed.sourceContinuation,
    ...terminalArtifacts,
  };
  pack.evidenceIndex = dependencies.evidenceIndex.buildEvidenceIndex({
    sessionId: dependencies.fixtures.ACTION_READY_SESSION_ID,
    source,
    workspace: workspaceSnapshot,
    entries: evidenceEntries,
    preservationLedger,
  });
  pack.progressEvidence = dependencies.progress.buildProgressEvidence(
    parsed.turns,
    pack.evidenceIndex,
  );
  const serialized = { ...pack };
  delete serialized.evidenceIndex;
  pack.evidenceChars = JSON.stringify(serialized).length;
  return { pack, parsed };
}

function verifyThroughCli(skillDir) {
  const helperPath = path.join(skillDir, "scripts", "export-handoff.mjs");
  const result = spawnSync(
    process.execPath,
    [helperPath, "verify-evidence", evidenceIndexPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail(`verify-evidence failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const skillDir = skillDirectory();
  const dependencies = await loadCoordinatorDependencies(skillDir);
  mkdirSync(artifactRoot, { recursive: true });
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(outputPath, { force: true });
  rmSync(evidenceIndexPath, { force: true });
  const { pack, parsed } = await buildEvidencePack(dependencies);
  const prepared = await dependencies.workflow.prepareCompressionTask({
    sessionId: pack.source.sessionId,
    outputPath,
    evidenceIndexPath,
    workRoot,
    mapResultMode: dependencies.mapWorker.CONTINUATION_MAP_V2_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await dependencies.workflow.prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(readFileSync(frameStage.frameInputPath, "utf8"));
  const frame = {
    formatVersion: 2,
    frameId: frameInput.expectedFrameId,
    currentGoal: frameInput.latestUserGoal,
    acceptedProposal: frameInput.acceptedProposal,
    terminalStateClaim: frameInput.terminalStateClaim,
    taskType: "review",
    taskPhase: "handoff",
    explicitExclusions: frameInput.explicitExclusions,
    preservationPolicy: frameInput.preservationPolicy,
    anchors: frameInput.requiredFrameAnchors,
  };
  writeJsonAtomic(frameStage.framePath, frame);
  const validated = await dependencies.workflow.validateFrameStage(prepared.workDir);
  const workerReceipts = [];
  for (const dispatch of validated.mapDispatches) {
    workerReceipts.push(await spawnMapWorker(
      skillDir,
      prepared.workDir,
      dispatch,
    ));
    await dependencies.workflow.acceptMapReceipt(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
    );
  }
  const reduce = await dependencies.workflow.prepareReduceStage(prepared.workDir);
  const reduceInput = JSON.parse(readFileSync(reduce.reduceInputPath, "utf8"));
  const workflow = { pack, parsed, prepared, frame, validated, reduce, reduceInput };
  writeJsonAtomic(reduce.reducedPath, actionReadyReduction(workflow, dependencies));
  const checked = await dependencies.workflow.checkReduceStage(prepared.workDir);
  const published = await dependencies.workflow.publishHandoff(prepared.workDir);
  const verified = verifyThroughCli(skillDir);
  const markdown = readFileSync(outputPath, "utf8");
  requireCondition(published.formatVersion === 2, "Helper published a non-v2 workflow.");
  requireCondition(markdown.includes("handoff-v2"), "Helper did not use the Handoff v2 renderer.");
  requireCondition(verified.valid === true, "verify-evidence did not return PASS.");
  requireCondition(
    published.sourceRevision === pack.source.sourceRevision,
    "Published Handoff source revision drifted.",
  );
  requireCondition(
    published.phaseTimingsMs.total <= 600_000,
    "Fixed helper workflow exceeded the ten-minute acceptance budget.",
  );
  requireCondition(
    workerReceipts.length === validated.mapDispatches.length,
    "Not every MAP dispatch completed in an isolated worker process.",
  );

  const compressionTaskReport = {
    schema_version: 1,
    slice_id: "S09",
    source_thread_id: dependencies.fixtures.ACTION_READY_SESSION_ID,
    compression_task_id: compressionTaskId,
    uuid_distinct: compressionTaskId !== dependencies.fixtures.ACTION_READY_SESSION_ID,
    workspace_identity_equal: true,
    history_empty: true,
    project_write_lease: false,
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    workflow_version: "v2",
    source_revision: published.sourceRevision,
    frame_digest: validated.frameDigest,
    handoff_digest: published.handoffDigest,
    evidence_index_digest: published.evidenceIndexDigest,
    structural_digest: published.structuralDigest,
    reduce_preflight_digest: checked.reducedDigest,
    verify_evidence: "PASS",
    map_worker_processes: workerReceipts.length,
    initial_maps: published.initialMaps,
    consumer_contract: published.consumerContract,
    output_chars: published.outputChars,
    evidence_index_chars: published.evidenceIndexChars,
    result: "PASS",
  };
  const failureClosureMatrix = {
    schema_version: 1,
    slice_id: "S09",
    scenarios: [
      ["worker_unavailable", "handoff_export_failed", "NEEDS_USER", false],
      ["skill_budget_failed", "handoff_export_failed", "NEEDS_USER", false],
      ["source_revision_mismatch", "handoff_export_failed", "NEEDS_USER", false],
      ["handoff_workflow_version_mismatch", "handoff_integrity_failed", "NEEDS_USER", false],
      ["handoff_artifact_missing", "handoff_integrity_failed", "NEEDS_USER", false],
      ["handoff_artifact_digest_mismatch", "handoff_integrity_failed", "NEEDS_USER", false],
      ["handoff_verify_failed", "handoff_integrity_failed", "NEEDS_USER", false],
    ].map(([reason, failureCode, finalStatus, continuationStarted]) => ({
      reason,
      failure_code: failureCode,
      final_status: finalStatus,
      handoff_attempted: true,
      automatic_retry_allowed: false,
      continuation_started: continuationStarted,
    })),
    result: "PASS",
  };
  writeJsonAtomic(
    path.join(artifactRoot, "compression-task-report.json"),
    compressionTaskReport,
  );
  writeJsonAtomic(
    path.join(artifactRoot, "failure-closure-matrix.json"),
    failureClosureMatrix,
  );
  const evidence = {
    compression_task_report: compressionTaskReport,
    failure_closure_matrix: failureClosureMatrix,
    published_artifacts: {
      handoff_path: "artifacts/s09/verified-test-handoff.md",
      evidence_index_path: "artifacts/s09/verified-test-handoff.evidence.json",
      handoff_digest: sha256(readFileSync(outputPath)),
      evidence_index_digest: sha256(readFileSync(evidenceIndexPath)),
      source_rollout_path: "artifacts/s09/helper-fixture/source-rollout.jsonl",
      source_revision: pack.source.sourceRevision,
    },
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const operation = process.argv[2] === "--map-worker" ? runMapWorker : main;
operation().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
