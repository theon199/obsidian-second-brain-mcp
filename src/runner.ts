import { execFile } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { CommandOptions, CommandResult, ObsidianExecutor } from "./types.js";

export class ObsidianCliError extends Error {
  constructor(
    message: string,
    public readonly result: CommandResult,
  ) {
    super(message);
    this.name = "ObsidianCliError";
  }
}

export function withVault(args: readonly string[], vault?: string): string[] {
  const copy = [...args];
  const suppliedVault = copy.find((arg) => arg.startsWith("vault="));
  const remaining = copy.filter((arg) => !arg.startsWith("vault="));
  const selected = suppliedVault ?? (vault ? `vault=${vault}` : undefined);
  return selected ? [selected, ...remaining] : remaining;
}

export class ObsidianCliRunner implements ObsidianExecutor {
  constructor(private readonly config: AppConfig) {}

  async run(args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
    const commandArgs = withVault(args, options.vault ?? this.config.vault);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      execFile(
        this.config.obsidianBin,
        commandArgs,
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? this.config.commandTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const stdoutText = String(stdout ?? "").trimEnd();
          const stderrText = String(stderr ?? "").trimEnd();
          const command = commandArgs.find((arg) => !arg.startsWith("vault="))?.toLowerCase() ?? "";
          const contentCommands = new Set([
            "read",
            "daily:read",
            "template:read",
            "random:read",
            "history:read",
            "sync:read",
            "search:context",
          ]);
          const reportedError =
            /(^|\n)\s*Error:/i.test(stderrText) ||
            (!contentCommands.has(command) && /(^|\n)\s*Error:/i.test(stdoutText));
          const result: CommandResult = {
            args: commandArgs,
            stdout: stdoutText,
            stderr: stderrText,
            exitCode:
              typeof (error as NodeJS.ErrnoException | null)?.code === "number"
                ? ((error as unknown as { code: number }).code ?? 1)
                : error || reportedError
                  ? 1
                  : 0,
            durationMs: Math.round(performance.now() - started),
          };
          if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
            reject(
              new ObsidianCliError(
                `Obsidian CLI was not found at '${this.config.obsidianBin}'. Enable Settings → General → Command line interface in Obsidian 1.12.7+.`,
                result,
              ),
            );
            return;
          }
          resolve(result);
        },
      );
    });
  }
}

export async function runChecked(
  executor: ObsidianExecutor,
  args: readonly string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  const result = await executor.run(args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    throw new ObsidianCliError(`Obsidian CLI command failed: ${detail}`, result);
  }
  return result;
}
