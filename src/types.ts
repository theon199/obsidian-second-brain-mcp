export interface CommandResult {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CommandOptions {
  timeoutMs?: number | undefined;
  vault?: string | undefined;
}

export interface ObsidianExecutor {
  run(args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface Evidence {
  target?: string | undefined;
  before?: Record<string, unknown> | null | undefined;
  after?: Record<string, unknown> | null | undefined;
  summary: string;
}

export interface ToolEnvelope<T = unknown> {
  ok: boolean;
  data?: T | undefined;
  evidence?: Evidence | undefined;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  vault?: string | undefined;
  targets: string[];
  arguments: unknown;
  status: "success" | "error";
  durationMs: number;
  before?: Record<string, unknown> | null | undefined;
  after?: Record<string, unknown> | null | undefined;
  error?: string | undefined;
}
