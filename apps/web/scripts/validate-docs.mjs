import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(webRoot, "docs/content");
const trackerPath = path.join(webRoot, "docs/README.md");
const sections = new Set([
  "Overview",
  "Getting started",
  "Pools and trading",
  "Liquidity",
  "Safety and troubleshooting",
  "Contracts for builders"
]);
const forbiddenPublicPatterns = [
  [/\bSDKs?\b/i, "SDK documentation"],
  [/\bGraphQL\b/i, "GraphQL documentation"],
  [/\bindexer\b/i, "indexer service naming"],
  [/\banalytics\b/i, "analytics service naming"],
  [/\b(?:runbook|operator procedure|admin control)\b/i, "internal operations content"],
  [/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i, "local endpoint"],
  [/(?:authorization|bearer|private[_ -]?key|seed phrase)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}/i, "credential-like value"]
];

function listMdx(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listMdx(target) : entry.name.endsWith(".mdx") ? [target] : [];
  });
}

const errors = [];
const docs = [];
const slugSet = new Set();
const orderKeys = new Set();

function headingId(value) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

for (const file of listMdx(contentRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const parsed = matter(source);
  const data = parsed.data;
  const display = path.relative(webRoot, file);
  for (const key of ["title", "description", "slug", "section", "audience", "lastReviewed"]) {
    if (typeof data[key] !== "string" || data[key].trim() === "") errors.push(`${display}: ${key} is required`);
  }
  if (!Number.isInteger(data.order) || data.order < 1) errors.push(`${display}: order must be a positive integer`);
  if (!sections.has(data.section)) errors.push(`${display}: unsupported section ${data.section}`);
  if (data.audience !== "user" && data.audience !== "builder") errors.push(`${display}: audience must be user or builder`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.lastReviewed ?? "")) errors.push(`${display}: lastReviewed must use YYYY-MM-DD`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(data.slug ?? "")) errors.push(`${display}: invalid slug ${data.slug}`);
  if (slugSet.has(data.slug)) errors.push(`${display}: duplicate slug ${data.slug}`);
  slugSet.add(data.slug);
  const orderKey = `${data.section}:${data.order}`;
  if (orderKeys.has(orderKey)) errors.push(`${display}: duplicate section order ${orderKey}`);
  orderKeys.add(orderKey);
  if (/[—–]/.test(source)) errors.push(`${display}: public copy contains a prohibited dash character`);
  for (const [pattern, label] of forbiddenPublicPatterns) {
    if (pattern.test(parsed.content)) errors.push(`${display}: contains prohibited ${label}`);
  }
  if (/0x[a-fA-F0-9]{40}/.test(parsed.content)) errors.push(`${display}: contract addresses require the verified mainnet publishing path`);
  const fences = (parsed.content.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) errors.push(`${display}: unbalanced code fence`);
  const headings = new Set([...parsed.content.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => headingId(match[1])));
  docs.push({ ...data, file: display, source: parsed.content, headings });
}

const docsByHref = new Map(docs.map((doc) => [doc.slug === "welcome" ? "/docs" : `/docs/${doc.slug}`, doc]));
for (const doc of docs) {
  for (const match of doc.source.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|data:)/.test(target)) continue;
    const imagePath = target.startsWith("/") ? path.join(webRoot, "public", target) : path.resolve(webRoot, path.dirname(doc.file), target);
    if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) errors.push(`${doc.file}: missing image ${target}`);
  }
  for (const match of doc.source.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    if (target.startsWith("#")) {
      if (!doc.headings.has(target.slice(1))) errors.push(`${doc.file}: missing heading anchor ${target}`);
      continue;
    }
    if (!target.startsWith("/docs")) continue;
    const [route, anchor] = target.split("#");
    const linked = docsByHref.get(route.replace(/\/+$/, "") || "/docs");
    if (!linked) errors.push(`${doc.file}: missing internal route ${route}`);
    else if (anchor && !linked.headings.has(anchor)) errors.push(`${doc.file}: missing target anchor ${target}`);
  }
}

const tracker = fs.readFileSync(trackerPath, "utf8");
const trackerSlugs = new Set(
  [...tracker.matchAll(/^\|\s*([a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)\s*\|/gm)].map((match) => match[1])
);
for (const line of tracker.split(/\r?\n/).filter((value) => /^\|\s*[a-z0-9]/.test(value))) {
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length !== 7) errors.push(`docs/README.md: tracker row must have 7 columns: ${line}`);
  if (!/^(?:target|live|stub)$/.test(cells[3] ?? "")) errors.push(`docs/README.md: invalid status for ${cells[0] ?? "unknown"}`);
  if (!(cells[4] ?? "").trim()) errors.push(`docs/README.md: missing owner for ${cells[0] ?? "unknown"}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[5] ?? "")) errors.push(`docs/README.md: invalid verification date for ${cells[0] ?? "unknown"}`);
  if (!/^(?:none|desktop|mobile|both)$/.test(cells[6] ?? "")) errors.push(`docs/README.md: invalid screenshot status for ${cells[0] ?? "unknown"}`);
}
for (const doc of docs) {
  if (!trackerSlugs.has(doc.slug)) errors.push(`${doc.file}: missing sync tracker row for ${doc.slug}`);
}
for (const slug of trackerSlugs) {
  if (!slugSet.has(slug)) errors.push(`docs/README.md: tracker references missing public slug ${slug}`);
}

const contractDocs = docs.filter((doc) => doc.section === "Contracts for builders");
if (contractDocs.length !== 9) errors.push(`Expected 9 contract placeholder pages, found ${contractDocs.length}`);
if (docs.length !== 49) errors.push(`Expected 49 public docs pages, found ${docs.length}`);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Validated ${docs.length} public docs pages and ${trackerSlugs.size} tracker entries.`);
}
