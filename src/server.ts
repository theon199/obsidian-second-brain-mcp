import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AuditSink } from "./audit.js";
import { nonEmptyLines, parseCount, parseJsonOrText } from "./parse.js";
import { runChecked } from "./runner.js";
import {
  digest,
  inferTargets,
  isMutation,
  sanitizeForAudit,
  isVaultRelativePath,
  validateGenericArgs,
} from "./safety.js";
import type { AuditEntry, CommandResult, ObsidianExecutor, ToolEnvelope } from "./types.js";

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  evidence: z.unknown().optional(),
});

const vaultPathSchema = z
  .string()
  .min(1)
  .refine(isVaultRelativePath, "Path must be relative to the configured vault without '..' segments.");

const targetSchema = z
  .object({
    path: vaultPathSchema.optional().describe("Exact vault-relative path, including .md when relevant"),
    file: vaultPathSchema.optional().describe("Obsidian link-resolved file name"),
  })
  .refine((value) => Boolean(value.path || value.file), "Provide either path or file.")
  .refine((value) => !(value.path && value.file), "Provide path or file, not both.");

type Target = z.infer<typeof targetSchema>;

export interface ServerDependencies {
  executor: ObsidianExecutor;
  audit: AuditSink;
  defaultVault?: string;
}

function targetArgs(target: Target): string[] {
  return target.path ? [`path=${target.path}`] : [`file=${target.file}`];
}

function targetLabel(target: Target): string {
  return target.path ?? target.file ?? "active file";
}

function output<T>(envelope: ToolEnvelope<T>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

function errorOutput(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function sampleLines(text: string, max = 50): { count: number; sample: string[]; truncated: boolean } {
  const lines = nonEmptyLines(text);
  return { count: lines.length, sample: lines.slice(0, max), truncated: lines.length > max };
}

async function snapshot(
  executor: ObsidianExecutor,
  target: Target | undefined,
  vault?: string,
): Promise<Record<string, unknown> | null> {
  if (!target) return null;
  const args = targetArgs(target);
  const info = await executor.run(["file", ...args], { vault });
  if (info.exitCode !== 0) return null;
  const content = await executor.run(["read", ...args], { vault });
  return {
    target: targetLabel(target),
    info: parseJsonOrText(info.stdout),
    ...(content.exitCode === 0
      ? { contentLength: content.stdout.length, contentSha256: digest(content.stdout) }
      : {}),
  };
}

async function auditMutation<T>(options: {
  tool: string;
  input: unknown;
  deps: ServerDependencies;
  beforeTarget?: Target;
  afterTarget?: Target;
  action: () => Promise<{ data: T; results: CommandResult[] }>;
}): Promise<ToolEnvelope<T>> {
  const started = performance.now();
  let before: Record<string, unknown> | null = null;
  try {
    before = await snapshot(options.deps.executor, options.beforeTarget, options.deps.defaultVault);
    const { data, results } = await options.action();
    const after = await snapshot(
      options.deps.executor,
      options.afterTarget ?? options.beforeTarget,
      options.deps.defaultVault,
    );
    const durationMs = Math.round(performance.now() - started);
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      tool: options.tool,
      ...(options.deps.defaultVault ? { vault: options.deps.defaultVault } : {}),
      targets: inferTargets(options.input),
      arguments: sanitizeForAudit(options.input),
      status: "success",
      durationMs,
      before,
      after,
    };
    await options.deps.audit.write(entry);
    return {
      ok: true,
      data,
      evidence: {
        ...(options.beforeTarget || options.afterTarget
          ? { target: targetLabel(options.afterTarget ?? options.beforeTarget!) }
          : {}),
        before,
        after,
        summary: `${options.tool} completed using ${results.length} Obsidian CLI command${results.length === 1 ? "" : "s"}.`,
      },
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    await options.deps.audit.write({
      timestamp: new Date().toISOString(),
      tool: options.tool,
      ...(options.deps.defaultVault ? { vault: options.deps.defaultVault } : {}),
      targets: inferTargets(options.input),
      arguments: sanitizeForAudit(options.input),
      status: "error",
      durationMs,
      before,
      // Error strings from external CLIs can echo user-supplied arguments.
      // Keep the audit useful without risking a copy of note content.
      error: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

async function setProperties(
  executor: ObsidianExecutor,
  target: Target,
  properties: Record<string, string | number | boolean | string[]>,
  vault?: string,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const [name, rawValue] of Object.entries(properties)) {
    const type = Array.isArray(rawValue)
      ? "list"
      : typeof rawValue === "number"
        ? "number"
        : typeof rawValue === "boolean"
          ? "checkbox"
          : "text";
    const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
    results.push(
      await runChecked(
        executor,
        ["property:set", `name=${name}`, `value=${value}`, `type=${type}`, ...targetArgs(target)],
        { vault },
      ),
    );
  }
  return results;
}

export function buildServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: "local-obsidian", version: "1.0.0" },
    {
      instructions:
        "Use this server to inspect and automate the user's local Obsidian vault. Search before assuming a note exists; use read_note with links/backlinks before proposing connections. Prefer typed tools for normal work. Deletes always go to trash. run_obsidian_command blocks permanent deletion, eval, and dev controls. For creative coaching, call suggest_use_cases and ground recommendations in its vault evidence. Changes are autonomous and audited without copying note content into logs.",
    },
  );

  server.registerTool(
    "vault_overview",
    {
      title: "Vault Overview",
      description: "Summarize vault size, structure, tags, properties, link health, and tasks.",
      inputSchema: z.object({ sampleLimit: z.number().int().min(1).max(200).default(30) }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sampleLimit }) => {
      try {
        const commands = [
          ["vault"],
          ["files", "total"],
          ["folders", "total"],
          ["tags", "counts"],
          ["properties", "counts"],
          ["orphans"],
          ["deadends"],
          ["unresolved", "verbose"],
          ["tasks", "todo", "verbose"],
        ] as const;
        const results = await Promise.all(
          commands.map((args) => runChecked(deps.executor, args, { vault: deps.defaultVault })),
        );
        return output({
          ok: true,
          data: {
            vault: parseJsonOrText(results[0]!.stdout),
            files: parseCount(results[1]!.stdout),
            folders: parseCount(results[2]!.stdout),
            tags: sampleLines(results[3]!.stdout, sampleLimit),
            properties: sampleLines(results[4]!.stdout, sampleLimit),
            orphans: sampleLines(results[5]!.stdout, sampleLimit),
            deadends: sampleLines(results[6]!.stdout, sampleLimit),
            unresolved: sampleLines(results[7]!.stdout, sampleLimit),
            incompleteTasks: sampleLines(results[8]!.stdout, sampleLimit),
          },
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description: "Search the vault with optional matching-line context and folder filtering.",
      inputSchema: z.object({
        query: z.string().min(1),
        folder: vaultPathSchema.optional(),
        limit: z.number().int().min(1).max(500).default(50),
        caseSensitive: z.boolean().default(false),
        context: z.boolean().default(true),
      }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, folder, limit, caseSensitive, context }) => {
      try {
        const args = [context ? "search:context" : "search", `query=${query}`, `limit=${limit}`];
        if (folder) args.push(`path=${folder}`);
        if (caseSensitive) args.push("case");
        if (!context) args.push("format=json");
        const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
        return output({ ok: true, data: parseJsonOrText(result.stdout) });
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read Note With Context",
      description: "Read a note plus file metadata, outline, properties, outgoing links, and backlinks.",
      inputSchema: targetSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (target) => {
      try {
        const suffix = targetArgs(target);
        const commands = ["read", "file", "outline", "properties", "links", "backlinks"];
        const results = await Promise.all(
          commands.map((command) =>
            runChecked(
              deps.executor,
              command === "properties"
                ? [command, ...suffix, "format=json"]
                : command === "outline"
                  ? [command, ...suffix, "format=json"]
                  : command === "backlinks"
                    ? [command, ...suffix, "format=json", "counts"]
                    : [command, ...suffix],
              { vault: deps.defaultVault },
            ),
          ),
        );
        return output({
          ok: true,
          data: {
            target: targetLabel(target),
            content: results[0]!.stdout,
            file: parseJsonOrText(results[1]!.stdout),
            outline: parseJsonOrText(results[2]!.stdout),
            properties: parseJsonOrText(results[3]!.stdout),
            links: parseJsonOrText(results[4]!.stdout),
            backlinks: parseJsonOrText(results[5]!.stdout),
          },
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  const propertyValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
  const createSchema = z
    .object({
      path: vaultPathSchema.optional(),
      name: vaultPathSchema.optional(),
      content: z.string().optional(),
      template: z.string().min(1).optional(),
      properties: z.record(z.string(), propertyValue).default({}),
      open: z.boolean().default(false),
      overwrite: z.boolean().default(false),
    })
    .refine((value) => Boolean(value.path || value.name), "Provide path or name.")
    .refine((value) => !(value.path && value.name), "Provide path or name, not both.");

  server.registerTool(
    "create_note",
    {
      title: "Create Note",
      description: "Create a note from content or an Obsidian template and optionally set properties.",
      inputSchema: createSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      const target: Target = input.path ? { path: input.path } : { file: input.name! };
      try {
        const envelope = await auditMutation({
          tool: "create_note",
          input,
          deps,
          afterTarget: target,
          action: async () => {
            const args = ["create", input.path ? `path=${input.path}` : `name=${input.name}`];
            if (input.content !== undefined) args.push(`content=${input.content}`);
            if (input.template) args.push(`template=${input.template}`);
            if (input.open) args.push("open");
            if (input.overwrite) args.push("overwrite");
            const results = [await runChecked(deps.executor, args, { vault: deps.defaultVault })];
            results.push(...(await setProperties(deps.executor, target, input.properties, deps.defaultVault)));
            return { data: { target: targetLabel(target), created: true }, results };
          },
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  const updateSchema = targetSchema.and(
    z
      .object({
        append: z.string().optional(),
        prepend: z.string().optional(),
        setProperties: z.record(z.string(), propertyValue).default({}),
        removeProperties: z.array(z.string().min(1)).default([]),
        task: z
          .object({
            line: z.number().int().positive().optional(),
            ref: z.string().min(1).optional(),
            status: z.string().length(1).optional(),
            done: z.boolean().optional(),
          })
          .refine((value) => Boolean(value.ref || value.line), "Task update requires ref or line.")
          .refine(
            (value) => value.status !== undefined || value.done !== undefined,
            "Task update requires status or done.",
          )
          .refine(
            (value) => !(value.status !== undefined && value.done !== undefined),
            "Provide task status or done, not both.",
          )
          .optional(),
      })
      .refine(
        (value) =>
          value.append !== undefined ||
          value.prepend !== undefined ||
          Object.keys(value.setProperties).length > 0 ||
          value.removeProperties.length > 0 ||
          value.task !== undefined,
        "Provide at least one update operation.",
      ),
  );

  server.registerTool(
    "update_note",
    {
      title: "Update Note",
      description: "Append/prepend content, change properties, or update a task in a note.",
      inputSchema: updateSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      const target: Target = input.path ? { path: input.path } : { file: input.file! };
      try {
        const envelope = await auditMutation({
          tool: "update_note",
          input,
          deps,
          beforeTarget: target,
          action: async () => {
            const results: CommandResult[] = [];
            // Resolve task line numbers against the note state the caller inspected,
            // before frontmatter/prepend operations can shift those line numbers.
            if (input.task) {
              const args = ["task", ...targetArgs(target)];
              if (input.task.ref) args.push(`ref=${input.task.ref}`);
              if (input.task.line) args.push(`line=${input.task.line}`);
              if (input.task.status) args.push(`status=${input.task.status}`);
              else if (input.task.done !== undefined) args.push(input.task.done ? "done" : "todo");
              results.push(await runChecked(deps.executor, args, { vault: deps.defaultVault }));
            }
            if (input.append !== undefined) {
              results.push(
                await runChecked(deps.executor, ["append", ...targetArgs(target), `content=${input.append}`], {
                  vault: deps.defaultVault,
                }),
              );
            }
            if (input.prepend !== undefined) {
              results.push(
                await runChecked(deps.executor, ["prepend", ...targetArgs(target), `content=${input.prepend}`], {
                  vault: deps.defaultVault,
                }),
              );
            }
            results.push(
              ...(await setProperties(deps.executor, target, input.setProperties, deps.defaultVault)),
            );
            for (const name of input.removeProperties) {
              results.push(
                await runChecked(
                  deps.executor,
                  ["property:remove", `name=${name}`, ...targetArgs(target)],
                  { vault: deps.defaultVault },
                ),
              );
            }
            return {
              data: { target: targetLabel(target), operations: results.length },
              results,
            };
          },
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  const organizeSchema = targetSchema.and(
    z
      .object({
        action: z.enum(["move", "rename", "trash"]),
        destination: vaultPathSchema.optional(),
        newName: vaultPathSchema.optional(),
      })
      .refine((value) => value.action !== "move" || Boolean(value.destination), "Move requires destination.")
      .refine((value) => value.action !== "rename" || Boolean(value.newName), "Rename requires newName."),
  );

  server.registerTool(
    "organize_note",
    {
      title: "Organize or Trash Note",
      description: "Move, rename, or send a note to Obsidian trash. Permanent deletion is never used.",
      inputSchema: organizeSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      const beforeTarget: Target = input.path ? { path: input.path } : { file: input.file! };
      const afterTarget: Target | undefined =
        input.action === "move" && input.destination
          ? { path: input.destination }
          : input.action === "rename" && input.newName
            ? { file: input.newName }
            : undefined;
      try {
        const envelope = await auditMutation({
          tool: "organize_note",
          input,
          deps,
          beforeTarget,
          ...(afterTarget ? { afterTarget } : {}),
          action: async () => {
            const args =
              input.action === "move"
                ? ["move", ...targetArgs(beforeTarget), `to=${input.destination}`]
                : input.action === "rename"
                  ? ["rename", ...targetArgs(beforeTarget), `name=${input.newName}`]
                  : ["delete", ...targetArgs(beforeTarget)];
            const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
            return {
              data: {
                action: input.action,
                from: targetLabel(beforeTarget),
                ...(afterTarget ? { to: targetLabel(afterTarget) } : {}),
              },
              results: [result],
            };
          },
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  server.registerTool(
    "daily_note",
    {
      title: "Daily Note",
      description: "Read, open, append to, or prepend to the active daily note.",
      inputSchema: z.object({
        action: z.enum(["read", "open", "append", "prepend"]),
        content: z.string().optional(),
      }).refine((value) => ["read", "open"].includes(value.action) || value.content !== undefined, {
        message: "Append and prepend require content.",
      }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        if (input.action === "read") {
          const result = await runChecked(deps.executor, ["daily:read"], { vault: deps.defaultVault });
          return output({ ok: true, data: { content: result.stdout } });
        }
        const envelope = await auditMutation({
          tool: "daily_note",
          input,
          deps,
          action: async () => {
            const args =
              input.action === "open"
                ? ["daily"]
                : [`daily:${input.action}`, `content=${input.content ?? ""}`];
            const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
            return { data: { action: input.action, output: result.stdout }, results: [result] };
          },
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  const tasksSchema = z.object({
    action: z.enum(["list", "update"]),
    path: vaultPathSchema.optional(),
    file: vaultPathSchema.optional(),
    ref: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    filter: z.enum(["todo", "done", "all"]).default("todo"),
    status: z.string().length(1).optional(),
    done: z.boolean().optional(),
    daily: z.boolean().default(false),
  })
    .refine((value) => !(value.path && value.file), {
      message: "Provide path or file, not both.",
    })
    .refine((value) => value.action !== "update" || Boolean(value.ref || value.line), {
      message: "Updating a task requires ref or line.",
    })
    .refine(
      (value) => value.action !== "update" || value.status !== undefined || value.done !== undefined,
      { message: "Updating a task requires status or done." },
    )
    .refine(
      (value) => value.action !== "update" || !(value.status !== undefined && value.done !== undefined),
      { message: "Provide task status or done, not both." },
    );

  server.registerTool(
    "manage_tasks",
    {
      title: "Manage Tasks",
      description: "List tasks or change a task's completion/custom status.",
      inputSchema: tasksSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const optionalTarget: Target | undefined = input.path
          ? { path: input.path }
          : input.file
            ? { file: input.file }
            : undefined;
        if (input.action === "list") {
          const args = ["tasks"];
          if (optionalTarget) args.push(...targetArgs(optionalTarget));
          if (input.daily) args.push("daily");
          if (input.status) args.push(`status=${input.status}`);
          if (input.filter !== "all") args.push(input.filter);
          args.push("verbose", "format=json");
          const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
          return output({ ok: true, data: parseJsonOrText(result.stdout) });
        }
        const envelope = await auditMutation({
          tool: "manage_tasks",
          input,
          deps,
          ...(optionalTarget ? { beforeTarget: optionalTarget } : {}),
          action: async () => {
            const args = ["task"];
            if (optionalTarget) args.push(...targetArgs(optionalTarget));
            if (input.ref) args.push(`ref=${input.ref}`);
            if (input.line) args.push(`line=${input.line}`);
            if (input.daily) args.push("daily");
            if (input.status) args.push(`status=${input.status}`);
            else if (input.done !== undefined) args.push(input.done ? "done" : "todo");
            const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
            return { data: parseJsonOrText(result.stdout), results: [result] };
          },
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  server.registerTool(
    "suggest_use_cases",
    {
      title: "Suggest Creative Vault Workflows",
      description: "Analyze native graph and organization signals, then rank contextual second-brain workflows.",
      inputSchema: z.object({ sampleLimit: z.number().int().min(3).max(100).default(20) }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sampleLimit }) => {
      try {
        const commands = [
          ["orphans"],
          ["deadends"],
          ["unresolved", "verbose"],
          ["tags", "counts"],
          ["tasks", "todo", "verbose"],
          ["recents"],
        ] as const;
        const results = await Promise.all(
          commands.map((args) => runChecked(deps.executor, args, { vault: deps.defaultVault })),
        );
        const signals = {
          orphans: sampleLines(results[0]!.stdout, sampleLimit),
          deadends: sampleLines(results[1]!.stdout, sampleLimit),
          unresolved: sampleLines(results[2]!.stdout, sampleLimit),
          tags: sampleLines(results[3]!.stdout, sampleLimit),
          incompleteTasks: sampleLines(results[4]!.stdout, sampleLimit),
          recentNotes: sampleLines(results[5]!.stdout, sampleLimit),
        };
        const candidates = [
          {
            title: "Forgotten-note resurfacing ritual",
            score: signals.orphans.count * 3 + signals.deadends.count,
            why: `${signals.orphans.count} orphan and ${signals.deadends.count} dead-end notes can be resurfaced in a rotating daily review.`,
            nextPrompt: "Pick three orphan notes, summarize their latent value, and suggest where each should connect.",
          },
          {
            title: "Bridge-note generator",
            score: signals.orphans.count + signals.deadends.count * 2 + signals.tags.count,
            why: "Use shared tags and outgoing-link gaps to propose synthesis notes that bridge separate clusters.",
            nextPrompt: "Find two distant themes with evidence and outline a bridge note connecting them.",
          },
          {
            title: "Knowledge-gap radar",
            score: signals.unresolved.count * 4 + signals.deadends.count,
            why: `${signals.unresolved.count} unresolved-link entries and ${signals.deadends.count} dead ends reveal topics worth researching or pruning.`,
            nextPrompt: "Rank unresolved links by likely value and create a research queue in today's daily note.",
          },
          {
            title: "Weekly synthesis cockpit",
            score: signals.incompleteTasks.count * 2 + signals.recentNotes.count,
            why: "Recent notes and unfinished tasks can become a concise weekly narrative, decisions list, and next-action plan.",
            nextPrompt: "Synthesize recent notes and unfinished tasks into wins, open loops, and next moves.",
          },
          {
            title: "Idea-collision studio",
            score: signals.tags.count * 2 + signals.recentNotes.count,
            why: "Combine notes from different high-signal tags to generate original writing, experiments, or project concepts.",
            nextPrompt: "Choose two unrelated tag clusters and propose five useful idea collisions grounded in actual notes.",
          },
        ]
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        return output({
          ok: true,
          data: {
            recommendations: candidates,
            evidence: signals,
            guidance:
              "Treat scores as routing hints, not quality judgments. Read the cited notes before making changes.",
          },
        });
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  server.registerTool(
    "run_obsidian_command",
    {
      title: "Run Obsidian CLI Command",
      description:
        "Run broad Obsidian CLI or plugin commands using an argument array. Permanent delete, eval, and dev controls are blocked.",
      inputSchema: z.object({
        args: z.array(z.string()).min(1).max(100),
        timeoutMs: z.number().int().min(100).max(300_000).optional(),
      }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      try {
        validateGenericArgs(input.args);
        const execute = async () => {
          const result = await runChecked(deps.executor, input.args, {
            vault: deps.defaultVault,
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          });
          return {
            data: {
              stdout: parseJsonOrText(result.stdout),
              stderr: result.stderr || null,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              args: sanitizeForAudit(result.args),
            },
            results: [result],
          };
        };
        if (!isMutation(input.args)) {
          const { data } = await execute();
          return output({ ok: true, data });
        }
        const envelope = await auditMutation({
          tool: "run_obsidian_command",
          input,
          deps,
          action: execute,
        });
        return output(envelope);
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  return server;
}
