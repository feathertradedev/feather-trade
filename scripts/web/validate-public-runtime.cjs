#!/usr/bin/env node
"use strict";

const projectId = process.env.VITE_REOWN_PROJECT_ID?.trim() ?? "";

if (!/^[A-Za-z0-9_-]{16,128}$/.test(projectId)) {
  console.error("VITE_REOWN_PROJECT_ID must be a 16-128 character public Reown project ID");
  process.exitCode = 1;
} else {
  console.log("Validated public wallet runtime configuration.");
}
