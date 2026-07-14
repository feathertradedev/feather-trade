import type { ComponentType } from "react";

import { generatedDocsIndex } from "./generated-index";
import type { DocFrontmatter, DocHeading, DocRecord, DocsManifest, DocsSearchEntry } from "./types";

interface DocModule {
  default: ComponentType;
  frontmatter: DocFrontmatter;
}

const modules = import.meta.glob("../../docs/content/**/*.mdx", { eager: true }) as Record<string, DocModule>;

export const DOC_SECTIONS = [
  "Overview",
  "Getting started",
  "Pools and trading",
  "Liquidity",
  "Safety and troubleshooting",
  "Contracts for builders"
] as const;

function assertFrontmatter(path: string, value: unknown): asserts value is DocFrontmatter {
  if (typeof value !== "object" || value === null) throw new Error(`${path}: missing frontmatter`);
  const frontmatter = value as Partial<DocFrontmatter>;
  for (const field of ["audience", "description", "lastReviewed", "section", "slug", "title"] as const) {
    if (typeof frontmatter[field] !== "string" || frontmatter[field] === "") {
      throw new Error(`${path}: frontmatter.${field} is required`);
    }
  }
  if (!Number.isInteger(frontmatter.order) || Number(frontmatter.order) < 1) {
    throw new Error(`${path}: frontmatter.order must be a positive integer`);
  }
  if (!DOC_SECTIONS.includes(frontmatter.section as (typeof DOC_SECTIONS)[number])) {
    throw new Error(`${path}: unsupported frontmatter.section ${frontmatter.section}`);
  }
  if (frontmatter.audience !== "user" && frontmatter.audience !== "builder") {
    throw new Error(`${path}: frontmatter.audience must be user or builder`);
  }
  if (typeof frontmatter.lastReviewed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(frontmatter.lastReviewed)) {
    throw new Error(`${path}: frontmatter.lastReviewed must use YYYY-MM-DD`);
  }
  if (typeof frontmatter.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(frontmatter.slug)) {
    throw new Error(`${path}: frontmatter.slug must be a lowercase docs path`);
  }
}

const docs = Object.entries(modules).map(([sourcePath, module]): DocRecord => {
  assertFrontmatter(sourcePath, module.frontmatter);
  const generated = generatedDocsIndex[module.frontmatter.slug];
  if (!generated) throw new Error(`${sourcePath}: generated docs index entry is unavailable`);
  const href = module.frontmatter.slug === "welcome" ? "/docs" : `/docs/${module.frontmatter.slug}`;
  return {
    ...module.frontmatter,
    Component: module.default,
    headings: generated.headings as DocHeading[],
    href,
    searchText: generated.searchText,
    sourcePath
  };
});

const seenSlugs = new Set<string>();
for (const doc of docs) {
  if (seenSlugs.has(doc.slug)) throw new Error(`Duplicate docs slug: ${doc.slug}`);
  seenSlugs.add(doc.slug);
}

docs.sort((left, right) => {
  const sectionDelta = DOC_SECTIONS.indexOf(left.section as (typeof DOC_SECTIONS)[number]) - DOC_SECTIONS.indexOf(right.section as (typeof DOC_SECTIONS)[number]);
  return sectionDelta || left.order - right.order || left.title.localeCompare(right.title);
});

export const docsManifest: DocsManifest = { docs, sections: DOC_SECTIONS };

export const docsSearchIndex: DocsSearchEntry[] = docs.map((doc) => ({
  description: doc.description,
  headings: doc.headings,
  href: doc.href,
  section: doc.section,
  text: doc.searchText,
  title: doc.title
}));

export function docForPath(pathname: string): DocRecord | null {
  const normalized = pathname.replace(/\/+$/, "") || "/docs";
  if (normalized === "/docs/welcome") return docs.find((doc) => doc.slug === "welcome") ?? null;
  return docs.find((doc) => doc.href === normalized) ?? null;
}
