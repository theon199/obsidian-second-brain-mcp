import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  obsidianBin: string;
  vault?: string;
  auditLogPath: string;
  commandTimeoutMs: number;
}

interface ObsidianVaultConfig {
  path?: string;
  ts?: number;
  open?: boolean;
}

export async function detectOpenVaultId(): Promise<string | undefined> {
  const configPath = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      vaults?: Record<string, ObsidianVaultConfig>;
    };
    const vaults = Object.entries(parsed.vaults ?? {});
    const selected = vaults
      .filter(([, value]) => value.open)
      .sort(([, a], [, b]) => (b.ts ?? 0) - (a.ts ?? 0))[0] ??
      vaults.sort(([, a], [, b]) => (b.ts ?? 0) - (a.ts ?? 0))[0];
    return selected?.[0];
  } catch {
    return undefined;
  }
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const detectedVault = await detectOpenVaultId();
  const selectedVault = env.OBSIDIAN_VAULT_ID || detectedVault;
  const timeout = Number(env.OBSIDIAN_MCP_TIMEOUT_MS ?? 30_000);
  return {
    obsidianBin: env.OBSIDIAN_BIN || "obsidian",
    ...(selectedVault ? { vault: selectedVault } : {}),
    auditLogPath:
      env.OBSIDIAN_MCP_AUDIT_LOG ||
      join(homedir(), "Library", "Application Support", "obsidian-mcp", "audit.jsonl"),
    commandTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
}
