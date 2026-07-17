import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile, run } from "@mdx-js/mdx";
import matter from "gray-matter";
import rehypeSlug from "rehype-slug";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(webRoot, "docs/content");
const distRoot = path.join(webRoot, "dist");
const canonicalOrigin = "https://feather.markets";

function listMdx(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listMdx(target) : entry.name.endsWith(".mdx") ? [target] : [];
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function textContent(source) {
  return source.replace(/<[^>]+>/g, " ").replace(/[`*_#>\[\](){}|]/g, " ").replace(/\s+/g, " ").trim();
}

function callout(kind) {
  return function StaticCallout({ children, title }) {
    return React.createElement("aside", { className: `docs-callout docs-callout-${kind}` },
      React.createElement("div", null, title ? React.createElement("strong", null, title) : null, children));
  };
}

const components = {
  Callout: callout("note"),
  Risk: callout("risk"),
  Warning: callout("warning"),
  Steps: ({ children }) => React.createElement("div", { className: "docs-steps" }, children),
  Definition: ({ children, term }) => React.createElement("div", { className: "docs-definition" }, React.createElement("dt", null, term), React.createElement("dd", null, children)),
  ContractAddress: ({ label, value }) => React.createElement("div", { className: "docs-contract-address" }, React.createElement("span", null, label), React.createElement("code", null, value ?? "Publishes after verified mainnet deployment")),
  MethodSummary: ({ children, name }) => React.createElement("section", { className: "docs-method" }, React.createElement("code", null, name), React.createElement("div", null, children))
};

const indexTemplate = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
const docsCss = fs.readdirSync(path.join(distRoot, "assets")).find((file) => /^DocsApp-.+\.css$/.test(file));
const docs = [];

for (const file of listMdx(contentRoot)) {
  const parsed = matter(fs.readFileSync(file, "utf8"));
  const compiled = await compile(parsed.content, { outputFormat: "function-body", rehypePlugins: [rehypeSlug], remarkPlugins: [remarkGfm] });
  const module = await run(String(compiled), runtime);
  const renderedContent = renderToStaticMarkup(React.createElement(module.default, { components }));
  const href = parsed.data.slug === "welcome" ? "/docs" : `/docs/${parsed.data.slug}`;
  const canonical = `${canonicalOrigin}${href}`;
  const breadcrumb = `<nav aria-label="Breadcrumb" class="docs-breadcrumb"><a href="/docs">Docs</a><span>/</span><span>${escapeHtml(parsed.data.section)}</span></nav>`;
  const article = `<div class="docs-app"><main class="docs-main docs-prerender-main">${breadcrumb}<article class="docs-article"><header><p class="docs-section-label">${escapeHtml(parsed.data.section)}</p><h1>${escapeHtml(parsed.data.title)}</h1><p>${escapeHtml(parsed.data.description)}</p><small>Last reviewed ${escapeHtml(parsed.data.lastReviewed)}</small></header>${renderedContent}</article></main></div>`;
  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "TechArticle", headline: parsed.data.title, description: parsed.data.description, dateModified: parsed.data.lastReviewed, url: canonical },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Feather Docs", item: `${canonicalOrigin}/docs` },
        { "@type": "ListItem", position: 2, name: parsed.data.section },
        { "@type": "ListItem", position: 3, name: parsed.data.title, item: canonical }
      ] }
    ]
  });
  let html = indexTemplate
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(parsed.data.title)} | Feather Docs</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escapeHtml(parsed.data.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(parsed.data.title)} | Feather Docs" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(parsed.data.description)}" />`)
    .replace("</head>", `<meta property="og:type" content="article" /><meta property="og:url" content="${canonical}" />${docsCss ? `<link rel="stylesheet" href="/assets/${docsCss}" />` : ""}<link rel="canonical" href="${canonical}" /><script type="application/ld+json">${structured.replace(/</g, "\\u003c")}</script></head>`)
    .replace('<div id="root"></div>', `<div id="root">${article}</div>`);
  const outputDirectory = parsed.data.slug === "welcome" ? path.join(distRoot, "docs") : path.join(distRoot, "docs", parsed.data.slug);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "index.html"), html);
  docs.push({ ...parsed.data, href, searchText: textContent(parsed.content) });
}

docs.sort((left, right) => left.href.localeCompare(right.href));
fs.writeFileSync(path.join(distRoot, "docs/docs-manifest.json"), JSON.stringify(docs.map(({ searchText, ...doc }) => doc), null, 2));
fs.writeFileSync(path.join(distRoot, "docs/search-index.json"), JSON.stringify(docs.map((doc) => ({ title: doc.title, description: doc.description, section: doc.section, href: doc.href, text: doc.searchText })), null, 2));
fs.writeFileSync(path.join(distRoot, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${docs.map((doc) => `  <url><loc>${canonicalOrigin}${doc.href}</loc><lastmod>${doc.lastReviewed}</lastmod></url>`).join("\n")}\n</urlset>\n`);
console.log(`Prerendered ${docs.length} documentation routes.`);
