#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixtureRelativePath = "test/fixtures/s17/app-server-0.146.0-schema-projection.json";
const fixturePath = path.join(repoRoot, fixtureRelativePath);
const contractPath = path.join(repoRoot, "contracts", "slices", "S17.json");
const reportRelativePath = "artifacts/s17/schema-projection-report.json";
const receiptRelativePath = "artifacts/s17/completion-receipt.json";
const expectedCliVersion = "0.146.0";
const maximumOutputBytes = 64 * 1024 * 1024;
const selectedThreadItemTypes = [
  "agentMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
];

class CodexBinaryUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexBinaryUnavailableError";
  }
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(relativePath, payload) {
  const target = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function corpusDigest(directory) {
  const hash = createHash("sha256");
  const files = listFiles(directory);
  for (const filePath of files) {
    hash.update(normalizeRepoPath(path.relative(directory, filePath)), "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(filePath));
    hash.update("\0", "utf8");
  }
  return { fileCount: files.length, digest: `sha256:${hash.digest("hex")}` };
}

function resolveNpm(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli === undefined) throw new Error("npm-cli.js could not be located without a command shell.");
  return { command: process.execPath, args: [npmCli, ...args] };
}

function runCommand(argv, options = {}) {
  const [requestedCommand, ...requestedArgs] = argv;
  if (requestedCommand === undefined) throw new Error("Cannot run an empty argv array.");
  const executable = requestedCommand === "npm"
    ? resolveNpm(requestedArgs)
    : { command: requestedCommand, args: requestedArgs };
  const result = spawnSync(executable.command, executable.args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}${
    result.error === undefined ? "" : `${result.error.name}: ${result.error.message}\n`
  }`;
  return {
    argv,
    exitCode: result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1),
    stderr,
    stdout,
  };
}

function codexInvocationFromPath(candidate) {
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return null;
  const resolved = realpathSync(candidate);
  if (path.extname(resolved).toLocaleLowerCase("en-US") === ".js") {
    return {
      command: process.execPath,
      prefixArgs: [resolved],
      identityPath: resolved,
      launcherPath: realpathSync(process.execPath),
    };
  }
  return {
    command: resolved,
    prefixArgs: [],
    identityPath: resolved,
    launcherPath: resolved,
  };
}

function resolveCodexInvocation() {
  const override = process.env.AUTO_SLICE_S17_CODEX_CLI;
  if (override !== undefined && override.length > 0) {
    const invocation = codexInvocationFromPath(path.resolve(override));
    if (invocation === null) {
      throw new CodexBinaryUnavailableError(
        `AUTO_SLICE_S17_CODEX_CLI does not identify a file: ${override}`,
      );
    }
    return invocation;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const packageCandidates = [
    ...pathEntries.map((entry) => path.join(entry, "node_modules", "@openai", "codex", "bin", "codex.js")),
    path.join(path.dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
  for (const candidate of packageCandidates) {
    const invocation = codexInvocationFromPath(candidate);
    if (invocation !== null) return invocation;
  }

  const nativeNames = process.platform === "win32" ? ["codex.exe"] : ["codex"];
  for (const directory of pathEntries) {
    for (const name of nativeNames) {
      const invocation = codexInvocationFromPath(path.join(directory, name));
      if (invocation !== null) return invocation;
    }
  }
  throw new CodexBinaryUnavailableError("Codex CLI could not be resolved from PATH without a shell.");
}

function runCodex(invocation, args, timeoutMs = 120_000) {
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stderr = `${result.stderr ?? ""}${
    result.error === undefined ? "" : `${result.error.name}: ${result.error.message}\n`
  }`;
  const exitCode = result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1);
  if (exitCode !== 0) {
    throw new Error(`Codex CLI ${args.join(" ")} failed (${String(exitCode)}): ${stderr}`);
  }
  return (result.stdout ?? "").trim();
}

function extractStringUnion(source, typeName) {
  const declaration = source.match(new RegExp(`export type ${typeName} = ([^;]+);`, "u"));
  if (declaration?.[1] === undefined) throw new Error(`Could not parse generated ${typeName}.`);
  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function extractUnionVariantSource(source, type) {
  const marker = `{ "type": "${type}"`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Generated union is missing ${type}.`);
  const next = source.indexOf(" } | { \"type\":", start + marker.length);
  const end = next < 0 ? source.lastIndexOf(" };") + 2 : next + 2;
  if (end <= start) throw new Error(`Could not isolate generated union variant ${type}.`);
  return source.slice(start, end);
}

function extractObjectSource(source, typeName) {
  const marker = `export type ${typeName} = {`;
  const start = source.indexOf(marker);
  const end = source.lastIndexOf(" };");
  if (start < 0 || end <= start) throw new Error(`Could not isolate generated object ${typeName}.`);
  return source.slice(start + `export type ${typeName} = `.length, end + 2);
}

function topLevelFields(source) {
  const cleaned = source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/\/\/.*$/gmu, " ");
  const fields = [];
  let depth = 0;
  let index = 0;
  while (index < cleaned.length) {
    const character = cleaned[index];
    if (character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth !== 1) {
      index += 1;
      continue;
    }
    const remainder = cleaned.slice(index);
    const match = remainder.match(/^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(\?)?\s*:/u);
    if (match === null) {
      index += 1;
      continue;
    }
    const name = match[1] ?? match[2];
    if (name !== undefined && !fields.some((field) => field.name === name)) {
      fields.push({ name, required: match[3] !== "?" });
    }
    index += match[0].length;
  }
  return fields;
}

function requiredTsFields(source) {
  return topLevelFields(source).filter((field) => field.required).map((field) => field.name);
}

function sortedStrings(value) {
  return [...(Array.isArray(value) ? value : [])].map(String).sort();
}

function schemaVariantSummaries(definition) {
  if (!Array.isArray(definition?.oneOf)) throw new Error("Expected a JSON Schema oneOf definition.");
  return definition.oneOf.map((variant) => {
    const type = variant?.properties?.type?.enum?.[0];
    if (typeof type !== "string") throw new Error("JSON Schema variant lacks a string type discriminant.");
    const defaults = Object.fromEntries(
      Object.entries(variant.properties ?? {})
        .filter(([, propertySchema]) => Object.hasOwn(propertySchema, "default"))
        .map(([name, propertySchema]) => [name, propertySchema.default]),
    );
    return {
      type,
      jsonRequired: sortedStrings(variant.required),
      defaults: canonicalize(defaults),
    };
  });
}

function ensureSame(label, left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs between generated TypeScript and JSON Schema.`);
  }
}

function collectProjection(tsRoot, jsonRoot, cliVersion) {
  const tsV2 = path.join(tsRoot, "v2");
  const jsonV2 = path.join(jsonRoot, "v2");
  const readTs = (name, root = tsV2) => readFileSync(path.join(root, name), "utf8");
  const readSchema = (name) => parseJsonFile(path.join(jsonV2, name));

  const threadStartParamsSchema = readSchema("ThreadStartParams.json");
  const threadStartResponseSchema = readSchema("ThreadStartResponse.json");
  const threadReadParamsSchema = readSchema("ThreadReadParams.json");
  const threadReadResponseSchema = readSchema("ThreadReadResponse.json");
  const skillsParamsSchema = readSchema("SkillsListParams.json");
  const skillsSchema = readSchema("SkillsListResponse.json");
  const turnStartParamsSchema = readSchema("TurnStartParams.json");
  const itemStartedSchema = readSchema("ItemStartedNotification.json");
  const itemCompletedSchema = readSchema("ItemCompletedNotification.json");
  const turnCompletedSchema = readSchema("TurnCompletedNotification.json");

  const sandboxModesTs = extractStringUnion(readTs("SandboxMode.ts"), "SandboxMode");
  const sandboxModesJson = threadStartParamsSchema.definitions.SandboxMode.enum;
  ensureSame("ThreadStartParams.sandbox modes", sandboxModesTs, sandboxModesJson);

  const userInputTs = readTs("UserInput.ts");
  const userInputJson = schemaVariantSummaries(turnStartParamsSchema.definitions.UserInput);
  const userInputTypesTs = userInputJson.map(({ type }) => {
    extractUnionVariantSource(userInputTs, type);
    return type;
  });
  ensureSame("TurnStartParams.UserInput variants", userInputTypesTs, userInputJson.map(({ type }) => type));

  const sandboxPolicyTs = readTs("SandboxPolicy.ts");
  const sandboxPolicyJson = schemaVariantSummaries(turnStartParamsSchema.definitions.SandboxPolicy);
  const sandboxPolicyTypesTs = sandboxPolicyJson.map(({ type }) => {
    extractUnionVariantSource(sandboxPolicyTs, type);
    return type;
  });
  ensureSame(
    "TurnStartParams.sandboxPolicy variants",
    sandboxPolicyTypesTs,
    sandboxPolicyJson.map(({ type }) => type),
  );

  const threadItemTs = readTs("ThreadItem.ts");
  const threadItemJson = schemaVariantSummaries(itemCompletedSchema.definitions.ThreadItem);
  const threadItemTypesTs = [
    ...threadItemTs.matchAll(/\{ "type": "([^"]+)"/gu),
  ].map((match) => match[1]);
  ensureSame("ThreadItem variants", threadItemTypesTs, threadItemJson.map(({ type }) => type));

  const selectedItems = selectedThreadItemTypes.map((type) => {
    const json = threadItemJson.find((variant) => variant.type === type);
    if (json === undefined) throw new Error(`Generated ThreadItem is missing selected variant ${type}.`);
    const typescriptRequired = type === "webSearch"
      ? [
          "type",
          ...requiredTsFields(extractObjectSource(readTs("WebSearchItem.ts", tsRoot), "WebSearchItem")),
        ]
      : requiredTsFields(extractUnionVariantSource(threadItemTs, type));
    return {
      ...json,
      typescriptRequired,
    };
  });

  const threadTs = extractObjectSource(readTs("Thread.ts"), "Thread");
  const turnTs = extractObjectSource(readTs("Turn.ts"), "Turn");
  const skillTs = extractObjectSource(readTs("SkillMetadata.ts"), "SkillMetadata");

  const turnStatusesTs = extractStringUnion(readTs("TurnStatus.ts"), "TurnStatus");
  const turnStatusesJson = turnCompletedSchema.definitions.TurnStatus.enum;
  ensureSame("Turn statuses", turnStatusesTs, turnStatusesJson);

  return {
    schemaVersion: 1,
    codexCliVersion: cliVersion,
    officialFacts: ["https://developers.openai.com/codex/app-server/"],
    generationCommands: [
      "codex app-server generate-ts --experimental --out <temp>/ts",
      "codex app-server generate-json-schema --experimental --out <temp>/json",
    ],
    threadStart: {
      jsonRequired: sortedStrings(threadStartParamsSchema.required),
      sandboxModes: sandboxModesTs,
      threadResponseJsonRequired: sortedStrings(threadStartResponseSchema.required),
      threadJsonRequired: sortedStrings(threadStartResponseSchema.definitions.Thread.required),
      projectedThreadTypescriptRequired: requiredTsFields(threadTs).filter((field) =>
        ["id", "sessionId", "forkedFromId", "parentThreadId", "ephemeral", "turns"].includes(field)
      ),
    },
    threadRead: {
      paramsJsonRequired: sortedStrings(threadReadParamsSchema.required),
      responseJsonRequired: sortedStrings(threadReadResponseSchema.required),
      threadJsonRequired: sortedStrings(threadReadResponseSchema.definitions.Thread.required),
    },
    skillsList: {
      paramsJsonRequired: sortedStrings(skillsParamsSchema.required),
      paramsTypescriptFields: topLevelFields(
        extractObjectSource(readTs("SkillsListParams.ts"), "SkillsListParams"),
      ),
      responseJsonRequired: sortedStrings(skillsSchema.required),
      entryJsonRequired: sortedStrings(skillsSchema.definitions.SkillsListEntry.required),
      metadataJsonRequired: sortedStrings(skillsSchema.definitions.SkillMetadata.required),
      metadataTypescriptRequired: requiredTsFields(skillTs).filter((field) =>
        ["name", "description", "path", "scope", "enabled"].includes(field)
      ),
      scopes: skillsSchema.definitions.SkillScope.enum,
    },
    turnStart: {
      paramsJsonRequired: sortedStrings(turnStartParamsSchema.required),
      userInputVariants: userInputJson.map((variant) => ({
        ...variant,
        typescriptRequired: requiredTsFields(extractUnionVariantSource(userInputTs, variant.type)),
      })),
      sandboxPolicyVariants: sandboxPolicyJson.map((variant) => ({
        ...variant,
        typescriptRequired: requiredTsFields(extractUnionVariantSource(sandboxPolicyTs, variant.type)),
      })),
    },
    notifications: {
      itemStartedJsonRequired: sortedStrings(itemStartedSchema.required),
      itemCompletedJsonRequired: sortedStrings(itemCompletedSchema.required),
      turnCompletedJsonRequired: sortedStrings(turnCompletedSchema.required),
    },
    threadItems: {
      knownDiscriminants: threadItemJson.map(({ type }) => type),
      selected: selectedItems,
      commandStatuses: extractStringUnion(readTs("CommandExecutionStatus.ts"), "CommandExecutionStatus"),
      commandSources: extractStringUnion(readTs("CommandExecutionSource.ts"), "CommandExecutionSource"),
      patchStatuses: extractStringUnion(readTs("PatchApplyStatus.ts"), "PatchApplyStatus"),
      toolStatuses: extractStringUnion(readTs("McpToolCallStatus.ts"), "McpToolCallStatus"),
      collabTools: extractStringUnion(readTs("CollabAgentTool.ts"), "CollabAgentTool"),
      subAgentActivityKinds: extractStringUnion(
        readTs("SubAgentActivityKind.ts"),
        "SubAgentActivityKind",
      ),
    },
    turnCompleted: {
      turnJsonRequired: sortedStrings(turnCompletedSchema.definitions.Turn.required),
      turnTypescriptRequired: requiredTsFields(turnTs),
      statuses: turnStatusesTs,
      itemViews: extractStringUnion(readTs("TurnItemsView.ts"), "TurnItemsView"),
    },
  };
}

function generateProjection() {
  const invocation = resolveCodexInvocation();
  const versionOutput = runCodex(invocation, ["--version"]);
  const versionMatch = versionOutput.match(/^codex-cli\s+(\S+)$/u);
  if (versionMatch?.[1] !== expectedCliVersion) {
    throw new Error(
      `S17 requires codex-cli ${expectedCliVersion}; resolved ${JSON.stringify(versionOutput)}.`,
    );
  }

  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s17-schema-"));
  const tsRoot = path.join(temporaryRoot, "ts");
  const jsonRoot = path.join(temporaryRoot, "json");
  try {
    runCodex(invocation, ["app-server", "generate-ts", "--experimental", "--out", tsRoot]);
    runCodex(invocation, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      jsonRoot,
    ]);
    const projection = collectProjection(tsRoot, jsonRoot, expectedCliVersion);
    return {
      projection,
      corpus: {
        typescript: corpusDigest(tsRoot),
        jsonSchema: corpusDigest(jsonRoot),
      },
      cli: {
        version: expectedCliVersion,
        versionOutput,
        identityPath: normalizeRepoPath(invocation.identityPath),
        identityDigest: sha256File(invocation.identityPath),
        launcherPath: normalizeRepoPath(invocation.launcherPath),
        launcherDigest: sha256File(invocation.launcherPath),
      },
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyFixture(projection) {
  if (!existsSync(fixturePath)) throw new Error(`S17 fixture is missing: ${fixtureRelativePath}`);
  const fixture = parseJsonFile(fixturePath);
  const fixtureProjectionDigest = sha256Bytes(Buffer.from(canonicalJson(fixture.projection), "utf8"));
  if (
    fixture?.schema_version !== 1 ||
    typeof fixture.projection_digest !== "string" ||
    fixture.projection_digest !== fixtureProjectionDigest
  ) {
    throw new Error("S17 projection fixture has an invalid self-digest.");
  }
  const actualDigest = sha256Bytes(Buffer.from(canonicalJson(projection), "utf8"));
  if (actualDigest !== fixture.projection_digest || canonicalJson(projection) !== canonicalJson(fixture.projection)) {
    throw new Error(
      `App Server schema projection drifted: expected ${fixture.projection_digest}, got ${actualDigest}.`,
    );
  }
  return { fixture, projectionDigest: actualDigest };
}

function runChecks() {
  const checks = [
    { id: "build", argv: ["npm", "run", "build"], timeoutMs: 120_000 },
    { id: "typecheck", argv: ["npm", "run", "typecheck"], timeoutMs: 120_000 },
    {
      id: "target_test",
      argv: ["node", "--test", "dist/test/app-server-protocol-v2.test.js"],
      timeoutMs: 180_000,
    },
    { id: "test", argv: ["npm", "run", "test"], timeoutMs: 300_000 },
    { id: "lint", argv: ["npm", "run", "lint"], timeoutMs: 120_000 },
    { id: "plugin_validation", argv: ["npm", "run", "validate:plugin"], timeoutMs: 120_000 },
    { id: "markdown_links", argv: ["npm", "run", "verify:markdown-links"], timeoutMs: 120_000 },
    { id: "diff_check", argv: ["git", "diff", "HEAD", "--check", "--"], timeoutMs: 120_000 },
  ];
  return checks.map((check) => {
    const result = runCommand(check.argv, { timeoutMs: check.timeoutMs });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`S17 deterministic check ${check.id} failed with exit ${String(result.exitCode)}.`);
    }
    return { check_id: check.id, argv: check.argv, exit_code: result.exitCode };
  });
}

function expandOwnedPaths(contract) {
  const paths = [];
  for (const ownedPath of contract.owned_paths ?? []) {
    if (typeof ownedPath !== "string") throw new Error("S17 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) => normalizeRepoPath(path.relative(repoRoot, filePath))));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S17 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(generated, projectionDigest, checks) {
  const report = {
    schema_version: 1,
    slice_id: "S17",
    result: "PASS",
    codex_cli: generated.cli,
    generation: {
      commands: generated.projection.generationCommands,
      typescript_corpus: generated.corpus.typescript,
      json_schema_corpus: generated.corpus.jsonSchema,
    },
    projection: {
      fixture_path: fixtureRelativePath,
      fixture_digest: sha256File(fixturePath),
      projection_digest: projectionDigest,
    },
    official_facts: generated.projection.officialFacts,
    negative_contracts: [
      "thread sandbox casing",
      "turn sandbox policy casing",
      "text_elements required",
      "workspaceWrite temp exclusions required",
      "skill item required",
      "ambiguous or disabled skill rejected",
      "fresh turns empty",
      "completed command evidence required",
      "unknown required ThreadItem variant rejected",
    ],
  };
  writeJsonAtomic(reportRelativePath, report);

  const contract = parseJsonFile(contractPath);
  if (contract?.id !== "S17" || contract.contract_version !== 1) {
    throw new Error("contracts/slices/S17.json is not the expected SliceSpec v1.");
  }
  const outputDigests = expandOwnedPaths(contract)
    .filter((relativePath) => relativePath !== receiptRelativePath)
    .map((relativePath) => ({ path: relativePath, digest: sha256File(path.join(repoRoot, relativePath)) }));
  const receipt = {
    schema_version: 1,
    slice_id: "S17",
    result: "PASS",
    contract_digest: sha256File(contractPath),
    projection_digest: projectionDigest,
    output_digests: outputDigests,
    check_receipts: checks,
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  return { report, receipt };
}

function main() {
  const schemaOnly = process.argv.includes("--schema-only");
  const unitTest = process.argv.includes("--unit-test");
  const printProjection = process.argv.includes("--print-projection");
  let generated;
  try {
    generated = generateProjection();
  } catch (error) {
    if (unitTest && error instanceof CodexBinaryUnavailableError) {
      process.stdout.write(`S17_SCHEMA_PROJECTION_SKIP ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (printProjection) {
    const projectionDigest = sha256Bytes(Buffer.from(canonicalJson(generated.projection), "utf8"));
    process.stdout.write(`${JSON.stringify({
      schema_version: 1,
      projection_digest: projectionDigest,
      projection: generated.projection,
    }, null, 2)}\n`);
    return;
  }

  const { projectionDigest } = verifyFixture(generated.projection);
  if (schemaOnly) {
    process.stdout.write(`S17_SCHEMA_PROJECTION_PASS ${projectionDigest}\n`);
    return;
  }

  if (!existsSync(contractPath)) throw new Error("contracts/slices/S17.json is missing.");
  const checks = runChecks();
  const evidence = writeEvidence(generated, projectionDigest, checks);
  process.stdout.write(`S17_SCHEMA_PROJECTION_PASS ${projectionDigest}\n`);
  process.stdout.write(`S17_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S17 CompletionReceipt: ${receiptRelativePath}\n`);
  return evidence;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
