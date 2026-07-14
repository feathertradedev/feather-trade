declare module "*.mdx" {
  import type { ComponentType } from "react";

  export const frontmatter: {
    audience: "user" | "builder";
    description: string;
    lastReviewed: string;
    order: number;
    section: string;
    slug: string;
    title: string;
  };

  const component: ComponentType;
  export default component;
}
