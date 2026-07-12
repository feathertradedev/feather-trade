#!/usr/bin/env node
"use strict";

const net = require("node:net");

async function isLoopbackPortAvailable(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be an integer from 1 to 65535");
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function main() {
  const port = Number(process.argv[2]);
  if (!await isLoopbackPortAvailable(port)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Port availability check failed");
    process.exitCode = 2;
  });
}

module.exports = { isLoopbackPortAvailable };
