#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const zlib = require("node:zlib");

const repoRoot = path.resolve(__dirname, "../..");
const commitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const tarEnvironment = {
  COPYFILE_DISABLE: "1",
  COPY_EXTENDED_ATTRIBUTES_DISABLE: "1"
};
let cachedTarMetadataOptions;

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (command === "create") return createBundle(parseArgs(args));
  if (command === "verify") return verifyBundle(parseArgs(args));
  throw new Error("Usage: web-promotion-custody.cjs <create|verify> [options]");
}

function createBundle(options) {
  requireOptions(options, ["environment", "commit", "manifest", "dist", "output"]);
  validateEnvironment(options.environment);
  validateCommit(options.commit, true);

  const manifest = repositoryPath(options.manifest, "manifest");
  const dist = repositoryPath(options.dist, "dist");
  if (!fs.statSync(manifest).isFile()) throw new Error("manifest must be a file");
  if (!fs.statSync(dist).isDirectory()) throw new Error("dist must be a directory");

  const output = path.resolve(repoRoot, options.output);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "web-promotion-"));
  try {
    fs.cpSync(dist, path.join(staging, "dist"), { recursive: true, dereference: false });
    fs.copyFileSync(manifest, path.join(staging, "manifest.json"));
    const files = inventory(staging);
    const metadata = {
      schemaVersion: "robinhood.web-promotion-custody.v1",
      environment: options.environment,
      repositoryCommit: options.commit,
      sourceManifest: path.relative(repoRoot, manifest),
      files
    };
    fs.writeFileSync(path.join(staging, "custody.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const archive = path.join(output, "web-promotion.tar.gz");
    run("tar", [...tarMetadataSuppressionOptions("create"), "-czf", archive, "-C", staging, "custody.json", "manifest.json", "dist"], false, tarEnvironment);
    const archiveSha256 = sha256File(archive);
    const envelope = { ...metadata, archiveSha256, archiveBytes: fs.statSync(archive).size };
    fs.writeFileSync(path.join(output, "custody.json"), `${JSON.stringify(envelope, null, 2)}\n`);
    fs.writeFileSync(path.join(output, "web-promotion.tar.gz.sha256"), `${archiveSha256}  web-promotion.tar.gz\n`);
    console.log(JSON.stringify({ ok: true, archiveSha256, files: files.length }));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function verifyBundle(options) {
  requireOptions(options, ["bundle", "commit", "environment", "output"]);
  validateEnvironment(options.environment);
  validateCommit(options.commit, false);
  const bundle = path.resolve(repoRoot, options.bundle);
  const envelope = readJson(path.join(bundle, "custody.json"));
  if (envelope.schemaVersion !== "robinhood.web-promotion-custody.v1") throw new Error("unsupported custody schema");
  if (envelope.repositoryCommit !== options.commit) throw new Error("custody commit does not match requested immutable commit");
  if (envelope.environment !== options.environment) throw new Error("custody environment does not match requested environment");
  if (!sha256Pattern.test(envelope.archiveSha256 || "")) throw new Error("custody archiveSha256 is invalid");
  const archive = path.join(bundle, "web-promotion.tar.gz");
  if (fs.statSync(archive).size !== envelope.archiveBytes) throw new Error("promotion archive byte count mismatch");
  if (sha256File(archive) !== envelope.archiveSha256) throw new Error("promotion archive SHA-256 mismatch");
  validateRawArchiveMetadataEntries(archive);
  validateArchiveEntries(archive);

  const output = path.resolve(repoRoot, options.output);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  run("tar", [...tarMetadataSuppressionOptions("extract"), "-xzf", archive, "-C", output, "--no-same-owner", "--no-same-permissions"], false, tarEnvironment);
  const embedded = readJson(path.join(output, "custody.json"));
  for (const field of ["schemaVersion", "environment", "repositoryCommit", "sourceManifest"]) {
    if (embedded[field] !== envelope[field]) throw new Error(`embedded custody ${field} mismatch`);
  }
  if (JSON.stringify(embedded.files) !== JSON.stringify(envelope.files)) throw new Error("embedded custody inventory mismatch");
  const actual = inventory(output, new Set(["custody.json"]));
  if (JSON.stringify(actual) !== JSON.stringify(envelope.files)) throw new Error("extracted promotion payload inventory mismatch");
  console.log(JSON.stringify({ ok: true, archiveSha256: envelope.archiveSha256, dist: path.join(output, "dist") }));
}

function validateArchiveEntries(archive) {
  const metadataOptions = tarMetadataSuppressionOptions("list");
  const names = run("tar", [...metadataOptions, "-tzf", archive], true, tarEnvironment).split("\n").filter(Boolean);
  const listing = run("tar", [...metadataOptions, "-tvzf", archive], true, tarEnvironment).split("\n").filter(Boolean);
  if (names.length !== listing.length || names.length === 0) throw new Error("promotion archive listing is invalid");
  const seen = new Set();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index].replace(/\/$/, "");
    if (/[\x00-\x1f\x7f\\]/.test(name) || name.startsWith("/") || path.posix.normalize(name) !== name) {
      throw new Error(`unsafe promotion archive path: ${JSON.stringify(names[index])}`);
    }
    rejectMacMetadataPath(name);
    if (!["custody.json", "manifest.json", "dist"].includes(name) && !name.startsWith("dist/")) {
      throw new Error(`unexpected promotion archive path: ${name}`);
    }
    if (seen.has(name)) throw new Error(`duplicate promotion archive path: ${name}`);
    seen.add(name);
    if (!["-", "d"].includes(listing[index][0])) throw new Error(`promotion archive links and special files are forbidden: ${name}`);
  }
  if (!seen.has("custody.json") || !seen.has("manifest.json") || !seen.has("dist")) throw new Error("promotion archive is incomplete");
}

function inventory(root, excluded = new Set()) {
  return listFiles(root).filter((file) => !excluded.has(path.relative(root, file))).map((file) => ({
    path: path.relative(root, file).split(path.sep).join("/"),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file)
  }));
}

function listFiles(root) {
  return walkFiles(root, root);
}

function walkFiles(root, directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    rejectMacMetadataPath(path.relative(root, target).split(path.sep).join("/"));
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in promotion artifacts: ${target}`);
    return entry.isDirectory() ? walkFiles(root, target) : [target];
  }).sort();
}

function rejectMacMetadataPath(value) {
  const segments = value.split("/");
  if (segments.some((segment) => segment.startsWith("._") || segment === "__MACOSX" || segment === ".DS_Store")) {
    throw new Error(`macOS metadata is forbidden in promotion artifacts: ${value}`);
  }
}

function validateRawArchiveMetadataEntries(archive) {
  let payload;
  try {
    payload = zlib.gunzipSync(fs.readFileSync(archive));
  } catch {
    throw new Error("promotion archive gzip payload is invalid");
  }
  let offset = 0;
  while (offset + 512 <= payload.length) {
    const header = payload.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (payload.length - offset < 1024 || payload.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error("promotion archive contains non-zero data after its end marker");
      }
      return;
    }
    const name = tarHeaderPath(header);
    rejectMacMetadataPath(name);
    const size = tarHeaderSize(header);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || bodyEnd > payload.length) throw new Error("promotion archive raw listing is invalid");
    const type = String.fromCharCode(header[156] || 0);
    if (type === "L") rejectMacMetadataPath(readTarString(payload.subarray(bodyStart, bodyEnd)));
    if (type === "x" || type === "g") {
      const pax = payload.subarray(bodyStart, bodyEnd).toString("utf8");
      for (const match of pax.matchAll(/(?:^|\n)\d+ path=([^\n]*)\n/g)) rejectMacMetadataPath(match[1]);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("promotion archive raw listing is invalid");
}

function tarHeaderPath(header) {
  const name = readTarString(header.subarray(0, 100));
  const prefix = readTarString(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function tarHeaderSize(header) {
  const field = header.subarray(124, 136);
  if (field[0] & 0x80) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.NaN;
  }
  const value = readTarString(field).trim();
  return /^[0-7]*$/.test(value) ? Number.parseInt(value || "0", 8) : Number.NaN;
}

function readTarString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

function tarMetadataSuppressionOptions(mode) {
  if (!cachedTarMetadataOptions) cachedTarMetadataOptions = detectTarMetadataOptions();
  return mode === "list" ? [] : cachedTarMetadataOptions;
}

function detectTarMetadataOptions() {
  const version = childProcess.spawnSync("tar", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...tarEnvironment }
  });
  const output = `${version.stdout || ""}\n${version.stderr || ""}`;
  if (/bsdtar/i.test(output)) return ["--no-mac-metadata", "--no-xattrs"];
  if (/GNU tar/i.test(output)) return ["--no-xattrs"];
  return [];
}

function repositoryPath(value, label) {
  const resolved = path.resolve(repoRoot, value);
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`${label} must stay inside the repository`);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist`);
  return resolved;
}

function validateCommit(commit, requireHead) {
  if (!commitPattern.test(commit || "")) throw new Error("commit must be a lowercase 40-character Git SHA");
  run("git", ["cat-file", "-e", `${commit}^{commit}`]);
  if (requireHead && run("git", ["rev-parse", "HEAD"], true).trim() !== commit) throw new Error("commit must match checked-out HEAD");
}

function validateEnvironment(value) {
  if (!["sepolia", "testnet", "mainnet"].includes(value)) throw new Error("environment must be sepolia, testnet, or mainnet");
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid option ${name || "<missing>"}`);
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required`);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(command, args, capture = false, extraEnvironment = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment }
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return capture ? result.stdout : "";
}
