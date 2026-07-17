import type { ComponentType } from "react";

export type DocAudience = "user" | "builder";

export interface DocFrontmatter {
  audience: DocAudience;
  description: string;
  lastReviewed: string;
  order: number;
  section: string;
  slug: string;
  title: string;
}

export interface DocHeading {
  depth: 2 | 3;
  id: string;
  title: string;
}

export interface DocRecord extends DocFrontmatter {
  Component: ComponentType;
  headings: DocHeading[];
  href: string;
  searchText: string;
  sourcePath: string;
}

export interface DocsManifest {
  docs: DocRecord[];
  sections: readonly string[];
}

export interface DocsSearchEntry {
  description: string;
  headings: DocHeading[];
  href: string;
  section: string;
  text: string;
  title: string;
}
