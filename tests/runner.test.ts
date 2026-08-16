import { describe, expect, it, vi } from "vitest";
import type { CommandResult, ObsidianExecutor } from "../src/types.js";
import { runChecked, withVault } from "../src/runner.js";
import { ObsidianCliRunner } from "../src/runner.js";

const result = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  args: [],
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  ...overrides,
});

describe("runner helpers", () => {
  it("prepends the vault selector without mutating the input", () => {
    const args = ["search", "query=idea"] as const;
    expect(withVault(args, "Personal")).toEqual(["vault=Personal", "search", "query=idea"]);
    expect(args).toEqual(["search", "query=idea"]);
    expect(withVault(args, undefined)).toEqual(["search", "query=idea"]);
    expect(withVault(["vault=Existing", "search"], "Ignored")).toEqual(["vault=Existing", "search"]);
  });

  it("runChecked returns successful results and wraps non-zero exits", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn()
        .mockResolvedValueOnce(result({ stdout: "ok" }))
        .mockResolvedValueOnce(result({ exitCode: 2, stderr: "bad command" })),
    };
    await expect(runChecked(executor, ["version"])).resolves.toMatchObject({ stdout: "ok" });
    await expect(runChecked(executor, ["broken"])).rejects.toMatchObject({
      name: "ObsidianCliError",
      message: "Obsidian CLI command failed: bad command",
      result: expect.objectContaining({ exitCode: 2 }),
    });
  });

  it("normalizes Obsidian's exit-zero Error output into a failed result", async () => {
    const runner = new ObsidianCliRunner({
      obsidianBin: process.execPath,
      auditLogPath: "/tmp/unused.jsonl",
      commandTimeoutMs: 1_000,
    });
    const result = await runner.run([
      "-e",
      "process.stdout.write('Error: File not found')",
    ]);
    expect(result).toMatchObject({ exitCode: 1, stdout: "Error: File not found" });
  });
});
