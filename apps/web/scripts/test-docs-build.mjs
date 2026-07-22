import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(webRoot, "dist");
const errors = [];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const requireFile = (relative) => {
  const target = path.join(dist, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`Missing ${relative}`);
  return target;
};

const manifestPath = requireFile("docs/docs-manifest.json");
const searchPath = requireFile("docs/search-index.json");
requireFile("docs/index.html");
requireFile("docs/pools/swap/index.html");
requireFile("docs/contracts/mainnet-deployments/index.html");
requireFile("sitemap.xml");

for (const controlFile of ["_worker.js", "_headers", "_redirects"]) {
  if (fs.existsSync(path.join(dist, controlFile))) errors.push(`Cloudflare control file must not be published: ${controlFile}`);
}

if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.length !== 49) errors.push(`Expected 49 manifest entries, found ${manifest.length}`);
  for (const entry of manifest) {
    const file = entry.slug === "welcome" ? "docs/index.html" : `docs/${entry.slug}/index.html`;
    const htmlPath = requireFile(file);
    if (!fs.existsSync(htmlPath)) continue;
    const html = fs.readFileSync(htmlPath, "utf8");
    if (!html.includes(`<h1>${escapeHtml(entry.title)}</h1>`)) errors.push(`${file}: missing prerendered h1`);
    if (!html.includes(`rel="canonical" href="https://feather.markets${entry.href}"`)) errors.push(`${file}: missing canonical URL`);
    if (!html.includes('type="application/ld+json"')) errors.push(`${file}: missing structured data`);
    if (!html.includes('"@type":"BreadcrumbList"')) errors.push(`${file}: missing breadcrumb structured data`);
    if (!html.includes(`property="og:url" content="https://feather.markets${entry.href}"`)) errors.push(`${file}: missing Open Graph URL`);
  }
}

if (fs.existsSync(searchPath)) {
  const search = JSON.parse(fs.readFileSync(searchPath, "utf8"));
  if (search.length !== 49 || search.some((entry) => !entry.text || !entry.href)) errors.push("Search index is incomplete");
}

const searchable = fs.readdirSync(path.join(dist, "assets")).filter((file) => file.endsWith(".js")).map((file) => fs.readFileSync(path.join(dist, "assets", file), "utf8")).join("\n");
if (!searchable.includes("feather-docs-theme")) errors.push("Docs runtime chunk is missing");

if (errors.length > 0) {
  errors.forEach((error) => console.error(error));
  process.exitCode = 1;
} else {
  console.log("Validated provider-neutral prerendered docs, search index, and metadata.");
}
