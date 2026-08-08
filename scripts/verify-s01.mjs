#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S01.json");
const receiptRelativePath = "artifacts/s01/completion-receipt.json";
const snapshotRelativePath = "artifacts/s01/frozen-contracts.json";
const maximumOutputBytes = 32 * 1024 * 1024;

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(relativePath, payload) {
  const target = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function resolveEnvironment(allowlist) {
  const environment = {};
  for (const requestedName of allowlist) {
    const actualName = Object.keys(process.env).find(
      (candidate) => candidate.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US"),
    );
    if (actualName !== undefined && process.env[actualName] !== undefined) {
      environment[actualName] = process.env[actualName];
    }
  }
  return environment;
}

function resolveExecutable(command, args) {
  if (command === "npm") {
    const npmCandidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    const npmCli = npmCandidates.find((candidate) => existsSync(candidate));
    if (npmCli !== undefined) {
      return { command: process.execPath, args: [npmCli, ...args] };
    }
    throw new Error("npm-cli.js could not be located without invoking a command shell.");
  }
  return { command, args };
}

function runCommand(argv, options = {}) {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("Cannot run an empty argv array.");
  }
  const executable = resolveExecutable(command, args);
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(executable.command, executable.args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const stdout = result.stdout ?? "";
  const errorText = result.error === undefined ? "" : `${result.error.name}: ${result.error.message}\n`;
  const stderr = `${result.stderr ?? ""}${errorText}`;
  const exitCode = result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1);

  return {
    argv,
    durationMs,
    exitCode,
    stderr,
    stdout,
  };
}

function runGit(args) {
  const result = runCommand(["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseNullSeparated(value) {
  return value.split("\0").filter((entry) => entry.length > 0).map(normalizeRepoPath);
}

function collectTouchedPaths(baseRevision) {
  const tracked = parseNullSeparated(runGit(["diff", "--name-only", "-z", baseRevision, "--"]));
  const untracked = parseNullSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function isS01OwnedPath(relativePath) {
  const exactPaths = new Set([
    ".codex-plugin/plugin.json",
    ".gitattributes",
    ".gitignore",
    "docs/架构.md",
    "docs/代码链路.md",
    "eslint.config.mjs",
    "package-lock.json",
    "package.json",
    "tsconfig.build.json",
    "tsconfig.json",
  ]);
  const prefixes = ["artifacts/s01/", "contracts/", "scripts/", "src/", "test/"];
  return exactPaths.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
}

function validateSliceSpec(sliceSpec) {
  if (sliceSpec?.id !== "S01" || sliceSpec.contract_version !== 1) {
    throw new Error("contracts/slices/S01.json is not a SliceSpec v1 for S01.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S01 SliceSpec must contain inputs and checks arrays.");
  }

  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S01 input entries must contain path and digest strings.");
    }
    const actualDigest = sha256File(path.join(repoRoot, input.path));
    if (actualDigest !== input.digest) {
      throw new Error(`Frozen input digest changed for ${input.path}.`);
    }
  }
}

function runChecks(sliceSpec) {
  const receipts = [];
  let failed = false;

  for (const check of sliceSpec.checks) {
    if (
      typeof check?.id !== "string" ||
      !Array.isArray(check.argv) ||
      check.argv.some((entry) => typeof entry !== "string") ||
      typeof check.cwd !== "string" ||
      typeof check.timeout_ms !== "number" ||
      !Array.isArray(check.env_allowlist) ||
      typeof check.expected_exit_code !== "number"
    ) {
      throw new Error("S01 contains an invalid CheckSpec.");
    }

    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);

    const missingArtifacts = (check.expected_artifacts ?? []).filter(
      (artifact) => typeof artifact !== "string" || !existsSync(path.join(repoRoot, artifact)),
    );
    if (result.exitCode !== check.expected_exit_code || missingArtifacts.length > 0) {
      failed = true;
      if (missingArtifacts.length > 0) {
        process.stderr.write(`Check ${check.id} is missing artifacts: ${missingArtifacts.join(", ")}\n`);
      }
    }

    receipts.push({
      check_id: check.id,
      argv: check.argv,
      exit_code: result.exitCode,
      stdout_digest: sha256Bytes(Buffer.from(result.stdout, "utf8")),
      stderr_digest: sha256Bytes(Buffer.from(result.stderr, "utf8")),
      duration_ms: Math.round(result.durationMs),
    });
  }

  if (failed) {
    throw new Error("One or more S01 deterministic checks failed.");
  }
  return receipts;
}

function captureFrozenContracts() {
  const result = runCommand([
    process.execPath,
    "dist/src/controller/main.js",
    "inspect-contracts",
    repoRoot,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Controller contract snapshot failed: ${result.stderr}`);
  }

  const payload = JSON.parse(result.stdout);
  if (payload?.status !== "CONTRACTS_LOADED" || payload.contracts === undefined) {
    throw new Error("Controller returned an invalid FrozenContracts snapshot.");
  }
  return payload.contracts;
}

function verifyCommittedEvidence(sliceSpec, frozenContracts, checkReceipts) {
  const existingSnapshot = parseJsonFile(path.join(repoRoot, snapshotRelativePath));
  if (JSON.stringify(existingSnapshot) !== JSON.stringify(frozenContracts)) {
    throw new Error("The committed FrozenContracts snapshot no longer matches the workspace.");
  }

  const existingReceipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    existingReceipt?.slice_id !== "S01" ||
    existingReceipt.contract_digest !== sha256File(sliceSpecPath) ||
    existingReceipt.owned_diff_digest === undefined
  ) {
    throw new Error("The committed S01 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((receipt) => receipt.check_id);
  const committedCheckIds = existingReceipt.check_receipts?.map((receipt) => receipt.check_id);
  if (JSON.stringify(committedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The committed S01 CompletionReceipt has a different check set.");
  }

  const dirtyS01Paths = collectTouchedPaths("HEAD").filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && isS01OwnedPath(entry),
  );
  if (dirtyS01Paths.length > 0) {
    throw new Error(
      `S01-owned paths changed after its receipt was committed: ${dirtyS01Paths.join(", ")}`,
    );
  }

  process.stdout.write(`S01 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${existingReceipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const checkReceipts = runChecks(sliceSpec);
  const frozenContracts = captureFrozenContracts();
  const startHead = runGit(["rev-list", "--max-parents=0", "HEAD"]).trim();
  const currentHead = runGit(["rev-parse", "HEAD"]).trim();
  const regenerate = process.argv.includes("--regenerate");
  if (currentHead !== startHead && existsSync(path.join(repoRoot, receiptRelativePath)) && !regenerate) {
    verifyCommittedEvidence(sliceSpec, frozenContracts, checkReceipts);
    return;
  }

  writeJsonAtomic(snapshotRelativePath, frozenContracts);

  const touchedBeforeReceipt = collectTouchedPaths(startHead).filter((entry) => entry !== receiptRelativePath);
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS01OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S01 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
  }

  const outputDigests = touchedBeforeReceipt
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S01",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((input) => ({ path: input.path, digest: input.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    check_receipts: checkReceipts,
    start_head: startHead,
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };

  writeJsonAtomic(receiptRelativePath, receipt);
  process.stdout.write(`S01 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
