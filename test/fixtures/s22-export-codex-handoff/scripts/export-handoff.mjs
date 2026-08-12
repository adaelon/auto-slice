#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
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
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_ARGS", `${flag} is required`);
  }
  return value;
}

function consumerContract() {
  return {
    formatVersion: 1,
    kind: "codex-handoff-synthesize-first-consumer-contract",
    mode: "synthesize_first",
    firstDeliverableIds: ["s22-hermetic-first-draft"],
    preDraftEvidenceReads: 0,
    maxTargetedReads: 2,
    allowedReadReasons: ["claim_verification", "named_uncertainty"],
    forbidBroadSearch: true,
    forbidFullFileReread: true,
  };
}

function resumePolicy(contract) {
  return [
    "## Resume Policy",
    "",
    `- Mode: \`${contract.mode}\``,
    `- First deliverable IDs: ${contract.firstDeliverableIds.map((entry) => `\`${entry}\``).join(", ")}`,
    `- Pre-draft evidence reads: \`${String(contract.preDraftEvidenceReads)}\``,
    `- Maximum targeted reads after the first draft: \`${String(contract.maxTargetedReads)}\``,
    `- Allowed read reasons: ${contract.allowedReadReasons.map((entry) => `\`${entry}\``).join(", ")}`,
    `- Broad search: \`${contract.forbidBroadSearch ? "forbidden" : "allowed"}\``,
    `- Full-file reread: \`${contract.forbidFullFileReread ? "forbidden" : "allowed"}\``,
    "",
  ];
}

function prepare(sessionId, args) {
  if (!/^[0-9a-f-]{36}$/u.test(sessionId)) {
    fail("INVALID_SESSION", "session UUID is invalid");
  }
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
  };
  writeFileSync(path.join(workDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function publish(workDir) {
  const manifest = JSON.parse(readFileSync(path.join(workDir, "manifest.json"), "utf8"));
  const contract = consumerContract();
  const markdown = [
    "# Codex Handoff",
    "",
    "workflow: handoff-v2",
    `source: ${manifest.sessionId}`,
    "",
    ...resumePolicy(contract),
  ].join("\n");
  const evidenceValue = {
    formatVersion: 1,
    kind: "codex-handoff-evidence-index",
    sessionId: manifest.sessionId,
    source: { sourceRevision: manifest.sourceRevision },
    workspace: {
      cwd: manifest.sourceCwd,
      sourceRevision: digest(Buffer.from(manifest.sourceCwd, "utf8")),
    },
    anchors: [],
    preservationLedger: { exactIdentifiers: [] },
    integrity: { indexDigest: "b".repeat(64) },
    fixtureScenario: "s22-hermetic",
  };
  const evidence = `${JSON.stringify(evidenceValue, null, 2)}\n`;
  const markdownTemporary = `${manifest.outputPath}.s22.tmp`;
  const evidenceTemporary = `${manifest.evidenceIndexPath}.s22.tmp`;
  writeFileSync(markdownTemporary, markdown, { encoding: "utf8", flag: "wx" });
  writeFileSync(evidenceTemporary, evidence, { encoding: "utf8", flag: "wx" });
  renameSync(markdownTemporary, manifest.outputPath);
  renameSync(evidenceTemporary, manifest.evidenceIndexPath);
  const result = {
    formatVersion: 2,
    sessionId: manifest.sessionId,
    outputPath: manifest.outputPath,
    evidenceIndexPath: manifest.evidenceIndexPath,
    sourceRevision: manifest.sourceRevision,
    structuralDigest: digest(Buffer.from(`structure:${manifest.sessionId}`, "utf8")),
    handoffDigest: digest(Buffer.from(markdown, "utf8")),
    evidenceIndexDigest: digest(Buffer.from(evidence, "utf8")),
    consumerContract: contract,
    sourceCwd: manifest.sourceCwd,
    workDir: null,
  };
  rmSync(workDir, { recursive: true, force: true });
  return result;
}

function verifyEvidence(evidencePath) {
  const value = JSON.parse(readFileSync(evidencePath, "utf8"));
  const sourceRevision = value?.source?.sourceRevision;
  if (typeof sourceRevision !== "string") fail("VERIFY_FAILED", "source revision missing");
  return {
    valid: true,
    anchors: 0,
    sourceAnchors: 0,
    workspaceAnchors: 0,
    exactIdentifiers: 0,
    sourceRevision,
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
    if (typeof workDir !== "string" || unknown.length !== 0) {
      fail("INVALID_ARGS", "publish argv invalid");
    }
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
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error.code ?? "ERROR",
    message: error.message,
  })}\n`);
  process.exitCode = 1;
}
