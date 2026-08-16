#!/usr/bin/env node

/**
 * Install the local Obsidian MCP server into Codex and/or Antigravity.
 *
 * This script intentionally uses only Node.js built-ins. It does not inspect
 * or print vault note content; the only Obsidian data it reads is the local
 * application registry, which is used to identify the active vault ID.
 */

import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const entrypoint = resolve(projectRoot, "dist", "index.js");
const codexConfigPath = join(homedir(), ".codex", "config.toml");
const antigravityConfigPath = join(homedir(), ".gemini", "config", "mcp_config.json");
const obsidianRegistryPath = join(
  homedir(),
  "Library",
  "Application Support",
  "obsidian",
  "obsidian.json",
);

function usage() {
  console.log(`Usage: node scripts/install.mjs [options]

Options:
  --dry-run             Validate prerequisites and show planned changes only
  --codex-only          Update Codex only
  --antigravity-only    Update Antigravity only
  --help                Show this help

The default updates both clients. Existing settings are preserved and each
existing config is backed up before a real update.`);
}

function parseArgs(argv) {
  const flags = new Set(argv);
  if (flags.has("--help")) {
    usage();
    process.exit(0);
  }
  const allowed = new Set(["--dry-run", "--codex-only", "--antigravity-only"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown.join(", ")}`);
  }
  if (flags.has("--codex-only") && flags.has("--antigravity-only")) {
    throw new Error("--codex-only and --antigravity-only cannot be used together.");
  }
  return {
    dryRun: flags.has("--dry-run"),
    codex: !flags.has("--antigravity-only"),
    antigravity: !flags.has("--codex-only"),
  };
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveExecutable(candidate) {
  if (candidate.includes("/")) {
    const absolute = resolve(candidate);
    try {
      await access(absolute, fsConstants.X_OK);
      return (await stat(absolute)).isFile() ? absolute : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const result = execFileSync("which", [candidate], { encoding: "utf8" }).trim();
    if (!result) return undefined;
    await access(result, fsConstants.X_OK);
    return (await stat(result)).isFile() ? result : undefined;
  } catch {
    return undefined;
  }
}

async function resolveObsidianBin() {
  return resolveExecutable(process.env.OBSIDIAN_BIN || "obsidian");
}

async function readOpenVaultId() {
  try {
    const parsed = JSON.parse(await readFile(obsidianRegistryPath, "utf8"));
    const vaults = Object.entries(parsed?.vaults ?? {});
    const selected =
      vaults
        .filter(([, value]) => value && value.open === true)
        .sort(([, left], [, right]) => (right?.ts ?? 0) - (left?.ts ?? 0))[0] ??
      vaults.sort(([, left], [, right]) => (right?.ts ?? 0) - (left?.ts ?? 0))[0];
    if (!selected) return undefined;
    return { id: selected[0], path: selected[1]?.path };
  } catch {
    return undefined;
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function sectionBounds(lines, sectionName) {
  const header = new RegExp(`^\\s*\\[${sectionName.replaceAll(".", "\\.")}\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function mergeTomlSection(lines, sectionName, values) {
  const bounds = sectionBounds(lines, sectionName);
  if (!bounds) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(`[${sectionName}]`);
    for (const [key, value] of Object.entries(values)) lines.push(`${key} = ${value}`);
    return lines;
  }

  for (const [key, value] of Object.entries(values)) {
    let replaced = false;
    for (let index = bounds.start + 1; index < bounds.end; index += 1) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
        lines[index] = `${key} = ${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.splice(bounds.end, 0, `${key} = ${value}`);
      bounds.end += 1;
    }
  }
  return lines;
}

/** Merge the dedicated server and environment tables, retaining unknown user settings. */
function mergeCodexConfig(text, server) {
  let lines = text ? text.split("\n") : [];
  lines = mergeTomlSection(lines, "mcp_servers.obsidian", {
    command: tomlString(server.command),
    args: tomlArray(server.args),
    default_tools_approval_mode: tomlString("auto"),
  });
  lines = mergeTomlSection(
    lines,
    "mcp_servers.obsidian.env",
    Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, tomlString(value)])),
  );
  return lines.join("\n");
}

function mergeAntigravityConfig(text, server) {
  let parsed = {};
  if (text.trim()) {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${antigravityConfigPath} must contain a JSON object.`);
    }
  }
  const existing = parsed.mcpServers;
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
    throw new Error(`${antigravityConfigPath} has a non-object mcpServers value.`);
  }
  const priorServer = existing?.obsidian;
  parsed.mcpServers = {
    ...(existing ?? {}),
    obsidian: {
      ...(priorServer && typeof priorServer === "object" && !Array.isArray(priorServer) ? priorServer : {}),
      command: server.command,
      args: server.args,
      env: {
        ...(priorServer?.env && typeof priorServer.env === "object" && !Array.isArray(priorServer.env)
          ? priorServer.env
          : {}),
        ...server.env,
      },
    },
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function readTextIfPresent(filePath) {
  return (await exists(filePath)) ? readFile(filePath, "utf8") : "";
}

function backupPath(filePath) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return `${filePath}.bak.${stamp}.${randomBytes(3).toString("hex")}`;
}

async function writeAtomically(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function installConfig(filePath, content, dryRun) {
  const current = await exists(filePath);
  const backup = current ? backupPath(filePath) : undefined;
  if (dryRun) {
    console.log(`DRY-RUN ${current ? "would back up and update" : "would create"} ${filePath}`);
    if (backup) console.log(`DRY-RUN backup: ${backup}`);
    return;
  }
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (backup) await copyFile(filePath, backup);
  await writeAtomically(filePath, content);
  console.log(`Updated ${filePath}${backup ? ` (backup: ${backup})` : ""}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodePath = process.execPath;
  const entrypointReady = await isRegularFile(entrypoint);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeReady = (await isRegularFile(nodePath)) && Number.isInteger(nodeMajor) && nodeMajor >= 20;
  const obsidianBin = await resolveObsidianBin();
  const obsidianReady = Boolean(obsidianBin);

  if (!entrypointReady) {
    throw new Error(`Compiled entrypoint not found: ${entrypoint}. Run npm run build first.`);
  }
  if (!nodeReady) {
    throw new Error(`Resolved Node must be version 20 or newer and accessible: ${nodePath} (version ${process.versions.node}).`);
  }
  if (!obsidianReady && !options.dryRun) {
    throw new Error(
      "Obsidian CLI was not found. In Obsidian, enable Settings → General → Command line interface, then retry (or set OBSIDIAN_BIN).",
    );
  }
  const detectedVault = await readOpenVaultId();
  const vault = process.env.OBSIDIAN_VAULT_ID
    ? { id: process.env.OBSIDIAN_VAULT_ID, path: undefined }
    : detectedVault;
  if (!vault?.id && !options.dryRun) {
    throw new Error(
      "No Obsidian vault could be selected. Open a vault in Obsidian or set OBSIDIAN_VAULT_ID, then retry.",
    );
  }
  const server = {
    command: nodePath,
    args: [entrypoint],
    env: {
      ...(obsidianBin ? { OBSIDIAN_BIN: obsidianBin } : {}),
      ...(vault?.id ? { OBSIDIAN_VAULT_ID: vault.id } : {}),
    },
  };

  console.log(`Project: ${projectRoot}`);
  console.log(`Node: ${nodePath} (version ${process.versions.node})${nodeReady ? " (ok)" : " (unsupported)"}`);
  console.log(`Entrypoint: ${entrypoint}${entrypointReady ? " (ok)" : " (missing)"}`);
  console.log(`Obsidian CLI: ${obsidianBin ?? "not found"}${obsidianReady ? " (ok)" : " (missing)"}`);
  console.log(`Open vault ID: ${vault?.id ?? "not detected (the MCP will use its runtime detection)"}`);
  if (vault?.path) console.log(`Open vault path: ${vault.path}`);

  const installations = [];
  if (options.codex) {
    const current = await readTextIfPresent(codexConfigPath);
    installations.push({ path: codexConfigPath, content: mergeCodexConfig(current, server) });
  }
  if (options.antigravity) {
    const current = await readTextIfPresent(antigravityConfigPath);
    installations.push({ path: antigravityConfigPath, content: mergeAntigravityConfig(current, server) });
  }
  // Parse and prepare every requested config before writing any of them. A
  // malformed second config therefore cannot leave the first one updated.
  for (const installation of installations) {
    await installConfig(installation.path, installation.content, options.dryRun);
  }
  if (options.dryRun) {
    console.log("Dry run complete. No client configuration, backup, or vault files were changed.");
    if (!obsidianReady) console.log("Note: a real install will require the Obsidian CLI to be enabled first.");
  } else {
    console.log("Restart Codex/Antigravity (or refresh their MCP view) to load the server.");
  }
}

main().catch((error) => {
  console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
