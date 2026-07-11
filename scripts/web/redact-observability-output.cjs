#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

let output = fs.readFileSync(0, "utf8");
const values = Object.entries(process.env)
  .filter(([name]) => name.startsWith("OBSERVABILITY_REDACT_"))
  .flatMap(([, value]) => (value ?? "").split(/\r?\n/))
  .filter(Boolean)
  .sort((left, right) => right.length - left.length);

for (const value of values) {
  output = output.split(value).join("[REDACTED]");
  try {
    const url = new URL(value);
    for (const credential of [url.hostname, url.host, url.username, url.password, ...url.searchParams.values(), ...url.pathname.split("/")]) {
      if (credential.length >= 8) output = output.split(credential).join("[REDACTED]");
    }
  } catch {}
}

process.stdout.write(output);
