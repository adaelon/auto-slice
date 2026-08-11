#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireValue(args, flag) {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (typeof value !== "string" || value.length === 0) fail("INVALID_ARGS", `${flag} is required`);
  return value;
}

function consumerContract(scenario) {
  const contract = {
    formatVersion: 1,
    kind: "codex-handoff-synthesize-first-consumer-contract",
    mode: "synthesize_first",
    firstDeliverableIds: ["continue-s20"],
    preDraftEvidenceReads: 0,
    maxTargetedReads: 2,
    allowedReadReasons: ["claim_verification", "named_uncertainty"],
    forbidBroadSearch: true,
    forbidFullFileReread: true,
  };
  if (scenario === "consumer-tamper") contract.preDraftEvidenceReads = 1;
  return contract;
}

function prepare(sessionId, args) {
  if (!/^[0-9a-f-]{36}$/u.test(sessionId)) fail("INVALID_SESSION", "session UUID is invalid");
  const mode = requireValue(args, "--map-result-mode");
  const outputPath = path.resolve(requireValue(args, "--output"));
  const evidenceIndexPath = path.resolve(requireValue(args, "--evidence-index"));
  if (mode !== "continuation-map-v2") fail("INVALID_MAP_RESULT_MODE", "wrong mode");
  if (existsSync(outputPath) || existsSync(evidenceIndexPath)) {
    fail("OUTPUT_EXISTS", "refusing to overwrite output");
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const workDir = mkdtempSync(path.join(os.tmpdir(), "codex-handoff-task-"));
  const sourceRevision = digest(Buffer.from(`source:${sessionId}`, "utf8"));
  const manifest = {
    formatVersion: 2,
    sessionId,
    sourceCwd: process.cwd(),
    sourceRevision,
    mapResultMode: mode,
    outputPath,
    evidenceIndexPath,
    workDir,
    scenario: process.env.S20_HELPER_SCENARIO ?? "happy",
  };
  writeFileSync(path.join(workDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function publish(workDir) {
  const manifest = JSON.parse(readFileSync(path.join(workDir, "manifest.json"), "utf8"));
  if (manifest.scenario === "source-changed") {
    fail("SOURCE_CHANGED", "fixture source revision changed before publish");
  }
  const markdown = [
    "# Codex Handoff",
    "",
    "workflow: handoff-v2",
    `source: ${manifest.sessionId}`,
    "",
  ].join("\n");
  const evidenceValue = {
    formatVersion: 2,
    source: { sourceRevision: manifest.sourceRevision },
    workspace: { sourceRevision: digest(Buffer.from(manifest.sourceCwd, "utf8")) },
    anchors: [],
    preservationLedger: { exactIdentifiers: [] },
    integrity: { indexDigest: "b".repeat(64) },
    fixtureScenario: manifest.scenario,
  };
  const evidence = `${JSON.stringify(evidenceValue, null, 2)}\n`;
  const markdownTemporary = `${manifest.outputPath}.fixture.tmp`;
  const evidenceTemporary = `${manifest.evidenceIndexPath}.fixture.tmp`;
  writeFileSync(markdownTemporary, markdown, { encoding: "utf8", flag: "wx" });
  if (manifest.scenario === "hardlink-pair") {
    linkSync(markdownTemporary, evidenceTemporary);
  } else if (manifest.scenario !== "single-file") {
    writeFileSync(evidenceTemporary, evidence, { encoding: "utf8", flag: "wx" });
  }
  renameSync(markdownTemporary, manifest.outputPath);
  if (manifest.scenario !== "single-file") renameSync(evidenceTemporary, manifest.evidenceIndexPath);

  const contract = consumerContract(manifest.scenario);
  const result = {
    formatVersion: 2,
    sessionId: manifest.sessionId,
    outputPath: manifest.scenario === "path-tamper"
      ? path.join(path.dirname(manifest.outputPath), "substituted.md")
      : manifest.outputPath,
    evidenceIndexPath: manifest.evidenceIndexPath,
    sourceRevision: manifest.sourceRevision,
    structuralDigest: digest(Buffer.from(`structure:${manifest.sessionId}`, "utf8")),
    handoffDigest: manifest.scenario === "digest-tamper"
      ? digest(Buffer.from("tampered", "utf8"))
      : digest(Buffer.from(markdown, "utf8")),
    evidenceIndexDigest: digest(Buffer.from(evidence, "utf8")),
    consumerContract: contract,
    sourceCwd: manifest.sourceCwd,
    workDir: manifest.scenario === "retain-workdir" ? workDir : null,
  };
  if (manifest.scenario !== "retain-workdir") rmSync(workDir, { recursive: true, force: true });
  return result;
}

function verifyEvidence(evidencePath) {
  const value = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (value.fixtureScenario === "verify-fail") fail("VERIFY_FAILED", "injected verify failure");
  return {
    valid: true,
    anchors: 0,
    sourceAnchors: 0,
    workspaceAnchors: 0,
    exactIdentifiers: 0,
    sourceRevision: value.source.sourceRevision,
    workspaceRevision: value.workspace.sourceRevision,
  };
}

function dispatch(args) {
  const [command, ...rest] = args;
  if (command === "prepare") {
    const [sessionId, ...options] = rest;
    if (typeof sessionId !== "string") fail("INVALID_ARGS", "session id is required");
    return prepare(sessionId, options);
  }
  if (command === "publish") {
    const [workDir, ...unknown] = rest;
    if (typeof workDir !== "string" || unknown.length !== 0) fail("INVALID_ARGS", "publish argv invalid");
    return publish(path.resolve(workDir));
  }
  if (command === "verify-evidence") {
    const [evidencePath, ...unknown] = rest;
    if (typeof evidencePath !== "string" || unknown.length !== 0) {
      fail("INVALID_ARGS", "verify-evidence argv invalid");
    }
    return verifyEvidence(path.resolve(evidencePath));
  }
  fail("INVALID_COMMAND", "unsupported fixture command");
}

try {
  const result = dispatch(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error.code ?? "ERROR",
    message: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
