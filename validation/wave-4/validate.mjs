#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 1_048_576;
const MAX_LINE_BYTES = 131_072;
const MAX_DEPTH = 32;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_STRING_LENGTH = 65_536;
const MAX_PHYSICAL_LINES = 10_000;
const MAX_RECORDS = 2_000;
const MAX_FILES = 10_000;
const MAX_DIAGNOSTICS = 200;
const MAX_TOTAL_BYTES = 4_194_304;
const MAX_REFERENCES = 1_000;
const MAX_OUTPUT_BYTES = 262_144;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE_ID = /^(?:G|[A-Z]{2,3})-[0-9]{2}$/;
const CASE_ID = /^(?:G|[A-Z]{2,3})-[0-9]{2}\.C[0-9]{3}$/;
const ATTEMPT_ID = /^A-[0-9]{8}-[0-9]{3}$/;
const SEMANTIC_KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const LEGACY_PROVENANCE_LABEL = "legacy-domain:DS-data-state";
const PUBLIC_ANCHORS = new Map([["G-04", 23], ["G-08", 22]]);
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\bBasic\s+[A-Za-z0-9+/=]+|authorization\s*:|cookie\s*:|private[_ -]?key\s*[:=]|mnemonic\s*[:=]|seed[_ -]?phrase\s*[:=]|(?:api[_ -]?key|password|secret|token)\s*[:=])/i;
const RAW_SECRET_VALUE = /(?:-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\bglpat-[0-9A-Za-z_-]{20,}\b|\bnpm_[0-9A-Za-z]{20,}\b|\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b|\b[a-z][a-z0-9+.-]*:\/\/[^\s\/@]+@)/i;
const AGGREGATE_CLAIM = /(?:\b(?:aggregate\s+)?(?:requirement\s+)?(?:status|result|evidence)\s*(?:[:=]|is\b)|\b(?:all|overall)\s+(?:requirements?|cases?)\s+(?:passed|failed|blocked)\b)/i;
const LOCAL_PATH = /(?:file:\/\/|(?:^|[\s"'(])(?:\.{2}\/|\/(?!\/)|~\/|\$HOME\/|%USERPROFILE%[\\/]|\\\\[^\\\s]+\\|[A-Za-z]:[\\/]))/i;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RECORD_TYPES = new Set(["registry", "caseDefinition", "runAttempt"]);
const FOUNDATION_FILES = new Set(["README.md", "test.mjs", "validate.mjs"]);
const here = path.dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const truncatedErrorSets = new WeakSet();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function comparison(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes) {
  return utf8Decoder.decode(bytes);
}

function inspectJson(text) {
  let index = 0;
  let duplicate = false;
  let tooDeep = false;
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const parseString = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') break;
    }
    return JSON.parse(text.slice(start, index));
  };
  const parseValue = (depth) => {
    whitespace();
    if (depth > MAX_DEPTH) { tooDeep = true; throw new Error("depth"); }
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        index += 1;
        parseValue(depth + 1);
        whitespace();
        if (text[index++] === "}") return;
      }
    } else if (text[index] === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (index < text.length) {
        parseValue(depth + 1);
        whitespace();
        if (text[index++] === "]") return;
      }
    } else if (text[index] === '"') parseString();
    else while (index < text.length && !/[\s,\]}]/.test(text[index])) index += 1;
  };
  try { parseValue(0); } catch (caught) { if (!tooDeep) throw caught; }
  return { duplicate, tooDeep };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(code, file, line, pointer, message) {
  return { code, file, line, message, pointer };
}

function recordError(errors, diagnostic) {
  if (diagnostic.code === "DIAGNOSTICS_TRUNCATED") {
    if (!truncatedErrorSets.has(errors)) {
      errors.push(error("DIAGNOSTICS_TRUNCATED", "", 0, "", "additional diagnostics were deterministically truncated"));
      truncatedErrorSets.add(errors);
    }
    return;
  }
  if (truncatedErrorSets.has(errors)) return;
  if (errors.length >= MAX_DIAGNOSTICS - 1) {
    errors.push(error("DIAGNOSTICS_TRUNCATED", "", 0, "", "additional diagnostics were deterministically truncated"));
    truncatedErrorSets.add(errors);
    return;
  }
  errors.push(diagnostic);
}

function push(errors, code, item, pointer, message) {
  recordError(errors, error(code, item.layout, item.line, pointer, message));
}

function closed(value, required, optional, item, pointer, errors) {
  if (!isObject(value)) {
    push(errors, "TYPE_OBJECT", item, pointer, "must be an object");
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value).sort(comparison)) {
    if (!allowed.has(key)) push(errors, "CLOSED_OBJECT", item, `${pointer}/${key}`, "unknown property");
  }
  for (const key of [...required].sort(comparison)) {
    if (!Object.hasOwn(value, key)) push(errors, "REQUIRED", item, `${pointer}/${key}`, "required property is missing");
  }
  return true;
}

function string(value, item, pointer, errors, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    push(errors, "TYPE_STRING", item, pointer, "must be a trimmed non-empty string");
    return false;
  }
  if (pattern !== null && !pattern.test(value)) {
    push(errors, "STRING_FORMAT", item, pointer, "has invalid format");
    return false;
  }
  return true;
}

function positiveInteger(value, item, pointer, errors) {
  if (!Number.isSafeInteger(value) || value < 1) {
    push(errors, "TYPE_INTEGER", item, pointer, "must be a positive safe integer");
    return false;
  }
  return true;
}

function commitValue(value, item, pointer, errors) {
  if (!string(value, item, pointer, errors, COMMIT)) return false;
  if (/^0{40}$/.test(value)) {
    push(errors, "ZERO_COMMIT", item, pointer, "zero commit is forbidden");
    return false;
  }
  return true;
}

function stringList(value, item, pointer, errors, { allowEmpty = false, pattern = null } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    push(errors, "TYPE_ARRAY", item, pointer, allowEmpty ? "must be an array" : "must be a non-empty array");
    return false;
  }
  if (value.length > MAX_REFERENCES) push(errors, "MAX_REFERENCES", item, pointer, "reference collection limit exceeded");
  value.forEach((entry, index) => string(entry, item, `${pointer}/${index}`, errors, pattern));
  if (new Set(value).size !== value.length) push(errors, "DUPLICATE", item, pointer, "must not contain duplicates");
  return true;
}

function issueRefs(value, item, pointer, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    push(errors, "TYPE_ARRAY", item, pointer, "must be a non-empty array");
    return false;
  }
  if (value.length > MAX_REFERENCES) push(errors, "MAX_REFERENCES", item, pointer, "reference collection limit exceeded");
  value.forEach((entry, index) => positiveInteger(entry, item, `${pointer}/${index}`, errors));
  if (new Set(value).size !== value.length) push(errors, "DUPLICATE", item, pointer, "must not contain duplicates");
  return true;
}

function common(record, expectedType, item, errors) {
  if (record.schemaVersion !== 1) push(errors, "SCHEMA_VERSION", item, "/schemaVersion", "must equal 1");
  if (record.recordType !== expectedType) push(errors, "RECORD_TYPE", item, "/recordType", `must equal ${expectedType}`);
}

function validateRegistry(record, item, errors) {
  if (record.eventKind === "provenance") {
    const required = ["disposition", "eventId", "eventKind", "provenanceLabel", "recordType", "schemaVersion"];
    const optional = ["issueRefs", "note"];
    if (!closed(record, required, optional, item, "", errors)) return;
    common(record, "registry", item, errors);
    string(record.eventId, item, "/eventId", errors, /^R-[0-9]{6}$/);
    if (record.provenanceLabel !== LEGACY_PROVENANCE_LABEL) push(errors, "LEGACY_ALIAS", item, "/provenanceLabel", "must equal the sole non-resolving legacy provenance label");
    if (record.disposition !== "non-resolving") push(errors, "LEGACY_ALIAS", item, "/disposition", "must equal non-resolving");
    if (Object.hasOwn(record, "note")) string(record.note, item, "/note", errors);
    if (Object.hasOwn(record, "issueRefs")) issueRefs(record.issueRefs, item, "/issueRefs", errors);
    return;
  }
  const required = ["baseRequirementId", "eventId", "eventKind", "issueRefs", "recordType", "revision", "schemaVersion", "semanticKey", "statement", "title"];
  const optional = ["publicAnchorId"];
  if (!closed(record, required, optional, item, "", errors)) return;
  common(record, "registry", item, errors);
  if (record.eventKind !== "requirement") push(errors, "EVENT_KIND", item, "/eventKind", "must equal requirement or use the closed provenance event shape");
  string(record.eventId, item, "/eventId", errors, /^R-[0-9]{6}$/);
  string(record.baseRequirementId, item, "/baseRequirementId", errors, BASE_ID);
  positiveInteger(record.revision, item, "/revision", errors);
  string(record.semanticKey, item, "/semanticKey", errors, SEMANTIC_KEY);
  string(record.title, item, "/title", errors);
  string(record.statement, item, "/statement", errors);
  issueRefs(record.issueRefs, item, "/issueRefs", errors);
  if (Object.hasOwn(record, "publicAnchorId")) {
    string(record.publicAnchorId, item, "/publicAnchorId", errors, /^G-(?:04|08)$/);
    const expectedIssue = PUBLIC_ANCHORS.get(record.publicAnchorId);
    if (record.baseRequirementId !== record.publicAnchorId || expectedIssue === undefined || !Array.isArray(record.issueRefs) || !record.issueRefs.includes(expectedIssue)) {
      push(errors, "PUBLIC_ANCHOR", item, "/publicAnchorId", "must bind G-04 to issue 23 or G-08 to issue 22 on the same base requirement");
    }
  }
}

function validateAssertion(assertion, item, pointer, caseId, errors) {
  const keys = ["assertionId", "statement"];
  if (!closed(assertion, keys, [], item, pointer, errors)) return;
  string(assertion.assertionId, item, `${pointer}/assertionId`, errors, new RegExp(`^${escapeRegex(caseId)}\\.A[0-9]{2}$`));
  string(assertion.statement, item, `${pointer}/statement`, errors);
}

function validateNegativePath(negativePath, item, pointer, caseId, assertionIds, errors) {
  const keys = ["expectedAssertionIds", "negativePathId", "trigger"];
  if (!closed(negativePath, keys, [], item, pointer, errors)) return;
  string(negativePath.negativePathId, item, `${pointer}/negativePathId`, errors, new RegExp(`^${escapeRegex(caseId)}\\.N[0-9]{2}$`));
  string(negativePath.trigger, item, `${pointer}/trigger`, errors);
  if (stringList(negativePath.expectedAssertionIds, item, `${pointer}/expectedAssertionIds`, errors)) {
    negativePath.expectedAssertionIds.forEach((assertionId, index) => {
      if (!assertionIds.has(assertionId)) push(errors, "ASSERTION_REFERENCE", item, `${pointer}/expectedAssertionIds/${index}`, "does not reference an expected assertion in this case");
    });
  }
}

function validateCase(record, item, errors) {
  const required = ["action", "actor", "applicability", "baseRequirementId", "caseId", "expectedAssertions", "issueRefs", "negativePaths", "prerequisites", "recordType", "recovery", "revision", "schemaVersion", "semanticKey", "title"];
  if (!closed(record, required, [], item, "", errors)) return;
  common(record, "caseDefinition", item, errors);
  string(record.baseRequirementId, item, "/baseRequirementId", errors, BASE_ID);
  string(record.caseId, item, "/caseId", errors, CASE_ID);
  if (typeof record.caseId === "string" && typeof record.baseRequirementId === "string" && !record.caseId.startsWith(`${record.baseRequirementId}.C`)) {
    push(errors, "CASE_PARENT", item, "/caseId", "must be a stable child of baseRequirementId");
  }
  positiveInteger(record.revision, item, "/revision", errors);
  string(record.semanticKey, item, "/semanticKey", errors, SEMANTIC_KEY);
  string(record.title, item, "/title", errors);
  string(record.actor, item, "/actor", errors);
  stringList(record.prerequisites, item, "/prerequisites", errors, { allowEmpty: true });
  string(record.action, item, "/action", errors);
  if (!Array.isArray(record.expectedAssertions) || record.expectedAssertions.length === 0) push(errors, "TYPE_ARRAY", item, "/expectedAssertions", "must be a non-empty array");
  else record.expectedAssertions.forEach((assertion, index) => validateAssertion(assertion, item, `/expectedAssertions/${index}`, record.caseId, errors));
  const assertionIds = new Set(Array.isArray(record.expectedAssertions) ? record.expectedAssertions.map((entry) => entry?.assertionId) : []);
  if (Array.isArray(record.expectedAssertions) && assertionIds.size !== record.expectedAssertions.length) push(errors, "DUPLICATE", item, "/expectedAssertions", "assertionId values must be unique");
  if (!Array.isArray(record.negativePaths)) push(errors, "TYPE_ARRAY", item, "/negativePaths", "must be an array");
  else record.negativePaths.forEach((negativePath, index) => validateNegativePath(negativePath, item, `/negativePaths/${index}`, record.caseId, assertionIds, errors));
  if (Array.isArray(record.negativePaths)) {
    const ids = record.negativePaths.map((entry) => entry?.negativePathId);
    if (new Set(ids).size !== ids.length) push(errors, "DUPLICATE", item, "/negativePaths", "negativePathId values must be unique");
  }
  stringList(record.recovery, item, "/recovery", errors, { allowEmpty: true });
  if (!["always", "conditional", "not-applicable"].includes(record.applicability)) push(errors, "APPLICABILITY", item, "/applicability", "must be always, conditional, or not-applicable");
  issueRefs(record.issueRefs, item, "/issueRefs", errors);
}

function validTimestamp(value, item, pointer, errors) {
  if (!string(value, item, pointer, errors)) return false;
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    push(errors, "TIMESTAMP", item, pointer, "must be a valid UTC RFC 3339 timestamp with whole seconds");
    return false;
  }
  return true;
}

function validateEnvironment(environment, item, errors) {
  const keys = ["browser", "network", "operatingSystem", "stack", "wallet"];
  if (!closed(environment, keys, [], item, "/environment", errors)) return;
  keys.forEach((key) => string(environment[key], item, `/environment/${key}`, errors));
}

function validateAssertionResult(result, item, pointer, errors) {
  const keys = ["assertionId", "observation", "outcome"];
  if (!closed(result, keys, [], item, pointer, errors)) return;
  string(result.assertionId, item, `${pointer}/assertionId`, errors);
  if (!["blocked", "failed", "not-applicable", "passed"].includes(result.outcome)) push(errors, "ASSERTION_OUTCOME", item, `${pointer}/outcome`, "must be blocked, failed, not-applicable, or passed");
  string(result.observation, item, `${pointer}/observation`, errors);
}

function validateRun(record, item, errors) {
  const required = ["assertionResults", "attemptId", "caseId", "caseRevision", "definitionSha256", "ended", "environment", "recordType", "registryHeadSha256", "schemaVersion", "started", "subjectCommit", "testHarnessCommit"];
  const optional = ["reason", "supersedesAttemptId"];
  if (!closed(record, required, optional, item, "", errors)) return;
  common(record, "runAttempt", item, errors);
  string(record.attemptId, item, "/attemptId", errors, ATTEMPT_ID);
  string(record.caseId, item, "/caseId", errors, CASE_ID);
  positiveInteger(record.caseRevision, item, "/caseRevision", errors);
  string(record.definitionSha256, item, "/definitionSha256", errors, DIGEST);
  commitValue(record.subjectCommit, item, "/subjectCommit", errors);
  commitValue(record.testHarnessCommit, item, "/testHarnessCommit", errors);
  string(record.registryHeadSha256, item, "/registryHeadSha256", errors, DIGEST);
  const startedValid = validTimestamp(record.started, item, "/started", errors);
  const endedValid = validTimestamp(record.ended, item, "/ended", errors);
  if (startedValid && endedValid && record.started >= record.ended) push(errors, "TIME_ORDER", item, "/ended", "must be later than started");
  validateEnvironment(record.environment, item, errors);
  if (!Array.isArray(record.assertionResults) || record.assertionResults.length === 0) push(errors, "TYPE_ARRAY", item, "/assertionResults", "must be a non-empty array");
  else record.assertionResults.forEach((result, index) => validateAssertionResult(result, item, `/assertionResults/${index}`, errors));
  if (Array.isArray(record.assertionResults)) {
    const ids = record.assertionResults.map((entry) => entry?.assertionId);
    if (new Set(ids).size !== ids.length) push(errors, "DUPLICATE", item, "/assertionResults", "assertionId values must be unique");
  }
  const hasSupersedes = Object.hasOwn(record, "supersedesAttemptId");
  const hasReason = Object.hasOwn(record, "reason");
  if (hasSupersedes !== hasReason) push(errors, "SUPERSEDES_PAIR", item, "", "supersedesAttemptId and reason must be authored together");
  if (hasSupersedes) string(record.supersedesAttemptId, item, "/supersedesAttemptId", errors, ATTEMPT_ID);
  if (hasReason) string(record.reason, item, "/reason", errors);
}

function escapeRegex(value) {
  return typeof value === "string" ? value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "invalid";
}

function forbiddenField(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized === "recordcommit") return "RECORD_COMMIT";
  if (["artifact", "artifacts", "evidence", "evidences", "requirementresult", "requirementstatus", "result", "status"].includes(normalized)) return "PRIVATE_OR_AGGREGATE_FIELD";
  return /(?:apikey|auth|bookmark|browserdata|browserhistory|browserprofile|browserstorage|cookie|credential|download|extension|history|localstorage|mnemonic|password|privatekey|profile|secret|seedphrase|sessionstorage|token)/.test(normalized)
    ? "PRIVATE_OR_AGGREGATE_FIELD"
    : null;
}

function prosePointer(pointer) {
  return /\/(?:action|actor|note|observation|reason|statement|title|trigger)$/.test(pointer) || /\/(?:prerequisites|recovery)\/[0-9]+$/.test(pointer);
}

export function auditValue(value, item = { layout: "record", line: 1 }) {
  const errors = [];
  const ancestors = new WeakSet();
  const walk = (current, pointer, depth) => {
    if (depth > MAX_DEPTH) {
      push(errors, "MAX_DEPTH", item, pointer, "maximum nesting depth exceeded");
      return;
    }
    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH) push(errors, "MAX_STRING", item, pointer, "string length limit exceeded");
      if (SECRET_VALUE.test(current)) push(errors, "PRIVATE_VALUE", item, pointer, "secret-like content is forbidden");
      if (RAW_SECRET_VALUE.test(current)) push(errors, "PRIVATE_VALUE", item, pointer, "raw credential-like content or URL userinfo is forbidden");
      if (LOCAL_PATH.test(current)) push(errors, "PRIVATE_PATH", item, pointer, "local, absolute, URI, or traversal path content is forbidden");
      if (prosePointer(pointer) && AGGREGATE_CLAIM.test(current)) push(errors, "AGGREGATE_CLAIM", item, pointer, "aggregate status, result, or evidence claims are forbidden in prose");
      if (prosePointer(pointer) && /\b(?:0x)?[0-9a-f]{64}\b/i.test(current)) push(errors, "PRIVATE_VALUE", item, pointer, "key-like content is forbidden in prose");
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(current)) push(errors, "CONTROL_CHARACTER", item, pointer, "control characters are forbidden");
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (ancestors.has(current)) {
      push(errors, "CYCLE", item, pointer, "cyclic values are forbidden");
      return;
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_ITEMS) push(errors, "MAX_ARRAY", item, pointer, "array item limit exceeded");
      current.slice(0, MAX_ARRAY_ITEMS + 1).forEach((entry, index) => walk(entry, `${pointer}/${index}`, depth + 1));
    } else {
      const keys = Object.keys(current);
      if (keys.length > MAX_OBJECT_KEYS) push(errors, "MAX_KEYS", item, pointer, "object key limit exceeded");
      for (const key of keys.sort(comparison).slice(0, MAX_OBJECT_KEYS + 1)) {
        const child = `${pointer}/${key}`;
        if (PROTOTYPE_KEYS.has(key)) push(errors, "PROTOTYPE_KEY", item, child, "prototype-affecting keys are forbidden");
        const forbiddenCode = forbiddenField(key);
        if (forbiddenCode !== null) push(errors, forbiddenCode, item, child, forbiddenCode === "RECORD_COMMIT" ? "authored recordCommit is forbidden" : "private, aggregate, status, result, artifact, or evidence fields are forbidden");
        walk(current[key], child, depth + 1);
      }
    }
    ancestors.delete(current);
  };
  walk(value, "", 0);
  return errors;
}

function layoutFrom(relative) {
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "registry/events.jsonl") return { kind: "registry", layout: normalized };
  if (/^cases\/[a-z][a-z0-9-]*\.jsonl$/.test(normalized)) return { kind: "caseDefinition", layout: normalized };
  if (/^runs\/[0-9]{4}\/A-[0-9]{8}-[0-9]{3}\.json$/.test(normalized)) return { kind: "runAttempt", layout: normalized };
  return null;
}

async function collectFiles(inputs, strict) {
  const files = [];
  for (const input of inputs) {
    const absolute = path.resolve(input);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("symlink inputs are forbidden");
    if (stat.isDirectory()) {
      const root = await realpath(absolute);
      const visit = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => comparison(left.name, right.name))) {
          const child = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) throw new Error("symlinks are forbidden");
          if (entry.isDirectory()) await visit(child);
          else if (entry.isFile()) {
            const childStat = await lstat(child);
            if (!childStat.isFile()) throw new Error("nonregular files are forbidden");
            if (childStat.size > MAX_FILE_BYTES) throw new Error("authority file size limit exceeded");
            const relative = path.relative(root, child);
            const normalized = relative.split(path.sep).join("/");
            if (FOUNDATION_FILES.has(normalized)) continue;
            const layout = layoutFrom(relative);
            if (strict && layout === null) throw new Error("unexpected file below the authority root");
            if (layout !== null) files.push({ file: await realpath(child), size: childStat.size, ...layout });
          } else throw new Error("nonregular files are forbidden");
        }
      };
      await visit(root);
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES) throw new Error("authority file size limit exceeded");
      const segments = absolute.split(path.sep);
      let layout = null;
      for (let index = 0; index < segments.length; index += 1) {
        const candidate = layoutFrom(segments.slice(index).join("/"));
        if (candidate !== null) layout = candidate;
      }
      if (layout === null) throw new Error("record file is outside the strict authority layout");
      files.push({ file: await realpath(absolute), size: stat.size, ...layout });
    } else throw new Error("unsupported input type");
  }
  files.sort((left, right) => comparison(left.layout, right.layout));
  if (files.length > MAX_FILES) throw new Error("authority file count limit exceeded");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new Error("authority aggregate size limit exceeded");
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.layout)) throw new Error("duplicate authority layout path");
    seen.add(file.layout);
  }
  return files;
}

async function parseFile(descriptor, errors) {
  const bytes = descriptor.bytes ?? await readFile(descriptor.file);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    recordError(errors, error("MAX_FILE", descriptor.layout, 1, "", "file size limit exceeded"));
    return { bytes, records: [] };
  }
  let text;
  try {
    text = decodeUtf8(bytes);
  } catch {
    recordError(errors, error("INVALID_UTF8", descriptor.layout, 1, "", "input must be well-formed UTF-8"));
    return { bytes, records: [] };
  }
  const records = [];
  const physicalLineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (physicalLineCount > MAX_PHYSICAL_LINES) {
    recordError(errors, error("MAX_LINES", descriptor.layout, 1, "", "physical line limit exceeded"));
    return { bytes, records };
  }
  if (descriptor.kind === "runAttempt") {
    if (!text.endsWith("\n")) recordError(errors, error("FINAL_NEWLINE", descriptor.layout, 1, "", "JSON files must end with one newline"));
    try {
      const record = JSON.parse(text);
      const inspection = inspectJson(text);
      if (inspection.duplicate) recordError(errors, error("DUPLICATE_JSON_KEY", descriptor.layout, 1, "", "duplicate JSON object keys are forbidden"));
      if (inspection.tooDeep) recordError(errors, error("MAX_DEPTH", descriptor.layout, 1, "", "maximum nesting depth exceeded"));
      records.push({ ...descriptor, line: 1, raw: text, record });
    } catch {
      recordError(errors, error("INVALID_JSON", descriptor.layout, 1, "", "invalid JSON"));
    }
  } else {
    if (text.length > 0 && !text.endsWith("\n")) recordError(errors, error("FINAL_NEWLINE", descriptor.layout, 1, "", "JSONL files must end with one newline"));
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (text.length === 0) lines.length = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const raw = `${lines[index]}\n`;
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) {
        recordError(errors, error("MAX_LINE", descriptor.layout, index + 1, "", "JSONL line size limit exceeded"));
        continue;
      }
      if (lines[index].length === 0) {
        recordError(errors, error("BLANK_LINE", descriptor.layout, index + 1, "", "blank JSONL lines are forbidden"));
        continue;
      }
      try {
        const record = JSON.parse(lines[index]);
        const inspection = inspectJson(lines[index]);
        if (inspection.duplicate) recordError(errors, error("DUPLICATE_JSON_KEY", descriptor.layout, index + 1, "", "duplicate JSON object keys are forbidden"));
        if (inspection.tooDeep) recordError(errors, error("MAX_DEPTH", descriptor.layout, index + 1, "", "maximum nesting depth exceeded"));
        records.push({ ...descriptor, line: index + 1, raw, record });
      } catch {
        recordError(errors, error("INVALID_JSON", descriptor.layout, index + 1, "", "invalid JSON"));
      }
    }
  }
  return { bytes, records };
}

async function loadDataset(inputs, strict) {
  const descriptors = await collectFiles(inputs, strict);
  const errors = [];
  const files = new Map();
  const records = [];
  for (const descriptor of descriptors) {
    const parsed = await parseFile(descriptor, errors);
    files.set(descriptor.layout, { ...descriptor, bytes: parsed.bytes });
    for (const item of parsed.records) {
      if (records.length >= MAX_RECORDS) {
        recordError(errors, error("MAX_RECORDS", item.layout, item.line, "", "total record limit exceeded"));
        break;
      }
      for (const diagnostic of auditValue(item.record, item)) recordError(errors, diagnostic);
      if (!isObject(item.record)) push(errors, "TYPE_OBJECT", item, "", "record must be an object");
      else if (descriptor.kind === "registry") validateRegistry(item.record, item, errors);
      else if (descriptor.kind === "caseDefinition") validateCase(item.record, item, errors);
      else validateRun(item.record, item, errors);
      records.push(item);
    }
  }
  crossValidate(records, files, errors);
  return { errors, files, records };
}

async function git(repository, args, options = {}) {
  return execFile("git", args, { cwd: repository, encoding: null, maxBuffer: MAX_TOTAL_BYTES + 1_048_576, timeout: 60_000, ...options });
}

async function assertCommit(repository, commit) {
  if (!COMMIT.test(commit) || /^0{40}$/.test(commit)) return false;
  try {
    await git(repository, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function loadGitDataset(repository, commit, strict) {
  if (!await assertCommit(repository, commit)) throw new Error("base git commit is not a repository commit");
  const listing = await git(repository, ["ls-tree", "-r", "-z", "--full-tree", "--long", commit, "--", "validation/wave-4"]);
  let entries;
  try {
    entries = decodeUtf8(listing.stdout).split("\0").filter(Boolean).sort(comparison);
  } catch {
    throw new Error("git tree paths must be well-formed UTF-8");
  }
  const pending = [];
  let aggregateBytes = 0;
  let subtreeFileCount = 0;
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("malformed git tree entry");
    const metadata = entry.slice(0, separator).trim().split(/\s+/);
    const repositoryPath = entry.slice(separator + 1);
    if (metadata.length !== 4 || metadata[0] !== "100644" || metadata[1] !== "blob") throw new Error("git tree contains unsupported mode or type");
    const [, , objectId, sizeText] = metadata;
    if (!/^[0-9a-f]{40}$/.test(objectId) || !/^[0-9]+$/.test(sizeText)) throw new Error("malformed git tree metadata");
    const objectSize = Number(sizeText);
    if (!Number.isSafeInteger(objectSize) || objectSize > MAX_FILE_BYTES) throw new Error("authority file size limit exceeded");
    if (/[\u0000-\u001f\u007f]/.test(repositoryPath)) throw new Error("control characters in git tree paths are forbidden");
    subtreeFileCount += 1;
    aggregateBytes += objectSize;
    if (subtreeFileCount > MAX_FILES) throw new Error("authority file count limit exceeded");
    if (aggregateBytes > MAX_TOTAL_BYTES) throw new Error("authority aggregate size limit exceeded");
    const relative = repositoryPath.replace(/^validation\/wave-4\//, "");
    if (FOUNDATION_FILES.has(relative)) continue;
    const layout = layoutFrom(relative);
    if (strict && layout === null) throw new Error("unexpected file below the authority root");
    if (layout !== null) {
      pending.push({ objectId, objectSize, ...layout });
    }
  }
  const descriptors = [];
  for (const descriptor of pending) {
    const blob = await git(repository, ["cat-file", "blob", descriptor.objectId]);
    const bytes = Buffer.from(blob.stdout);
    if (bytes.byteLength !== descriptor.objectSize) throw new Error("git blob size changed during validation");
    descriptors.push({ bytes, kind: descriptor.kind, layout: descriptor.layout });
  }
  const errors = [];
  const files = new Map();
  const records = [];
  for (const descriptor of descriptors) {
    const parsed = await parseFile(descriptor, errors);
    files.set(descriptor.layout, { ...descriptor, bytes: parsed.bytes });
    for (const item of parsed.records) {
      if (records.length >= MAX_RECORDS) {
        recordError(errors, error("MAX_RECORDS", item.layout, item.line, "", "total record limit exceeded"));
        break;
      }
      for (const diagnostic of auditValue(item.record, item)) recordError(errors, diagnostic);
      if (!isObject(item.record)) push(errors, "TYPE_OBJECT", item, "", "record must be an object");
      else if (descriptor.kind === "registry") validateRegistry(item.record, item, errors);
      else if (descriptor.kind === "caseDefinition") validateCase(item.record, item, errors);
      else validateRun(item.record, item, errors);
      records.push(item);
    }
  }
  crossValidate(records, files, errors);
  return { errors, files, records };
}

function crossValidate(records, files, errors) {
  const registry = new Map();
  const cases = new Map();
  const latestCases = new Map();
  const attempts = new Map();
  const eventIds = new Set();
  const registrySemanticKeys = new Map();
  const caseSemanticKeys = new Map();
  const assertionOwners = new Map();
  let provenanceSeen = false;
  for (const item of records) {
    if (!isObject(item.record)) continue;
    if (item.kind === "registry") {
      if (eventIds.has(item.record.eventId)) push(errors, "DUPLICATE", item, "/eventId", "eventId must be unique");
      eventIds.add(item.record.eventId);
      if (item.record.eventKind === "requirement") {
        const prior = registry.get(item.record.baseRequirementId);
        if (!prior && item.record.revision !== 1) push(errors, "REVISION_SEQUENCE", item, "/revision", "first registry revision must equal 1");
        if (prior && item.record.revision !== prior.record.revision + 1) push(errors, "REVISION_SEQUENCE", item, "/revision", "registry revisions must append consecutively");
        if (prior && item.record.semanticKey !== prior.record.semanticKey) push(errors, "SEMANTIC_KEY", item, "/semanticKey", "semanticKey must remain stable across revisions");
        const semanticOwner = registrySemanticKeys.get(item.record.semanticKey);
        if (semanticOwner && semanticOwner !== item.record.baseRequirementId) push(errors, "SEMANTIC_KEY", item, "/semanticKey", "registry semanticKey must identify exactly one base requirement");
        registrySemanticKeys.set(item.record.semanticKey, item.record.baseRequirementId);
        registry.set(item.record.baseRequirementId, item);
      } else if (item.record.eventKind === "provenance") {
        if (provenanceSeen) push(errors, "DUPLICATE", item, "/provenanceLabel", "the non-resolving provenance label may be authored once");
        provenanceSeen = true;
      }
    } else if (item.kind === "caseDefinition") {
      const key = `${item.record.caseId}@${item.record.revision}`;
      if (cases.has(key)) push(errors, "DUPLICATE", item, "/caseId", "case ID and revision must be unique");
      cases.set(key, item);
      const prior = latestCases.get(item.record.caseId);
      if (!prior && item.record.revision !== 1) push(errors, "REVISION_SEQUENCE", item, "/revision", "first case revision must equal 1");
      if (prior && item.record.revision !== prior.record.revision + 1) push(errors, "REVISION_SEQUENCE", item, "/revision", "case revisions must append consecutively");
      if (prior && item.record.semanticKey !== prior.record.semanticKey) push(errors, "SEMANTIC_KEY", item, "/semanticKey", "semanticKey must remain stable across revisions");
      const semanticOwner = caseSemanticKeys.get(item.record.semanticKey);
      if (semanticOwner && semanticOwner !== item.record.caseId) push(errors, "SEMANTIC_KEY", item, "/semanticKey", "case semanticKey must identify exactly one case ID");
      caseSemanticKeys.set(item.record.semanticKey, item.record.caseId);
      if (prior && item.layout !== prior.layout) push(errors, "CASE_SHARD", item, "/caseId", "all revisions of a case must remain in one shard");
      const domain = typeof item.record.baseRequirementId === "string" ? item.record.baseRequirementId.split("-")[0].toLowerCase() : "";
      const shard = item.layout.replace(/^cases\//, "").replace(/\.jsonl$/, "");
      if (domain.length > 0 && shard !== domain && !shard.startsWith(`${domain}-`)) push(errors, "CASE_SHARD", item, "/baseRequirementId", "case shard prefix must match the base requirement domain");
      if (Array.isArray(item.record.expectedAssertions)) item.record.expectedAssertions.forEach((assertion) => {
        const owner = assertionOwners.get(assertion?.assertionId);
        if (owner && owner !== item.record.caseId) push(errors, "ASSERTION_ID", item, "/expectedAssertions", "assertionId must identify exactly one case");
        assertionOwners.set(assertion?.assertionId, item.record.caseId);
      });
      latestCases.set(item.record.caseId, item);
    } else if (item.kind === "runAttempt") {
      if (attempts.has(item.record.attemptId)) push(errors, "DUPLICATE", item, "/attemptId", "attemptId must be unique");
      attempts.set(item.record.attemptId, item);
      if (item.layout !== `runs/${item.record.started?.slice(0, 4)}/${item.record.attemptId}.json`) push(errors, "RUN_PATH", item, "/attemptId", "run path must match start year and attemptId");
      if (typeof item.record.started === "string" && typeof item.record.attemptId === "string" && item.record.attemptId.slice(2, 10) !== item.record.started.slice(0, 10).replaceAll("-", "")) push(errors, "ATTEMPT_DATE", item, "/attemptId", "attempt ID date must match started");
    }
  }
  const registryHeads = new Map();
  let registryPrefix = "";
  const adoptedAtHead = new Set();
  for (const item of records.filter((entry) => entry.kind === "registry")) {
    registryPrefix += item.raw;
    if (item.record.eventKind === "requirement" && typeof item.record.baseRequirementId === "string") {
      adoptedAtHead.add(item.record.baseRequirementId);
    }
    registryHeads.set(sha256(Buffer.from(registryPrefix)), new Set(adoptedAtHead));
  }
  for (const item of records) {
    if (!isObject(item.record)) continue;
    if (item.kind === "caseDefinition" && !registry.has(item.record.baseRequirementId)) push(errors, "REQUIREMENT_REFERENCE", item, "/baseRequirementId", "does not resolve to the registry head");
    if (item.kind === "runAttempt") {
      const definition = cases.get(`${item.record.caseId}@${item.record.caseRevision}`);
      if (!definition) push(errors, "CASE_REFERENCE", item, "/caseId", "referenced case revision is absent");
      else {
        if (item.record.definitionSha256 !== sha256(Buffer.from(definition.raw))) push(errors, "DEFINITION_DIGEST", item, "/definitionSha256", "does not match the exact case-definition JSONL line digest");
        const expected = new Set(Array.isArray(definition.record.expectedAssertions) ? definition.record.expectedAssertions.map((entry) => entry?.assertionId) : []);
        const actual = new Set(Array.isArray(item.record.assertionResults) ? item.record.assertionResults.map((entry) => entry?.assertionId) : []);
        if (expected.size !== actual.size || [...expected].some((assertionId) => !actual.has(assertionId))) push(errors, "ASSERTION_COVERAGE", item, "/assertionResults", "must cover every expected assertion exactly once");
      }
      const headRequirements = registryHeads.get(item.record.registryHeadSha256);
      if (!headRequirements) push(errors, "REGISTRY_DIGEST", item, "/registryHeadSha256", "does not match an exact registry/events.jsonl head digest");
      else if (definition && !headRequirements.has(definition.record.baseRequirementId)) push(errors, "REGISTRY_HEAD_ORDER", item, "/registryHeadSha256", "registry head predates the referenced case requirement");
      if (Object.hasOwn(item.record, "supersedesAttemptId")) {
        const prior = attempts.get(item.record.supersedesAttemptId);
        if (!prior) push(errors, "SUPERSEDES_REFERENCE", item, "/supersedesAttemptId", "referenced prior attempt is absent");
        else {
          if (prior.record.attemptId === item.record.attemptId) push(errors, "SUPERSEDES_SELF", item, "/supersedesAttemptId", "an attempt cannot supersede itself");
          if (prior.record.caseId !== item.record.caseId || prior.record.caseRevision !== item.record.caseRevision) push(errors, "SUPERSEDES_CASE", item, "/supersedesAttemptId", "superseded attempt must use the same case ID and revision");
          if (typeof prior.record.started === "string" && typeof prior.record.ended === "string" && typeof item.record.started === "string" && (prior.record.started >= item.record.started || prior.record.ended > item.record.started)) push(errors, "SUPERSEDES_ORDER", item, "/supersedesAttemptId", "superseded attempt must finish before the later attempt starts");
        }
      }
    }
  }

  const cycleReported = new Set();
  const globallyVisited = new Set();
  for (const attemptId of [...attempts.keys()].sort(comparison)) {
    if (globallyVisited.has(attemptId)) continue;
    const path = [];
    const positions = new Map();
    let cursor = attemptId;
    while (attempts.has(cursor) && !globallyVisited.has(cursor)) {
      if (positions.has(cursor)) {
        const cycle = path.slice(positions.get(cursor)).sort(comparison);
        const reportId = cycle[0];
        if (!cycleReported.has(reportId)) {
          const cycleItem = attempts.get(reportId);
          push(errors, "SUPERSEDES_CYCLE", cycleItem, "/supersedesAttemptId", "supersession graph must be acyclic");
          cycleReported.add(reportId);
        }
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = attempts.get(cursor).record.supersedesAttemptId;
    }
    path.forEach((visited) => globallyVisited.add(visited));
  }
}

function appendOnly(base, current, errors) {
  for (const [layout, prior] of base.files) {
    const next = current.files.get(layout);
    if (!next) {
      recordError(errors, error("APPEND_ONLY_DELETE", layout, 1, "", "base authority file was deleted"));
      continue;
    }
    if (layout.endsWith(".jsonl")) {
      if (next.bytes.length < prior.bytes.length || !next.bytes.subarray(0, prior.bytes.length).equals(prior.bytes)) recordError(errors, error("APPEND_ONLY_PREFIX", layout, 1, "", "base JSONL bytes are not an exact prefix"));
    } else if (!next.bytes.equals(prior.bytes)) recordError(errors, error("APPEND_ONLY_RUN", layout, 1, "", "authored run file bytes are immutable"));
  }
}

function parseArguments(argv) {
  const inputs = [];
  let base = null;
  let baseGitRef = null;
  let strict = false;
  let json = false;
  let authoritative = false;
  let repository = null;
  let expectedCommit = null;
  let candidateCommit = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") {
      if (base !== null || index + 1 >= argv.length) throw new Error("invalid --base usage");
      base = argv[++index];
    } else if (argument === "--base-git-ref") {
      if (baseGitRef !== null || index + 1 >= argv.length) throw new Error("invalid --base-git-ref usage");
      baseGitRef = argv[++index];
    } else if (argument === "--repository") {
      if (repository !== null || index + 1 >= argv.length) throw new Error("invalid --repository usage");
      repository = argv[++index];
    } else if (argument === "--expected-subject-commit") {
      if (expectedCommit !== null || index + 1 >= argv.length) throw new Error("invalid --expected-subject-commit usage");
      expectedCommit = argv[++index];
    } else if (argument === "--candidate-commit") {
      if (candidateCommit !== null || index + 1 >= argv.length) throw new Error("invalid --candidate-commit usage");
      candidateCommit = argv[++index];
    } else if (argument === "--authoritative") authoritative = true;
    else if (argument === "--strict") strict = true;
    else if (argument === "--json") json = true;
    else if (argument.startsWith("-")) throw new Error("unknown option");
    else inputs.push(argument);
  }
  if (!strict || !json) throw new Error("--strict and --json are required");
  if (base !== null && baseGitRef !== null) throw new Error("--base and --base-git-ref are mutually exclusive");
  if (authoritative && repository === null) throw new Error("authoritative mode requires an explicit repository");
  if (repository !== null && baseGitRef === null && base === null) throw new Error("repository mode requires an explicit base");
  if (repository === null && (expectedCommit !== null || candidateCommit !== null || baseGitRef !== null)) throw new Error("commit flags require an explicit repository");
  if (expectedCommit !== null && (!COMMIT.test(expectedCommit) || /^0{40}$/.test(expectedCommit))) throw new Error("expected commit must be a nonzero commit ID");
  if (candidateCommit !== null && (!COMMIT.test(candidateCommit) || /^0{40}$/.test(candidateCommit))) throw new Error("candidate commit must be a nonzero commit ID");
  if (baseGitRef !== null && (!COMMIT.test(baseGitRef) || /^0{40}$/.test(baseGitRef))) throw new Error("base git commit must be a nonzero commit ID");
  if (inputs.length === 0) inputs.push(here);
  return { authoritative, base, baseGitRef, candidateCommit, expectedCommit, inputs, json, repository, strict };
}

export async function validate(argv) {
  const options = parseArguments(argv);
  const current = await loadDataset(options.inputs, options.strict);
  let authority = "syntax-only";
  let comparisonBase = null;
  if (options.baseGitRef !== null) comparisonBase = await loadGitDataset(await realpath(options.repository), options.baseGitRef, options.strict);
  else if (options.base !== null) comparisonBase = await loadDataset([options.base], options.strict);
  if (comparisonBase !== null) {
    for (const diagnostic of comparisonBase.errors) recordError(current.errors, diagnostic);
    appendOnly(comparisonBase, current, current.errors);
  }
  if (options.repository !== null) {
    const repository = await realpath(options.repository);
    if (options.expectedCommit !== null && !await assertCommit(repository, options.expectedCommit)) throw new Error("expected commit is not a repository commit");
    if (options.candidateCommit !== null && !await assertCommit(repository, options.candidateCommit)) throw new Error("candidate commit is not a repository commit");
    if (options.expectedCommit !== null && options.candidateCommit !== null) {
      const trustRootDiff = await git(repository, ["diff", "--raw", options.expectedCommit, options.candidateCommit, "--", ".github/workflows/wave4-authority.yml", "validation/wave-4/validate.mjs"]);
      if (trustRootDiff.stdout.length > 0) recordError(current.errors, error("TRUST_ROOT_CHANGE", "", 0, "", "trusted workflow and validator blob/mode entries are frozen under normal authority validation"));
    }
    const newRuns = current.records.filter((entry) => entry.kind === "runAttempt" && isObject(entry.record) && (comparisonBase === null || !comparisonBase.files.has(entry.layout)));
    const baseCases = new Set((comparisonBase?.records ?? []).filter((entry) => entry.kind === "caseDefinition" && isObject(entry.record)).map((entry) => `${entry.record.caseId}@${entry.record.revision}`));
    for (const item of current.records.filter((entry) => entry.kind === "runAttempt" && isObject(entry.record))) {
      const newRun = comparisonBase === null || !comparisonBase.files.has(item.layout);
      if (newRun) {
        if (!await assertCommit(repository, item.record.subjectCommit)) push(current.errors, "SUBJECT_COMMIT", item, "/subjectCommit", "must identify a commit in the explicit repository");
        if (options.expectedCommit !== null && item.record.subjectCommit !== options.expectedCommit) push(current.errors, "EXPECTED_COMMIT", item, "/subjectCommit", "new run must equal the explicitly expected protected base commit");
        if (!await assertCommit(repository, item.record.testHarnessCommit)) push(current.errors, "HARNESS_COMMIT", item, "/testHarnessCommit", "must identify a commit in the explicit repository");
      }
    }
    if (newRuns.length > 0) {
      for (const item of newRuns) if (!baseCases.has(`${item.record.caseId}@${item.record.caseRevision}`)) push(current.errors, "RUN_BASE_CASE", item, "/caseId", "new run must reference a case revision already present at the protected base");
      if (options.expectedCommit === null || options.candidateCommit === null) {
        for (const item of newRuns) push(current.errors, "RUN_AUTHORITY_MODE", item, "", "new runs require explicit protected-base and candidate commits");
      } else {
        const changed = await git(repository, ["diff", "--name-only", "-z", options.expectedCommit, options.candidateCommit]);
        const changedPaths = changed.stdout.toString("utf8").split("\0").filter(Boolean);
        const runsOnly = changedPaths.every((changedPath) => layoutFrom(changedPath.replace(/^validation\/wave-4\//, ""))?.kind === "runAttempt");
        if (!runsOnly) for (const item of newRuns) push(current.errors, "RUN_COEXISTING_CHANGE", item, "", "new run commits may contain only run-attempt files whose cases already exist at the protected base");
      }
    }
    authority = "repository-bound";
  }
  current.errors.sort((left, right) => comparison(`${left.file}\0${String(left.line).padStart(8, "0")}\0${left.pointer}\0${left.code}\0${left.message}`, `${right.file}\0${String(right.line).padStart(8, "0")}\0${right.pointer}\0${right.code}\0${right.message}`));
  const counts = { caseDefinition: 0, registry: 0, runAttempt: 0 };
  current.records.forEach((item) => { counts[item.kind] += 1; });
  return { authority, errors: current.errors, ok: current.errors.length === 0, recordCounts: counts, strict: true };
}

async function main() {
  try {
    const result = await validate(process.argv.slice(2));
    const output = { ok: result.ok, strict: result.strict, authority: result.authority, recordCounts: result.recordCounts, errors: result.errors };
    let serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) serialized = JSON.stringify({ ok: false, strict: true, authority: output.authority, recordCounts: output.recordCounts, errors: [error("DIAGNOSTICS_TRUNCATED", "", 0, "", "diagnostic output exceeded its deterministic byte limit")] });
    process.stdout.write(`${serialized}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (caught) {
    const safeMessages = new Set(["--base and --base-git-ref are mutually exclusive", "--strict and --json are required", "authority aggregate size limit exceeded", "authority file count limit exceeded", "authority file size limit exceeded", "authoritative mode requires an explicit repository", "base git commit is not a repository commit", "base git commit must be a nonzero commit ID", "candidate commit is not a repository commit", "candidate commit must be a nonzero commit ID", "commit flags require an explicit repository", "duplicate authority layout path", "expected commit is not a repository commit", "expected commit must be a nonzero commit ID", "input discovery failed", "invalid --base usage", "invalid --base-git-ref usage", "invalid --candidate-commit usage", "invalid --expected-subject-commit usage", "invalid --repository usage", "nonregular files are forbidden", "record file is outside the strict authority layout", "repository mode requires an explicit base", "symlink inputs are forbidden", "symlinks are forbidden", "unexpected file below the authority root", "unknown option", "unsupported input type"]);
    const message = caught instanceof Error && safeMessages.has(caught.message) ? caught.message : "input discovery failed";
    const output = { ok: false, strict: true, authority: "none", recordCounts: { caseDefinition: 0, registry: 0, runAttempt: 0 }, errors: [{ code: "CLI_OR_INPUT", file: "", line: 0, message, pointer: "" }] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
