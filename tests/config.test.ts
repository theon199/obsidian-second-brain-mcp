import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const homedirMock = vi.fn(() => "/mock-home");

vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));
vi.mock("node:os", () => ({ homedir: homedirMock }));

const { detectOpenVaultId, loadConfig } = await import("../src/config.js");

describe("Obsidian configuration", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    homedirMock.mockClear();
  });

  it("selects the most recently updated open vault", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        vaults: {
          older: { path: "/vault/older", open: true, ts: 10 },
          newest: { path: "/vault/newest", open: true, ts: 30 },
          closedButRecent: { path: "/vault/closed", open: false, ts: 100 },
        },
      }),
    );

    await expect(detectOpenVaultId()).resolves.toBe("newest");
    expect(readFileMock).toHaveBeenCalledWith(
      "/mock-home/Library/Application Support/obsidian/obsidian.json",
      "utf8",
    );
  });

  it("falls back to the most recent vault when no vault is marked open", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        vaults: {
          first: { ts: 1 },
          second: { ts: 2 },
        },
      }),
    );
    await expect(detectOpenVaultId()).resolves.toBe("second");
  });

  it("returns undefined for missing or malformed Obsidian config", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    await expect(detectOpenVaultId()).resolves.toBeUndefined();

    readFileMock.mockResolvedValue("not json");
    await expect(detectOpenVaultId()).resolves.toBeUndefined();
  });

  it("honors environment overrides and validates timeout", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ vaults: { detected: { ts: 1 } } }));
    await expect(
      loadConfig({
        OBSIDIAN_BIN: "/custom/obsidian",
        OBSIDIAN_VAULT_ID: "explicit",
        OBSIDIAN_MCP_AUDIT_LOG: "/tmp/obsidian-audit.jsonl",
        OBSIDIAN_MCP_TIMEOUT_MS: "1234",
      }),
    ).resolves.toEqual({
      obsidianBin: "/custom/obsidian",
      vault: "explicit",
      auditLogPath: "/tmp/obsidian-audit.jsonl",
      commandTimeoutMs: 1234,
    });

    await expect(loadConfig({ OBSIDIAN_MCP_TIMEOUT_MS: "-1" })).resolves.toMatchObject({
      commandTimeoutMs: 30_000,
    });
  });
});
