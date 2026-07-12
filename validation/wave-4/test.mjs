#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditValue, validate } from "./validate.mjs";

const SUBJECT = "1".repeat(40);
const HARNESS = "2".repeat(40);
const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "validate.mjs");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function fixture() {
  const registry = {
    baseRequirementId: "DS-01",
    eventId: "R-000001",
    eventKind: "requirement",
    issueRefs: [24],
    recordType: "registry",
    revision: 1,
    schemaVersion: 1,
    semanticKey: "discover.pool.search",
    statement: "Synthetic runtime-only Discover requirement.",
    title: "Synthetic Discover requirement"
  };
  const caseDefinition = {
    action: "Exercise the synthetic runtime-only action.",
    actor: "Synthetic operator",
    applicability: "always",
    baseRequirementId: "DS-01",
    caseId: "DS-01.C001",
    expectedAssertions: [
      { assertionId: "DS-01.C001.A01", statement: "The synthetic observation is deterministic." }
    ],
    issueRefs: [24],
    negativePaths: [
      { expectedAssertionIds: ["DS-01.C001.A01"], negativePathId: "DS-01.C001.N01", trigger: "Synthetic failure is injected." }
    ],
    prerequisites: [],
    recordType: "caseDefinition",
    recovery: ["Reset the synthetic fixture."],
    revision: 1,
    schemaVersion: 1,
    semanticKey: "discover.pool.search.case",
    title: "Synthetic case definition"
  };
  const registryBytes = line(registry);
  const caseBytes = line(caseDefinition);
  const runAttempt = {
    assertionResults: [
      { assertionId: "DS-01.C001.A01", observation: "Synthetic public observation.", outcome: "passed" }
    ],
    attemptId: "A-20260712-001",
    caseId: caseDefinition.caseId,
    caseRevision: caseDefinition.revision,
    definitionSha256: digest(caseBytes),
    ended: "2026-07-12T00:01:00Z",
    environment: {
      browser: "synthetic-browser",
      network: "synthetic-network",
      operatingSystem: "synthetic-os",
      stack: "synthetic-stack",
      wallet: "synthetic-wallet"
    },
    recordType: "runAttempt",
    registryHeadSha256: digest(registryBytes),
    schemaVersion: 1,
    started: "2026-07-12T00:00:00Z",
    subjectCommit: SUBJECT,
    testHarnessCommit: HARNESS
  };
  return { caseDefinition, registry, runAttempt };
}

function retarget(records, baseRequirementId) {
  const domain = baseRequirementId.split("-")[0].toLowerCase();
  records.registry = { ...records.registry, baseRequirementId, semanticKey: `${domain}.synthetic.requirement` };
  delete records.registry.publicAnchorId;
  records.caseDefinition = {
    ...records.caseDefinition,
    baseRequirementId,
    caseId: `${baseRequirementId}.C001`,
    expectedAssertions: [{ assertionId: `${baseRequirementId}.C001.A01`, statement: "Synthetic assertion." }],
    negativePaths: [],
    semanticKey: `${domain}.synthetic.case`
  };
  records.runAttempt = {
    ...records.runAttempt,
    assertionResults: [{ assertionId: `${baseRequirementId}.C001.A01`, observation: "Synthetic observation.", outcome: "passed" }],
    caseId: records.caseDefinition.caseId,
    definitionSha256: digest(line(records.caseDefinition)),
    registryHeadSha256: digest(line(records.registry))
  };
  return records;
}

function refreshDigests(records) {
  records.runAttempt.caseId = records.caseDefinition.caseId;
  records.runAttempt.caseRevision = records.caseDefinition.revision;
  records.runAttempt.definitionSha256 = digest(line(records.caseDefinition));
  records.runAttempt.registryHeadSha256 = digest(line(records.registry));
  return records;
}

function gitRun(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitBuffer(cwd, args, input = undefined) {
  const result = spawnSync("git", args, { cwd, encoding: null, input });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return result.stdout;
}

function nulEntries(buffer) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) entries.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return entries;
}

function replaceTreeEntry(listing, name, objectId) {
  const nameBytes = Buffer.from(name);
  const entries = nulEntries(listing).map((entry) => {
    const tab = entry.indexOf(0x09);
    if (tab >= 0 && entry.subarray(tab + 1).equals(nameBytes)) return Buffer.from(`040000 tree ${objectId}\t${name}`);
    return entry;
  });
  assert(entries.some((entry) => entry.subarray(entry.indexOf(0x09) + 1).equals(nameBytes)));
  return Buffer.concat(entries.flatMap((entry) => [entry, Buffer.from([0])]));
}

async function writeDataset(root, records, { caseText = null, registryText = null, runText = null } = {}) {
  await mkdir(path.join(root, "registry"), { recursive: true });
  await mkdir(path.join(root, "cases"), { recursive: true });
  await mkdir(path.join(root, "runs", "2026"), { recursive: true });
  await writeFile(path.join(root, "registry", "events.jsonl"), registryText ?? line(records.registry));
  const domain = records.caseDefinition.baseRequirementId.split("-")[0].toLowerCase();
  await writeFile(path.join(root, "cases", `${domain}.jsonl`), caseText ?? line(records.caseDefinition));
  await writeFile(path.join(root, "runs", "2026", `${records.runAttempt.attemptId}.json`), runText ?? `${JSON.stringify(records.runAttempt)}\n`);
}

async function writeRunSet(root, records, runs) {
  await writeDataset(root, records);
  const runsRoot = path.join(root, "runs", "2026");
  await rm(runsRoot, { force: true, recursive: true });
  await mkdir(runsRoot, { recursive: true });
  for (const run of runs) await writeFile(path.join(runsRoot, `${run.attemptId}.json`), `${JSON.stringify(run)}\n`);
}

async function expectInvalid(root, mutate, expectedCode) {
  const records = fixture();
  mutate(records);
  const directory = path.join(root, `invalid-${expectInvalid.sequence++}`);
  await writeDataset(directory, records);
  const first = await validate(["--strict", "--json", directory]);
  const second = await validate(["--strict", "--json", directory]);
  assert.equal(first.ok, false, `expected ${expectedCode}`);
  assert(first.errors.some((entry) => entry.code === expectedCode), `missing ${expectedCode}: ${JSON.stringify(first.errors)}`);
  assert.deepEqual(first, second, "validation diagnostics must be deterministic");
}
expectInvalid.sequence = 0;

const root = await mkdtemp(path.join(tmpdir(), "wave4-foundation-"));
try {
  const valid = path.join(root, "valid");
  await writeDataset(valid, fixture());
  const accepted = await validate(["--strict", "--json", valid]);
  assert.deepEqual(accepted, {
    authority: "syntax-only",
    errors: [],
    ok: true,
    recordCounts: { caseDefinition: 1, registry: 1, runAttempt: 1 },
    strict: true
  });

  await expectInvalid(root, ({ registry }) => { registry.subjectCommit = SUBJECT; }, "CLOSED_OBJECT");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.subjectCommit = SUBJECT; }, "CLOSED_OBJECT");
  await expectInvalid(root, ({ runAttempt }) => { delete runAttempt.subjectCommit; }, "REQUIRED");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.recordCommit = SUBJECT; }, "RECORD_COMMIT");
  await expectInvalid(root, ({ registry }) => { registry.eventKind = "provenance"; registry.provenanceLabel = "legacy-domain:DS-03"; registry.disposition = "non-resolving"; }, "CLOSED_OBJECT");
  await expectInvalid(root, ({ registry }) => { registry.resolvesTo = "legacy-domain:DS-data-state"; }, "CLOSED_OBJECT");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.caseId = "DS-01-001"; }, "STRING_FORMAT");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.baseRequirementId = "PW-01"; }, "CASE_PARENT");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.status = "passed"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.evidence = []; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.result = "passed"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.artifacts = []; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.definitionSha256 = "3".repeat(64); }, "DEFINITION_DIGEST");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.registryHeadSha256 = "4".repeat(64); }, "REGISTRY_DIGEST");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.assertionResults = []; }, "TYPE_ARRAY");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.assertionResults[0].assertionId = "DS-01.C001.A99"; }, "ASSERTION_COVERAGE");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.ended = runAttempt.started; }, "TIME_ORDER");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.supersedesAttemptId = "A-20260711-001"; }, "SUPERSEDES_PAIR");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.cookie = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.apiKey = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.api_key = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.extensionDump = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.localStorage = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.environment.browserProfile = "synthetic"; }, "PRIVATE_OR_AGGREGATE_FIELD");
  await expectInvalid(root, ({ registry }) => { registry.statement = "password=synthetic"; }, "PRIVATE_VALUE");
  await expectInvalid(root, ({ registry }) => { registry.statement = "/home/synthetic/profile"; }, "PRIVATE_PATH");
  await expectInvalid(root, ({ registry }) => { Object.defineProperty(registry, "__proto__", { enumerable: true, value: {} }); }, "PROTOTYPE_KEY");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.subjectCommit = "0".repeat(40); }, "ZERO_COMMIT");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.testHarnessCommit = "0".repeat(40); }, "ZERO_COMMIT");

  const proseBypasses = [
    [(records) => { records.registry.title = "Bearer abc.def.ghi"; }, "PRIVATE_VALUE"],
    [(records) => { records.registry.statement = "Overall requirements passed"; }, "AGGREGATE_CLAIM"],
    [(records) => { records.caseDefinition.title = "Evidence is complete"; }, "AGGREGATE_CLAIM"],
    [(records) => { records.caseDefinition.actor = "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.prerequisites = ["api-key=synthetic"]; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.action = "Requirement status: passed"; }, "AGGREGATE_CLAIM"],
    [(records) => { records.caseDefinition.expectedAssertions[0].statement = `0x${"a".repeat(64)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.negativePaths[0].trigger = "Open C:/private/profile"; }, "PRIVATE_PATH"],
    [(records) => { records.caseDefinition.recovery = ["cookie: synthetic"]; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.assertionResults[0].observation = "Bearer abc.def.ghi"; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.reason = "Evidence: synthetic"; }, "AGGREGATE_CLAIM"],
    [(records) => { records.registry.statement = `ghp_${"a".repeat(36)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.action = `gho_${"b".repeat(36)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.actor = `ghu_${"c".repeat(36)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.title = `ghs_${"d".repeat(36)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.recovery = [`ghr_${"e".repeat(36)}`]; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.environment.stack = `github_pat_${"A".repeat(30)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.environment.network = "https://operator:credential@example.invalid/rpc"; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.assertionResults[0].observation = `sk-${"f".repeat(32)}`; }, "PRIVATE_VALUE"],
    [(records) => { records.registry.statement = "-----BEGIN PRIVATE KEY-----"; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.action = "-----BEGIN RSA PRIVATE KEY-----"; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.assertionResults[0].observation = "-----BEGIN EC PRIVATE KEY-----"; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.environment.stack = "-----BEGIN OPENSSH PRIVATE KEY-----"; }, "PRIVATE_VALUE"],
    [(records) => { records.caseDefinition.title = "-----BEGIN ENCRYPTED PRIVATE KEY-----"; }, "PRIVATE_VALUE"],
    [(records) => { records.runAttempt.assertionResults[0].observation = "-----BEGIN PGP PRIVATE KEY BLOCK-----"; }, "PRIVATE_VALUE"]
  ];
  for (const [mutate, expectedCode] of proseBypasses) await expectInvalid(root, mutate, expectedCode);
  for (const privatePath of ["~/profile", "$HOME/profile", "%USERPROFILE%/profile", "\\\\server\\profile"]) {
    await expectInvalid(root, ({ registry }) => { registry.statement = privatePath; }, "PRIVATE_PATH");
  }

  const legitimateProse = fixture();
  legitimateProse.registry.statement = "The selected token route remains explicit and public.";
  legitimateProse.caseDefinition.action = "Compare the token pair and route without making an aggregate claim.";
  legitimateProse.runAttempt.assertionResults[0].observation = "The public token route label was visible.";
  refreshDigests(legitimateProse);
  const legitimateDirectory = path.join(root, "legitimate-prose");
  await writeDataset(legitimateDirectory, legitimateProse);
  assert.equal((await validate(["--strict", "--json", legitimateDirectory])).ok, true, "legitimate token and route prose must not trigger privacy checks");

  const withProvenance = fixture();
  const provenanceEvent = {
    disposition: "non-resolving",
    eventId: "R-000002",
    eventKind: "provenance",
    provenanceLabel: "legacy-domain:DS-data-state",
    recordType: "registry",
    schemaVersion: 1
  };
  const provenanceDirectory = path.join(root, "provenance");
  await writeDataset(provenanceDirectory, withProvenance, { registryText: `${line(withProvenance.registry)}${line(provenanceEvent)}` });
  assert.equal((await validate(["--strict", "--json", provenanceDirectory])).ok, true, "a historical requirement head remains valid after provenance is appended");
  const provenanceFinal = fixture();
  provenanceFinal.runAttempt.registryHeadSha256 = digest(`${line(provenanceFinal.registry)}${line(provenanceEvent)}`);
  const provenanceFinalDirectory = path.join(root, "provenance-final-head");
  await writeDataset(provenanceFinalDirectory, provenanceFinal, { registryText: `${line(provenanceFinal.registry)}${line(provenanceEvent)}` });
  assert.equal((await validate(["--strict", "--json", provenanceFinalDirectory])).ok, true, "every physical provenance-final prefix must carry forward adopted requirements as an exact registry head");
  const provenanceFirst = fixture();
  provenanceFirst.runAttempt.registryHeadSha256 = digest(`${line(provenanceEvent)}${line(provenanceFirst.registry)}`);
  const provenanceFirstDirectory = path.join(root, "provenance-first-head");
  await writeDataset(provenanceFirstDirectory, provenanceFirst, { registryText: `${line(provenanceEvent)}${line(provenanceFirst.registry)}` });
  assert.equal((await validate(["--strict", "--json", provenanceFirstDirectory])).ok, true, "a later requirement head must include an earlier provenance prefix and the adopted requirement");
  await expectInvalid(root, (records) => {
    records.caseDefinition.baseRequirementId = "legacy-domain:DS-data-state";
    records.caseDefinition.caseId = "legacy-domain:DS-data-state.C001";
  }, "STRING_FORMAT");

  const supersessionRecords = fixture();
  const firstAttempt = structuredClone(supersessionRecords.runAttempt);
  const secondAttempt = {
    ...structuredClone(firstAttempt),
    attemptId: "A-20260712-002",
    ended: "2026-07-12T00:03:00Z",
    reason: "Repeats the same case after the prior attempt ended.",
    started: "2026-07-12T00:02:00Z",
    supersedesAttemptId: firstAttempt.attemptId
  };
  const validSupersession = path.join(root, "valid-supersession");
  await writeRunSet(validSupersession, supersessionRecords, [firstAttempt, secondAttempt]);
  assert.equal((await validate(["--strict", "--json", validSupersession])).ok, true);

  const selfAttempt = { ...structuredClone(firstAttempt), reason: "Invalid self reference.", supersedesAttemptId: firstAttempt.attemptId };
  const selfSupersession = path.join(root, "self-supersession");
  await writeRunSet(selfSupersession, supersessionRecords, [selfAttempt]);
  const selfResult = await validate(["--strict", "--json", selfSupersession]);
  assert(selfResult.errors.some((entry) => entry.code === "SUPERSEDES_SELF"));
  assert(selfResult.errors.some((entry) => entry.code === "SUPERSEDES_CYCLE"));

  const futureFirst = { ...structuredClone(firstAttempt), reason: "Invalid future reference.", supersedesAttemptId: secondAttempt.attemptId };
  const futureSecond = structuredClone(secondAttempt);
  delete futureSecond.reason;
  delete futureSecond.supersedesAttemptId;
  const futureSupersession = path.join(root, "future-supersession");
  await writeRunSet(futureSupersession, supersessionRecords, [futureFirst, futureSecond]);
  assert((await validate(["--strict", "--json", futureSupersession])).errors.some((entry) => entry.code === "SUPERSEDES_ORDER"));

  const crossCaseAttempt = { ...structuredClone(secondAttempt), caseId: "DS-01.C999" };
  const crossCaseSupersession = path.join(root, "cross-case-supersession");
  await writeRunSet(crossCaseSupersession, supersessionRecords, [firstAttempt, crossCaseAttempt]);
  assert((await validate(["--strict", "--json", crossCaseSupersession])).errors.some((entry) => entry.code === "SUPERSEDES_CASE"));

  const twoCycleFirst = { ...structuredClone(firstAttempt), reason: "Cycle one.", supersedesAttemptId: secondAttempt.attemptId };
  const twoCycleSecond = { ...structuredClone(secondAttempt), reason: "Cycle two.", supersedesAttemptId: firstAttempt.attemptId };
  const twoCycle = path.join(root, "two-cycle-supersession");
  await writeRunSet(twoCycle, supersessionRecords, [twoCycleFirst, twoCycleSecond]);
  assert((await validate(["--strict", "--json", twoCycle])).errors.some((entry) => entry.code === "SUPERSEDES_CYCLE"));

  const longCycleAttempts = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(firstAttempt),
    attemptId: `A-20260712-${String(index + 1).padStart(3, "0")}`,
    ended: `2026-07-12T00:${String(index).padStart(2, "0")}:30Z`,
    reason: "Long-cycle adversarial fixture.",
    started: `2026-07-12T00:${String(index).padStart(2, "0")}:00Z`,
    supersedesAttemptId: `A-20260712-${String((index + 1) % 20 + 1).padStart(3, "0")}`
  }));
  const longCycle = path.join(root, "long-cycle-supersession");
  await writeRunSet(longCycle, supersessionRecords, longCycleAttempts);
  assert((await validate(["--strict", "--json", longCycle])).errors.some((entry) => entry.code === "SUPERSEDES_CYCLE"));

  await expectInvalid(root, ({ registry }) => { registry.revision = 2; }, "REVISION_SEQUENCE");
  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.revision = 2; }, "REVISION_SEQUENCE");

  const revisioned = fixture();
  const secondCaseRevision = { ...revisioned.caseDefinition, revision: 2, title: "Synthetic case definition revision two" };
  const revisionDirectory = path.join(root, "case-revisions");
  await writeDataset(revisionDirectory, revisioned, { caseText: `${line(revisioned.caseDefinition)}${line(secondCaseRevision)}` });
  assert.equal((await validate(["--strict", "--json", revisionDirectory])).ok, true, "contiguous case revisions in one shard must validate");

  const crossShard = path.join(root, "cross-shard");
  await writeDataset(crossShard, revisioned);
  await writeFile(path.join(crossShard, "cases", "ds-extra.jsonl"), line(secondCaseRevision));
  assert((await validate(["--strict", "--json", crossShard])).errors.some((entry) => entry.code === "CASE_SHARD"));

  const wrongShard = path.join(root, "wrong-shard");
  await writeDataset(wrongShard, fixture());
  await rename(path.join(wrongShard, "cases", "ds.jsonl"), path.join(wrongShard, "cases", "pw.jsonl"));
  assert((await validate(["--strict", "--json", wrongShard])).errors.some((entry) => entry.code === "CASE_SHARD"));

  for (const sidecar of [".matrix.swp", "events.jsonl.bak", "authority.status", "matrix.shadow", "events.sig"]) {
    const unexpected = path.join(root, `unexpected-${sidecar.replaceAll(/[^a-z]/g, "-")}`);
    await mkdir(unexpected, { recursive: true });
    await writeFile(path.join(unexpected, sidecar), "synthetic\n");
    await assert.rejects(() => validate(["--strict", "--json", unexpected]), /unexpected file below the authority root/);
  }

  const ds03 = retarget(fixture(), "DS-03");
  const ds03Directory = path.join(root, "ds-03-compatible");
  await writeDataset(ds03Directory, ds03);
  assert.equal((await validate(["--strict", "--json", ds03Directory])).ok, true, "canonical DS-03 remains an ordinary Discover requirement");

  const duplicateKeyDirectory = path.join(root, "duplicate-json-key");
  const duplicateKeyRecords = fixture();
  const duplicatedRegistry = line(duplicateKeyRecords.registry).replace('"eventId":"R-000001"', '"eventId":"R-000001","eventId":"R-000009"');
  await writeDataset(duplicateKeyDirectory, duplicateKeyRecords, { registryText: duplicatedRegistry });
  assert((await validate(["--strict", "--json", duplicateKeyDirectory])).errors.some((entry) => entry.code === "DUPLICATE_JSON_KEY"));

  const malformedUtf8Variants = [
    Buffer.from([0x80]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80])
  ];
  for (const [index, invalidBytes] of malformedUtf8Variants.entries()) {
    const directory = path.join(root, `invalid-utf8-${index}`);
    await mkdir(path.join(directory, "registry"), { recursive: true });
    await writeFile(path.join(directory, "registry", "events.jsonl"), Buffer.concat([Buffer.from('{"recordType":"registry","statement":"'), invalidBytes, Buffer.from('"}\n')]));
    const invalidUtf8 = await validate(["--strict", "--json", directory]);
    assert(invalidUtf8.errors.some((entry) => entry.code === "INVALID_UTF8"));
    assert(!JSON.stringify(invalidUtf8).includes("�"));
  }

  await expectInvalid(root, ({ caseDefinition }) => { caseDefinition.negativePaths[0].expectedAssertionIds = ["legacy-domain:DS-data-state"]; }, "ASSERTION_REFERENCE");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.caseId = "legacy-domain:DS-data-state"; }, "STRING_FORMAT");
  await expectInvalid(root, ({ runAttempt }) => { runAttempt.assertionResults[0].assertionId = "legacy-domain:DS-data-state"; }, "ASSERTION_COVERAGE");
  await expectInvalid(root, ({ registry }) => { registry.issueRefs = Array.from({ length: 1_001 }, (_, index) => index + 1); }, "MAX_REFERENCES");

  const tooManyLines = path.join(root, "too-many-lines");
  await mkdir(path.join(tooManyLines, "registry"), { recursive: true });
  await writeFile(path.join(tooManyLines, "registry", "events.jsonl"), "{}\n".repeat(10_001));
  assert((await validate(["--strict", "--json", tooManyLines])).errors.some((entry) => entry.code === "MAX_LINES"));

  const tooLarge = path.join(root, "too-large");
  await mkdir(path.join(tooLarge, "registry"), { recursive: true });
  await writeFile(path.join(tooLarge, "registry", "events.jsonl"), "x".repeat(1_048_577));
  await assert.rejects(() => validate(["--strict", "--json", tooLarge]), /file size limit exceeded/);

  const aggregateTooLarge = path.join(root, "aggregate-too-large");
  await mkdir(path.join(aggregateTooLarge, "cases"), { recursive: true });
  for (let index = 0; index < 5; index += 1) await writeFile(path.join(aggregateTooLarge, "cases", `ds-${index}.jsonl`), "x".repeat(900_000));
  await assert.rejects(() => validate(["--strict", "--json", aggregateTooLarge]), /aggregate size limit exceeded/);

  const fifoDirectory = path.join(root, "nonregular");
  await mkdir(fifoDirectory, { recursive: true });
  const fifo = spawnSync("mkfifo", [path.join(fifoDirectory, "authority.jsonl")]);
  if (fifo.status === 0) await assert.rejects(() => validate(["--strict", "--json", fifoDirectory]), /nonregular files are forbidden/);

  const diagnosticCap = path.join(root, "diagnostic-cap");
  await mkdir(path.join(diagnosticCap, "registry"), { recursive: true });
  await writeFile(path.join(diagnosticCap, "registry", "events.jsonl"), "{}\n".repeat(300));
  const capped = await validate(["--strict", "--json", diagnosticCap]);
  assert(capped.errors.length <= 200);
  assert.equal(capped.errors.filter((entry) => entry.code === "DIAGNOSTICS_TRUNCATED").length, 1);
  assert(Buffer.byteLength(JSON.stringify(capped)) < 262_144);

  const recordCap = path.join(root, "record-cap");
  await mkdir(path.join(recordCap, "registry"), { recursive: true });
  await mkdir(path.join(recordCap, "cases"), { recursive: true });
  const registryLines = [];
  for (let revision = 1; revision <= 2_000; revision += 1) registryLines.push(line({ ...fixture().registry, eventId: `R-${String(revision).padStart(6, "0")}`, revision }));
  await writeFile(path.join(recordCap, "registry", "events.jsonl"), registryLines.join(""));
  await writeFile(path.join(recordCap, "cases", "ds.jsonl"), line(fixture().caseDefinition));
  assert((await validate(["--strict", "--json", recordCap])).errors.some((entry) => entry.code === "MAX_RECORDS"));

  const g04 = fixture();
  g04.registry = { ...g04.registry, baseRequirementId: "G-04", issueRefs: [23], publicAnchorId: "G-04", semanticKey: "global.stack.health" };
  g04.caseDefinition = { ...g04.caseDefinition, baseRequirementId: "G-04", caseId: "G-04.C001", semanticKey: "global.stack.health.case" };
  g04.caseDefinition.expectedAssertions = [{ assertionId: "G-04.C001.A01", statement: "Synthetic anchor assertion." }];
  g04.caseDefinition.negativePaths = [];
  g04.runAttempt = { ...g04.runAttempt, caseId: "G-04.C001", definitionSha256: digest(line(g04.caseDefinition)), registryHeadSha256: digest(line(g04.registry)) };
  g04.runAttempt.assertionResults = [{ assertionId: "G-04.C001.A01", observation: "Synthetic public observation.", outcome: "passed" }];
  const anchored = path.join(root, "anchored");
  await writeDataset(anchored, g04);
  assert.equal((await validate(["--strict", "--json", anchored])).ok, true);
  for (const baseRequirementId of ["G-01", "G-02", "G-03", "G-05", "G-06", "G-07", "G-09"]) {
    const ordinary = retarget(fixture(), baseRequirementId);
    const directory = path.join(root, `ordinary-${baseRequirementId.toLowerCase()}`);
    await writeDataset(directory, ordinary);
    assert.equal((await validate(["--strict", "--json", directory])).ok, true, `${baseRequirementId} must be adoptable without a public anchor`);
  }
  await expectInvalid(root, (records) => {
    retarget(records, "G-04");
    records.registry.publicAnchorId = "G-04";
    records.registry.issueRefs = [22];
  }, "PUBLIC_ANCHOR");
  await expectInvalid(root, (records) => {
    retarget(records, "G-08");
    records.registry.publicAnchorId = "G-04";
    records.registry.issueRefs = [23];
  }, "PUBLIC_ANCHOR");

  const cyclic = {};
  cyclic.self = cyclic;
  assert(auditValue(cyclic).some((entry) => entry.code === "CYCLE"));
  let deep = {};
  const deepRoot = deep;
  for (let index = 0; index < 40; index += 1) { deep.next = {}; deep = deep.next; }
  assert(auditValue(deepRoot).some((entry) => entry.code === "MAX_DEPTH"));
  assert(auditValue("x".repeat(70_000)).some((entry) => entry.code === "MAX_STRING"));

  const base = path.join(root, "base");
  const current = path.join(root, "current");
  const baseRecords = fixture();
  await writeDataset(base, baseRecords);
  const secondRegistry = { ...baseRecords.registry, eventId: "R-000002", revision: 2, statement: "Synthetic appended revision." };
  await writeDataset(current, baseRecords, { registryText: `${line(baseRecords.registry)}${line(secondRegistry)}` });
  assert.equal((await validate(["--strict", "--json", "--base", base, current])).ok, true, "exact JSONL prefixes and immutable runs may be extended");

  const rewritten = path.join(root, "rewritten");
  await writeDataset(rewritten, baseRecords, { registryText: line({ ...baseRecords.registry, title: "Rewritten" }) });
  assert((await validate(["--strict", "--json", "--base", base, rewritten])).errors.some((entry) => entry.code === "APPEND_ONLY_PREFIX"));

  const runChanged = path.join(root, "run-changed");
  await writeDataset(runChanged, baseRecords, { runText: `${JSON.stringify({ ...baseRecords.runAttempt, ended: "2026-07-12T00:02:00Z" })}\n` });
  assert((await validate(["--strict", "--json", "--base", base, runChanged])).errors.some((entry) => entry.code === "APPEND_ONLY_RUN"));

  const deleted = path.join(root, "deleted");
  await mkdir(deleted, { recursive: true });
  assert((await validate(["--strict", "--json", "--base", base, deleted])).errors.some((entry) => entry.code === "APPEND_ONLY_DELETE"));

  const malformed = path.join(root, "malformed");
  await writeDataset(malformed, fixture(), { caseText: "{not-json}\n" });
  assert((await validate(["--strict", "--json", malformed])).errors.some((entry) => entry.code === "INVALID_JSON"));

  const linked = path.join(root, "linked");
  await mkdir(linked, { recursive: true });
  await symlink(path.join(valid, "registry"), path.join(linked, "registry"));
  await assert.rejects(() => validate(["--strict", "--json", linked]), /symlinks are forbidden/);

  const repository = path.join(root, "git-repository");
  await mkdir(repository, { recursive: true });
  gitRun(repository, ["init", "-b", "main"]);
  gitRun(repository, ["config", "user.email", "synthetic@example.invalid"]);
  gitRun(repository, ["config", "user.name", "Synthetic Validator"]);
  await writeFile(path.join(repository, "seed.txt"), "synthetic\n");
  gitRun(repository, ["add", "seed.txt"]);
  gitRun(repository, ["commit", "-m", "older code"]);
  const olderCommit = gitRun(repository, ["rev-parse", "HEAD"]);
  const repositoryRecords = fixture();
  const repositoryAuthority = path.join(repository, "validation", "wave-4");
  await writeDataset(repositoryAuthority, repositoryRecords);
  await rm(path.join(repositoryAuthority, "runs"), { force: true, recursive: true });
  gitRun(repository, ["add", "validation/wave-4"]);
  gitRun(repository, ["commit", "-m", "protected base authority"]);
  const protectedBase = gitRun(repository, ["rev-parse", "HEAD"]);
  repositoryRecords.runAttempt.subjectCommit = protectedBase;
  repositoryRecords.runAttempt.testHarnessCommit = protectedBase;
  await writeDataset(repositoryAuthority, repositoryRecords);
  gitRun(repository, ["add", "validation/wave-4"]);
  gitRun(repository, ["commit", "-m", "run-only candidate"]);
  const runCandidate = gitRun(repository, ["rev-parse", "HEAD"]);

  const packageValidate = (...args) => spawnSync("pnpm", ["wave4:validate", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const trustedPackageSuccess = packageValidate("--repository", repository, "--expected-subject-commit", protectedBase, "--candidate-commit", runCandidate, "--base-git-ref", protectedBase, repositoryAuthority);
  assert.equal(trustedPackageSuccess.status, 0, trustedPackageSuccess.stdout);
  assert.equal(JSON.parse(trustedPackageSuccess.stdout.split("\n").find((entry) => entry.startsWith("{"))).authority, "repository-bound");

  const enclosingSubjectRecords = structuredClone(repositoryRecords);
  enclosingSubjectRecords.runAttempt.subjectCommit = runCandidate;
  await writeDataset(repositoryAuthority, enclosingSubjectRecords);
  const enclosingSubjectResult = packageValidate("--repository", repository, "--expected-subject-commit", protectedBase, "--candidate-commit", runCandidate, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(enclosingSubjectResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "EXPECTED_COMMIT"), "self-referential enclosing candidate commit must fail");
  const olderSubjectRecords = structuredClone(repositoryRecords);
  olderSubjectRecords.runAttempt.subjectCommit = olderCommit;
  await writeDataset(repositoryAuthority, olderSubjectRecords);
  const olderSubjectResult = packageValidate("--repository", repository, "--expected-subject-commit", protectedBase, "--candidate-commit", runCandidate, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(olderSubjectResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "EXPECTED_COMMIT"), "older or unrelated commits must fail protected-base binding");
  await writeDataset(repositoryAuthority, repositoryRecords);

  await writeFile(path.join(repository, "unrelated.txt"), "not authority\n");
  gitRun(repository, ["add", "unrelated.txt"]);
  gitRun(repository, ["commit", "-m", "coexisting non-authority change"]);
  const coexistingCandidate = gitRun(repository, ["rev-parse", "HEAD"]);
  const coexistingResult = packageValidate("--repository", repository, "--expected-subject-commit", protectedBase, "--candidate-commit", coexistingCandidate, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(coexistingResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "RUN_COEXISTING_CHANGE"));

  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(repository, ".github", "workflows", "wave4-authority.yml"), "name: synthetic trusted workflow\n");
  await writeFile(path.join(repositoryAuthority, "validate.mjs"), "process.exitCode = 1;\n");
  gitRun(repository, ["add", ".github/workflows/wave4-authority.yml", "validation/wave-4/validate.mjs"]);
  gitRun(repository, ["commit", "-m", "synthetic trust root"]);
  const trustBase = gitRun(repository, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repositoryAuthority, "validate.mjs"), "process.exitCode = 0;\n");
  gitRun(repository, ["add", "validation/wave-4/validate.mjs"]);
  gitRun(repository, ["commit", "-m", "unconditional validator success"]);
  const validatorChange = gitRun(repository, ["rev-parse", "HEAD"]);
  const validatorTrustResult = packageValidate("--repository", repository, "--expected-subject-commit", trustBase, "--candidate-commit", validatorChange, "--base-git-ref", trustBase, repositoryAuthority);
  assert(JSON.parse(validatorTrustResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "TRUST_ROOT_CHANGE"));

  await writeFile(path.join(repository, ".github", "workflows", "wave4-authority.yml"), "name: changed status context\n");
  gitRun(repository, ["add", ".github/workflows/wave4-authority.yml"]);
  gitRun(repository, ["commit", "-m", "change trusted status context"]);
  const workflowChange = gitRun(repository, ["rev-parse", "HEAD"]);
  const workflowTrustResult = packageValidate("--repository", repository, "--expected-subject-commit", trustBase, "--candidate-commit", workflowChange, "--base-git-ref", trustBase, repositoryAuthority);
  assert(JSON.parse(workflowTrustResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "TRUST_ROOT_CHANGE"));

  await rm(path.join(repositoryAuthority, "validate.mjs"));
  await chmod(path.join(repository, ".github", "workflows", "wave4-authority.yml"), 0o755);
  gitRun(repository, ["add", ".github/workflows/wave4-authority.yml", "validation/wave-4/validate.mjs"]);
  gitRun(repository, ["commit", "-m", "delete and mode-change trust root"]);
  const deletedTrustRoot = gitRun(repository, ["rev-parse", "HEAD"]);
  const deletionTrustResult = packageValidate("--repository", repository, "--expected-subject-commit", trustBase, "--candidate-commit", deletedTrustRoot, "--base-git-ref", trustBase, repositoryAuthority);
  assert(JSON.parse(deletionTrustResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "TRUST_ROOT_CHANGE"));

  const rewrittenRecords = fixture();
  rewrittenRecords.runAttempt.subjectCommit = protectedBase;
  rewrittenRecords.runAttempt.testHarnessCommit = protectedBase;
  rewrittenRecords.registry.title = "Rewritten authority";
  refreshDigests(rewrittenRecords);
  await writeDataset(repositoryAuthority, rewrittenRecords);
  const mutationResult = packageValidate("--repository", repository, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(mutationResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "APPEND_ONLY_PREFIX"));

  await writeDataset(repositoryAuthority, repositoryRecords);
  await rm(path.join(repositoryAuthority, "registry", "events.jsonl"));
  const deletionResult = packageValidate("--repository", repository, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(deletionResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "APPEND_ONLY_DELETE"));

  await writeDataset(repositoryAuthority, repositoryRecords);
  const editedRun = { ...repositoryRecords.runAttempt, ended: "2026-07-12T00:02:00Z" };
  await writeFile(path.join(repositoryAuthority, "runs", "2026", `${editedRun.attemptId}.json`), `${JSON.stringify(editedRun)}\n`);
  const runEditResult = packageValidate("--repository", repository, "--base-git-ref", runCandidate, repositoryAuthority);
  assert(JSON.parse(runEditResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "APPEND_ONLY_RUN"));

  gitRun(repository, ["add", "validation/wave-4"]);
  gitRun(repository, ["commit", "-m", "preserve synthetic edited run"]);
  gitRun(repository, ["checkout", "-B", "reorder-base", protectedBase]);
  await writeDataset(repositoryAuthority, repositoryRecords);
  await rm(path.join(repositoryAuthority, "runs"), { force: true, recursive: true });
  const secondRegistryLine = { ...repositoryRecords.registry, eventId: "R-000002", revision: 2, statement: "Second registry revision." };
  await writeFile(path.join(repositoryAuthority, "registry", "events.jsonl"), `${line(repositoryRecords.registry)}${line(secondRegistryLine)}`);
  gitRun(repository, ["add", "validation/wave-4"]);
  gitRun(repository, ["commit", "-m", "append registry revision"]);
  const orderedCommit = gitRun(repository, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repositoryAuthority, "registry", "events.jsonl"), `${line(secondRegistryLine)}${line(repositoryRecords.registry)}`);
  const reorderResult = packageValidate("--repository", repository, "--base-git-ref", orderedCommit, repositoryAuthority);
  assert(JSON.parse(reorderResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "APPEND_ONLY_PREFIX"));

  const unknownCommitRecords = fixture();
  unknownCommitRecords.runAttempt.subjectCommit = "3".repeat(40);
  unknownCommitRecords.runAttempt.testHarnessCommit = protectedBase;
  await writeDataset(repositoryAuthority, unknownCommitRecords);
  const unknownCommitResult = packageValidate("--repository", repository, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(unknownCommitResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "SUBJECT_COMMIT"));

  const blobCommitRecords = fixture();
  const blobId = gitRun(repository, ["hash-object", "-w", "seed.txt"]);
  blobCommitRecords.runAttempt.subjectCommit = blobId;
  blobCommitRecords.runAttempt.testHarnessCommit = protectedBase;
  await writeDataset(repositoryAuthority, blobCommitRecords);
  const blobCommitResult = packageValidate("--repository", repository, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(blobCommitResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "SUBJECT_COMMIT"));

  const badHarnessRecords = fixture();
  badHarnessRecords.runAttempt.subjectCommit = protectedBase;
  badHarnessRecords.runAttempt.testHarnessCommit = blobId;
  await writeDataset(repositoryAuthority, badHarnessRecords);
  const badHarnessResult = packageValidate("--repository", repository, "--base-git-ref", protectedBase, repositoryAuthority);
  assert(JSON.parse(badHarnessResult.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors.some((entry) => entry.code === "HARNESS_COMMIT"), "harness commit is independently required to be a repository commit");

  const unknownExpected = packageValidate("--repository", repository, "--expected-subject-commit", "4".repeat(40), "--candidate-commit", runCandidate, "--base-git-ref", protectedBase, repositoryAuthority);
  assert.equal(JSON.parse(unknownExpected.stdout.split("\n").find((entry) => entry.startsWith("{"))).errors[0].code, "CLI_OR_INPUT");

  const attributeRepository = path.join(root, "attribute-repository");
  await mkdir(attributeRepository, { recursive: true });
  gitRun(attributeRepository, ["init", "-b", "main"]);
  gitRun(attributeRepository, ["config", "user.email", "synthetic@example.invalid"]);
  gitRun(attributeRepository, ["config", "user.name", "Synthetic Validator"]);
  const attributeAuthority = path.join(attributeRepository, "validation", "wave-4");
  const attributeRecords = fixture();
  await writeDataset(attributeAuthority, attributeRecords);
  await writeFile(path.join(attributeRepository, ".gitattributes"), "validation/wave-4/** export-ignore export-subst\n");
  gitRun(attributeRepository, ["add", "."]);
  gitRun(attributeRepository, ["commit", "-m", "root attributes adversary"]);
  const rootAttributesCommit = gitRun(attributeRepository, ["rev-parse", "HEAD"]);
  const ignoredArchive = spawnSync("git", ["archive", "--format=tar", rootAttributesCommit, "validation/wave-4"], { cwd: attributeRepository, encoding: null });
  assert.equal(ignoredArchive.status, 0);
  const ignoredListing = spawnSync("tar", ["-tf", "-"], { encoding: "utf8", input: ignoredArchive.stdout });
  assert(!ignoredListing.stdout.includes("registry/events.jsonl"), "root export-ignore demonstrates why candidate git archive is forbidden");
  assert.equal((await validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", rootAttributesCommit, attributeAuthority])).ok, true, "ls-tree/cat-file validation must ignore root archive attributes");

  await writeFile(path.join(attributeRepository, ".gitattributes"), "validation/wave-4/registry/events.jsonl export-subst\n");
  attributeRecords.registry.statement = "Literal $Format:%H$ must remain unexpanded authority data.";
  refreshDigests(attributeRecords);
  await writeDataset(attributeAuthority, attributeRecords);
  gitRun(attributeRepository, ["add", "."]);
  gitRun(attributeRepository, ["commit", "-m", "export substitution adversary"]);
  const substitutionCommit = gitRun(attributeRepository, ["rev-parse", "HEAD"]);
  const substitutionArchive = spawnSync("git", ["archive", "--format=tar", substitutionCommit, "validation/wave-4/registry/events.jsonl"], { cwd: attributeRepository, encoding: null });
  const substitutedBody = spawnSync("tar", ["-xOf", "-", "validation/wave-4/registry/events.jsonl"], { encoding: "utf8", input: substitutionArchive.stdout });
  assert(!substitutedBody.stdout.includes("$Format:%H$"), "export-subst mutates archive bytes");
  assert(gitRun(attributeRepository, ["show", `${substitutionCommit}:validation/wave-4/registry/events.jsonl`]).includes("$Format:%H$"));
  assert.equal((await validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", substitutionCommit, attributeAuthority])).ok, true, "cat-file must preserve exact unsubstituted blob bytes");

  await writeFile(path.join(attributeAuthority, ".gitattributes"), "* export-ignore export-subst\n");
  gitRun(attributeRepository, ["add", "validation/wave-4/.gitattributes"]);
  gitRun(attributeRepository, ["commit", "-m", "subtree attributes adversary"]);
  const subtreeAttributesCommit = gitRun(attributeRepository, ["rev-parse", "HEAD"]);
  await assert.rejects(() => validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", subtreeAttributesCommit, valid]), /unexpected file below the authority root/);

  gitRun(attributeRepository, ["checkout", "-B", "mode-adversary", substitutionCommit]);
  await chmod(path.join(attributeAuthority, "registry", "events.jsonl"), 0o755);
  gitRun(attributeRepository, ["add", "validation/wave-4/registry/events.jsonl"]);
  gitRun(attributeRepository, ["commit", "-m", "executable authority mode adversary"]);
  const modeCommit = gitRun(attributeRepository, ["rev-parse", "HEAD"]);
  await assert.rejects(() => validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", modeCommit, valid]), /unsupported mode or type/);

  gitRun(attributeRepository, ["checkout", "-B", "invalid-blob-adversary", substitutionCommit]);
  await writeFile(path.join(attributeAuthority, "registry", "events.jsonl"), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d, 0x0a]));
  gitRun(attributeRepository, ["add", "validation/wave-4/registry/events.jsonl"]);
  gitRun(attributeRepository, ["commit", "-m", "invalid UTF-8 blob adversary"]);
  const invalidBlobCommit = gitRun(attributeRepository, ["rev-parse", "HEAD"]);
  const invalidGitBlob = await validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", invalidBlobCommit, valid]);
  assert(invalidGitBlob.errors.some((entry) => entry.code === "INVALID_UTF8"));
  assert(!JSON.stringify(invalidGitBlob).includes("�"));

  const invalidPathBlob = gitBuffer(attributeRepository, ["hash-object", "-w", "--stdin"], Buffer.from("{}\n")).toString("ascii").trim();
  const casesTree = gitRun(attributeRepository, ["rev-parse", `${substitutionCommit}:validation/wave-4/cases`]);
  const casesEntries = nulEntries(gitBuffer(attributeRepository, ["ls-tree", "-z", casesTree]));
  const invalidCaseEntry = Buffer.concat([Buffer.from(`100644 blob ${invalidPathBlob}\tinvalid-`), Buffer.from([0x80]), Buffer.from(".jsonl")]);
  const invalidCasesInput = Buffer.concat([...casesEntries, invalidCaseEntry].flatMap((entry) => [entry, Buffer.from([0])]));
  const invalidCasesTree = gitBuffer(attributeRepository, ["mktree", "-z"], invalidCasesInput).toString("ascii").trim();
  const waveTree = gitRun(attributeRepository, ["rev-parse", `${substitutionCommit}:validation/wave-4`]);
  const invalidWaveTree = gitBuffer(attributeRepository, ["mktree", "-z"], replaceTreeEntry(gitBuffer(attributeRepository, ["ls-tree", "-z", waveTree]), "cases", invalidCasesTree)).toString("ascii").trim();
  const validationTree = gitRun(attributeRepository, ["rev-parse", `${substitutionCommit}:validation`]);
  const invalidValidationTree = gitBuffer(attributeRepository, ["mktree", "-z"], replaceTreeEntry(gitBuffer(attributeRepository, ["ls-tree", "-z", validationTree]), "wave-4", invalidWaveTree)).toString("ascii").trim();
  const rootTree = gitRun(attributeRepository, ["rev-parse", `${substitutionCommit}^{tree}`]);
  const invalidRootTree = gitBuffer(attributeRepository, ["mktree", "-z"], replaceTreeEntry(gitBuffer(attributeRepository, ["ls-tree", "-z", rootTree]), "validation", invalidValidationTree)).toString("ascii").trim();
  const invalidPathCommit = gitBuffer(attributeRepository, ["commit-tree", invalidRootTree, "-p", substitutionCommit], Buffer.from("invalid UTF-8 path adversary\n")).toString("ascii").trim();
  await assert.rejects(() => validate(["--strict", "--json", "--repository", attributeRepository, "--base-git-ref", invalidPathCommit, valid]), /git tree paths must be well-formed UTF-8/);

  const leaked = fixture();
  leaked.registry.password = "never-echo-this-value";
  const noEcho = path.join(root, "no-echo");
  await writeDataset(noEcho, leaked);
  const cliFailureA = spawnSync(process.execPath, [validator, "--strict", "--json", noEcho], { encoding: "utf8" });
  const cliFailureB = spawnSync(process.execPath, [validator, "--strict", "--json", noEcho], { encoding: "utf8" });
  assert.equal(cliFailureA.status, 1);
  assert.equal(cliFailureA.stdout, cliFailureB.stdout);
  assert(!cliFailureA.stdout.includes("never-echo-this-value"));
  assert.deepEqual(JSON.parse(cliFailureA.stdout).ok, false);

  for (const [index, privateValue] of [
    `ghp_${"z".repeat(36)}`,
    `github_pat_${"Y".repeat(30)}`,
    "https://operator:credential@example.invalid/rpc",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----"
  ].entries()) {
    const privateRecords = fixture();
    privateRecords.registry.statement = privateValue;
    const privateDirectory = path.join(root, `non-echo-private-${index}`);
    await writeDataset(privateDirectory, privateRecords);
    const privateCli = spawnSync(process.execPath, [validator, "--strict", "--json", privateDirectory], { encoding: "utf8" });
    assert.equal(privateCli.status, 1);
    assert(!privateCli.stdout.includes(privateValue));
  }

  const cliSuccess = spawnSync(process.execPath, [validator, "--strict", "--json", valid], { encoding: "utf8" });
  assert.equal(cliSuccess.status, 0);
  assert.deepEqual(JSON.parse(cliSuccess.stdout), { ok: true, strict: true, authority: "syntax-only", recordCounts: { caseDefinition: 1, registry: 1, runAttempt: 1 }, errors: [] });

  const trustedWorkflow = await readFile(path.resolve(here, "../../.github/workflows/wave4-authority.yml"), "utf8");
  assert.match(trustedWorkflow, /pull_request_target:/);
  assert.match(trustedWorkflow, /contents: read\s+statuses: write/);
  assert.doesNotMatch(trustedWorkflow, /actions\/checkout@|git checkout|git archive/);
  assert.match(trustedWorkflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6/);
  assert.match(trustedWorkflow, /package-manager-cache: false/);
  assert.doesNotMatch(trustedWorkflow, /candidate-checkout|allow-unsafe-pr-checkout/);
  assert.match(trustedWorkflow, /fetch --no-tags --no-write-fetch-head --depth=1 --filter=blob:limit=1048577/);
  assert.doesNotMatch(trustedWorkflow, /fetch-depth:\s*0/);
  assert.match(trustedWorkflow, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(trustedWorkflow, /GIT_CONFIG_GLOBAL="\$EMPTY_GIT_CONFIG"/);
  assert.match(trustedWorkflow, /core\.hooksPath "\$EMPTY_HOOKS"/);
  assert.match(trustedWorkflow, /GIT_NO_LAZY_FETCH=1/);
  assert.match(trustedWorkflow, /ls-tree -rz --full-tree --long/);
  assert.match(trustedWorkflow, /read -r -d '' entry/);
  assert.match(trustedWorkflow, /test "\$object_mode" = '100644'/);
  assert.match(trustedWorkflow, /test "\$count" -le 10000/);
  assert.match(trustedWorkflow, /test "\$aggregate_bytes" -le 4194304/);
  assert.match(trustedWorkflow, /cat-file blob/);
  assert.match(trustedWorkflow, /set -o noclobber/);
  assert(trustedWorkflow.indexOf('test "$aggregate_bytes" -le 4194304') < trustedWorkflow.indexOf('mkdir -p "$(dirname "$output_path")"'), "the complete subtree must be bounded before any candidate path is written");
  assert.match(trustedWorkflow, /rev-parse "\$CURRENT_SHA\^\{commit\}"/);
  assert.match(trustedWorkflow, /statuses\/\$CURRENT_SHA/);
  assert.doesNotMatch(trustedWorkflow, /statuses\/\$BASE_SHA/);
  assert.match(trustedWorkflow, /wave4\/append-only-authority/);
  assert.match(trustedWorkflow, /post_pr_status pending/);
  assert.match(trustedWorkflow, /post_pr_status success/);
  assert.match(trustedWorkflow, /post_pr_status failure/);
  assert.match(trustedWorkflow, /--expected-subject-commit "\$BASE_SHA" --candidate-commit "\$CURRENT_SHA"/);
  assert.match(trustedWorkflow, /node "\$BASE_VALIDATOR"/);
  assert.match(trustedWorkflow, /git -C "\$TRUSTED_REPO" diff --quiet "\$BASE_SHA" "\$CURRENT_SHA" --[\s\S]*\.github\/workflows\/wave4-authority\.yml[\s\S]*validation\/wave-4\/validate\.mjs/);
  assert.doesNotMatch(trustedWorkflow, /(?:node|eval|source|\.\s+)\s+"?\$CURRENT_(?:TREE|SHA)/);
  assert.doesNotMatch(trustedWorkflow, /\b(?:npm|pnpm|yarn)\b/);
  assert.doesNotMatch(trustedWorkflow, /actions\/(?:cache|download-artifact|upload-artifact)/);
  assert.doesNotMatch(trustedWorkflow, /secrets\./);
  assert.doesNotMatch(trustedWorkflow, /reviewed-bootstrap|bootstrap.*ok/i);

  console.log("Wave 4 matrix validator tests passed.");
} finally {
  await rm(root, { force: true, recursive: true });
}
