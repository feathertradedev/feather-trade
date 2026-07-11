#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg === -1 ? path.resolve(__dirname, "..", "..") : path.resolve(args[rootArg + 1] || "");
const monitorPath = path.join(root, "infra/monitoring/monitors.json");
const incidentPath = path.join(root, "docs/wave-2/observability-incident-response.md");
const runbookDir = path.join(root, "docs/wave-2/runbooks");
const requiredSections = [
  "Trigger", "Authority", "Prerequisites", "Commands", "Validation",
  "Rollback", "Evidence", "Communications", "Escalation"
];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const errors = [];

function relative(file) {
  return path.relative(root, file) || ".";
}

function read(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { errors.push(`${relative(file)}: ${error.message}`); return ""; }
}

function isContained(parent, child) {
  const relation = path.relative(parent, child);
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation));
}

function parseMarkdown(markdown) {
  const headings = [];
  const links = [];
  const codeBlocks = [];
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  let block = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
        block = { language: fenceMatch[2].trim().split(/\s+/)[0].toLowerCase(), lines: [], line: index + 1 };
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.length) {
        codeBlocks.push(block);
        fence = null;
        block = null;
      } else {
        block.lines.push(line);
      }
      continue;
    }
    if (fence) {
      block.lines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (heading) headings.push({ level: heading[1].length, title: heading[2].trim(), line: index + 1 });

    const linkPattern = /\[[^\]]*\]\(([^)]*)\)/g;
    for (const match of line.matchAll(linkPattern)) {
      const raw = match[1].trim();
      const target = raw.startsWith("<") ? raw.slice(1, raw.indexOf(">") === -1 ? undefined : raw.indexOf(">")) : raw.split(/\s+/, 1)[0];
      links.push({ target, line: index + 1 });
    }
  }
  if (fence) codeBlocks.push(block);
  return { headings, links, codeBlocks, lines };
}

function sectionRanges(parsed) {
  const sections = new Map();
  const levelTwo = parsed.headings.filter((heading) => heading.level === 2);
  for (let index = 0; index < levelTwo.length; index += 1) {
    const heading = levelTwo[index];
    const end = levelTwo[index + 1]?.line ?? parsed.lines.length + 1;
    const text = parsed.lines.slice(heading.line, end - 1).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    sections.set(heading.title, { start: heading.line, end, text });
  }
  return sections;
}

function decodeTarget(target) {
  try { return decodeURIComponent(target.split(/[?#]/, 1)[0]); }
  catch { return null; }
}

function localRunbookSlug(target, sourceFile) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
  const decoded = decodeTarget(target);
  const source = relative(sourceFile);
  if (decoded === null) {
    errors.push(`${source}: invalid percent-encoding in local link ${target}`);
    return null;
  }
  const mentionsRunbooks = decoded.split(/[\\/]/).includes("runbooks") || sourceFile.startsWith(`${runbookDir}${path.sep}`);
  if (!mentionsRunbooks) return null;
  if (path.isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded) || decoded.includes("\\")) {
    errors.push(`${source}: invalid local runbook link ${target}`);
    return null;
  }
  const resolved = path.resolve(path.dirname(sourceFile), decoded);
  if (!isContained(runbookDir, resolved)) {
    errors.push(`${source}: local runbook link escapes runbook directory: ${target}`);
    return null;
  }
  const basename = path.basename(decoded);
  if (basename === "README.md" && resolved === path.join(runbookDir, basename)) return null;
  const match = basename.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
  if (!match || resolved !== path.join(runbookDir, basename)) {
    errors.push(`${source}: invalid local runbook link ${target}`);
    return null;
  }
  return match[1] === "readme" ? null : match[1];
}

function validateResolvedRunbook(file, source) {
  const expectedRoot = fs.realpathSync(runbookDir);
  let resolved;
  try { resolved = fs.realpathSync(file); }
  catch (error) { errors.push(`${source}: runbook ${relative(file)} is missing: ${error.message}`); return false; }
  if (!isContained(expectedRoot, resolved) || !isContained(fs.realpathSync(root), resolved)) {
    errors.push(`${source}: runbook ${relative(file)} resolves outside the runbook directory`);
    return false;
  }
  if (!fs.statSync(resolved).isFile()) {
    errors.push(`${source}: runbook ${relative(file)} is not a file`);
    return false;
  }
  return true;
}

function hasInlineSecret(content) {
  const checks = [
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
    /https?:\/\/[^\s<>"')\]]*[?&](?:access_?token|api_?key|key|secret|token)=[^\s&#<>"')\]]+/i,
    /\bauthorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
    /(?:^|[\s,{"'])(?:private[ _-]*key|api[ _-]*key|access[ _-]*token|auth[ _-]*token|secret|token)["']?\s*(?:=|:)\s*["']?(?!\$|<|\{|\[|\.\.\.|REDACTED\b|CHANGEME\b)[A-Za-z0-9._~+\/-]{8,}/im,
    /(?:^|\s)--(?:private-key|api-key|access-token|auth-token|secret|token)(?:=|\s+)["']?(?!\$|<|\{|\[|\.\.\.|REDACTED\b|CHANGEME\b)[A-Za-z0-9._~+\/-]{8,}/im
  ];
  return checks.some((pattern) => pattern.test(content));
}

let monitors = [];
try {
  const parsed = JSON.parse(read(monitorPath));
  monitors = Array.isArray(parsed.monitors) ? parsed.monitors : [];
  if (!monitors.length) errors.push("infra/monitoring/monitors.json: no monitors defined");
} catch (error) {
  errors.push(`infra/monitoring/monitors.json: invalid JSON: ${error.message}`);
}

const references = new Map();
function addReference(slug, source) {
  if (!references.has(slug)) references.set(slug, []);
  references.get(slug).push(source);
}

for (const monitor of monitors) {
  const source = `monitor ${monitor.id || "<unknown>"}`;
  if (typeof monitor.runbook !== "string" || !slugPattern.test(monitor.runbook)) {
    errors.push(`${source}: runbook must be a strict lowercase slug`);
    continue;
  }
  addReference(monitor.runbook, source);
}

const incidentContent = read(incidentPath);
const incidentLinks = parseMarkdown(incidentContent).links;
let incidentCount = 0;
for (const link of incidentLinks) {
  const slug = localRunbookSlug(link.target, incidentPath);
  if (slug) {
    incidentCount += 1;
    addReference(slug, `incident link on line ${link.line}`);
  }
}
if (!incidentCount) errors.push("docs/wave-2/observability-incident-response.md: no linked incident categories found");

let diskFiles = [];
try { diskFiles = fs.readdirSync(runbookDir, { withFileTypes: true }); }
catch (error) { errors.push(`docs/wave-2/runbooks: ${error.message}`); }
const diskSlugs = new Set();
const resolvedRunbooks = new Map();
for (const entry of diskFiles) {
  if (entry.name === "README.md") continue;
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    errors.push(`docs/wave-2/runbooks/${entry.name}: runbook entry must be a Markdown file`);
    continue;
  }
  const match = entry.name.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
  if (!match) {
    errors.push(`docs/wave-2/runbooks/${entry.name}: filename must use a strict lowercase slug`);
    continue;
  }
  diskSlugs.add(match[1]);
  resolvedRunbooks.set(match[1], validateResolvedRunbook(path.join(runbookDir, entry.name), "runbook inventory"));
}

for (const slug of diskSlugs) {
  if (!references.has(slug)) errors.push(`docs/wave-2/runbooks/${slug}.md: orphan runbook is not linked by an incident or monitor`);
}

for (const [slug, sources] of references) {
  const file = path.join(runbookDir, `${slug}.md`);
  const source = sources.join(", ");
  const resolved = resolvedRunbooks.has(slug) ? resolvedRunbooks.get(slug) : validateResolvedRunbook(file, source);
  if (!resolved) continue;
  const content = read(file);
  if (!content.trim()) { errors.push(`${source}: runbook ${relative(file)} is empty`); continue; }
  const parsed = parseMarkdown(content);
  const sections = sectionRanges(parsed);
  for (const section of requiredSections) {
    const range = sections.get(section);
    if (!range) errors.push(`${relative(file)}: missing ## ${section}`);
    else if (!range.text) errors.push(`${relative(file)}: ## ${section} must not be empty`);
  }
  const commands = sections.get("Commands");
  const executableBlock = commands && parsed.codeBlocks.some((block) =>
    ["sh", "bash"].includes(block.language) &&
    block.line > commands.start && block.line < commands.end &&
    block.lines.some((line) => line.trim() && !line.trim().startsWith("#"))
  );
  if (!executableBlock) errors.push(`${relative(file)}: Commands must contain a nonempty executable sh/bash block`);
  for (const link of parsed.links) {
    const linkedSlug = localRunbookSlug(link.target, file);
    if (linkedSlug && !resolvedRunbooks.has(linkedSlug)) {
      validateResolvedRunbook(path.join(runbookDir, `${linkedSlug}.md`), `${relative(file)} line ${link.line}`);
    }
  }
  if (hasInlineSecret(content)) errors.push(`${relative(file)}: appears to contain an inline secret`);
}

if (errors.length) {
  console.error(`Operator runbook validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Operator runbooks valid: ${monitors.length} monitors, ${incidentCount} incident links, ${references.size} referenced runbooks.`);
