#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsonlAuditLogger } from "./audit.js";
import { loadConfig } from "./config.js";
import { ObsidianCliRunner } from "./runner.js";
import { buildServer } from "./server.js";

const config = await loadConfig();
const runner = new ObsidianCliRunner(config);
const audit = new JsonlAuditLogger(config.auditLogPath);

const handle = serveStdio(() =>
  buildServer({
    executor: runner,
    audit,
    ...(config.vault ? { defaultVault: config.vault } : {}),
  }),
);

process.on("SIGINT", () => {
  void handle.close();
});

process.on("SIGTERM", () => {
  void handle.close();
});
