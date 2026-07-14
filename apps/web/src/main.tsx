import React, { type ComponentType } from "react";
import { createRoot } from "react-dom/client";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found");
}

const isDocsRoute = window.location.pathname === "/docs" || window.location.pathname.startsWith("/docs/");
const entry = isDocsRoute ? await import("./docs/DocsApp") : await import("./app-entry");
const Root = entry.default as ComponentType;

createRoot(rootElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
