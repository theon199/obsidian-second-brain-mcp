import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  LIFE_TODOS_PATH,
  PARA_ROOTS,
  assertSafeVaultPath,
  buildParaDestination,
  ensureMdExtension,
  inboxCapturePath,
  paraPropertyDefaults,
  seedNotes,
  slugify,
  type ParaCategory,
} from "./para.js";
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
import { collectParaOverview, registerSecondBrainSurface } from "./second-brain.js";
import type {
  AuditEntry,
  CommandResult,
  ObsidianExecutor,
  ServerDependencies,
  ToolEnvelope,
} from "./types.js";

export type { ServerDependencies } from "./types.js";

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
    { name: "local-obsidian", version: "1.1.0" },
    {
      instructions:
        "Use this server as a PARA second brain over the user's local Obsidian vault. Prefer capture → read/review → file_note → manage_tasks for life and project work. Call ensure_para once if Inbox/Projects/Areas/Resources/Archives or Life/Todos.md are missing. Search before assuming a note exists; use read_note with links/backlinks before proposing connections. Prefer typed tools for normal work. Deletes always go to trash. run_obsidian_command blocks permanent deletion, eval, and dev controls. For coaching, use MCP prompts (para_inbox_triage, weekly_life_review, capture_life_todo, project_status) or suggest_use_cases grounded in vault evidence. Changes are autonomous and audited without copying note content into logs.",
    },
  );

  registerSecondBrainSurface(server, deps);

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

  const paraCategorySchema = z.enum(["inbox", "project", "area", "resource", "archive"]);

  async function noteExists(path: string): Promise<boolean> {
    const result = await deps.executor.run(["file", `path=${path}`], { vault: deps.defaultVault });
    return result.exitCode === 0;
  }

  server.registerTool(
    "ensure_para",
    {
      title: "Ensure PARA Structure",
      description:
        "Idempotently create Inbox, Projects, Areas, Resources, Archives seed notes and Life/Todos.md if missing.",
      inputSchema: z.object({}),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const envelope = await auditMutation({
          tool: "ensure_para",
          input,
          deps,
          action: async () => {
            const created: string[] = [];
            const existing: string[] = [];
            const results: CommandResult[] = [];
            for (const seed of seedNotes()) {
              if (await noteExists(seed.path)) {
                existing.push(seed.path);
                continue;
              }
              results.push(
                await runChecked(
                  deps.executor,
                  ["create", `path=${seed.path}`, `content=${seed.content}`],
                  { vault: deps.defaultVault },
                ),
              );
              created.push(seed.path);
            }
            return {
              data: {
                created,
                existing,
                roots: [...PARA_ROOTS],
                lifeTodosPath: LIFE_TODOS_PATH,
              },
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

  server.registerTool(
    "list_para",
    {
      title: "List PARA Structure",
      description: "List notes under one or all PARA roots with counts and path samples.",
      inputSchema: z.object({
        category: z.enum(["all", "inbox", "project", "area", "resource", "archive"]).default("all"),
        sampleLimit: z.number().int().min(1).max(200).default(40),
      }),
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ category, sampleLimit }) => {
      try {
        const data = await collectParaOverview(
          deps,
          sampleLimit,
          category === "all" ? "all" : (category as ParaCategory),
        );
        return output({ ok: true, data });
      } catch (error) {
        return errorOutput(error);
      }
    },
  );

  const captureSchema = z
    .object({
      title: z.string().min(1).describe("Title used for the Inbox note name when path is omitted"),
      content: z.string().optional(),
      path: vaultPathSchema.optional().describe("Optional override path (defaults under Inbox/)"),
      asTask: z.boolean().default(false).describe("When true, body starts with an incomplete checkbox task"),
      properties: z.record(z.string(), propertyValue).default({}),
      append: z.boolean().default(false).describe("Append to an existing note at path instead of creating"),
    })
    .refine((value) => !(value.append && !value.path), {
      message: "append requires an explicit path.",
    });

  server.registerTool(
    "capture",
    {
      title: "Capture to Inbox",
      description:
        "Create or append a capture note (default Inbox/), optionally as a checkbox task, with optional properties.",
      inputSchema: captureSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      const path = input.path ? ensureMdExtension(input.path) : inboxCapturePath(input.title);
      assertSafeVaultPath(path);
      const target: Target = { path };
      const bodyCore = input.content?.trim() ? input.content : input.title;
      const body = input.asTask
        ? `- [ ] ${bodyCore.replace(/^\s*-\s*\[[ xX]\]\s*/, "")}\n`
        : `${bodyCore}\n`;
      const properties = {
        ...paraPropertyDefaults("inbox"),
        ...input.properties,
      };
      try {
        const envelope = await auditMutation({
          tool: "capture",
          input,
          deps,
          afterTarget: target,
          ...(input.append ? { beforeTarget: target } : {}),
          action: async () => {
            const results: CommandResult[] = [];
            if (input.append) {
              results.push(
                await runChecked(deps.executor, ["append", `path=${path}`, `content=${body}`], {
                  vault: deps.defaultVault,
                }),
              );
            } else {
              const content = `# ${input.title}\n\n${body}`;
              results.push(
                await runChecked(
                  deps.executor,
                  ["create", `path=${path}`, `content=${content}`],
                  { vault: deps.defaultVault },
                ),
              );
            }
            results.push(...(await setProperties(deps.executor, target, properties, deps.defaultVault)));
            return {
              data: { path, title: input.title, asTask: input.asTask, appended: input.append },
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

  const fileNoteSchema = targetSchema.and(
    z.object({
      category: paraCategorySchema,
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Project/area/resource/archive bucket name; required for project and area"),
      setProperties: z.boolean().default(true),
    }),
  );

  server.registerTool(
    "file_note",
    {
      title: "File Note into PARA",
      description:
        "Move a note into Inbox, Projects/{name}, Areas/{name}, Resources, or Archives using PARA conventions.",
      inputSchema: fileNoteSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => {
      const beforeTarget: Target = input.path ? { path: input.path } : { file: input.file! };
      try {
        let sourcePath = input.path;
        if (!sourcePath) {
          const info = await runChecked(deps.executor, ["file", ...targetArgs(beforeTarget)], {
            vault: deps.defaultVault,
          });
          const parsed = parseJsonOrText(info.stdout);
          if (parsed && typeof parsed === "object" && "path" in parsed && typeof parsed.path === "string") {
            sourcePath = parsed.path;
          } else {
            const lines = nonEmptyLines(info.stdout);
            sourcePath = lines[0] ?? input.file!;
          }
        }
        const destination = buildParaDestination({
          category: input.category,
          name: input.name,
          sourcePath,
        });
        const afterTarget: Target = { path: destination };
        const envelope = await auditMutation({
          tool: "file_note",
          input,
          deps,
          beforeTarget,
          afterTarget,
          action: async () => {
            const results: CommandResult[] = [
              await runChecked(
                deps.executor,
                ["move", ...targetArgs(beforeTarget), `to=${destination}`],
                { vault: deps.defaultVault },
              ),
            ];
            if (input.setProperties) {
              results.push(
                ...(await setProperties(
                  deps.executor,
                  afterTarget,
                  paraPropertyDefaults(input.category, input.name),
                  deps.defaultVault,
                )),
              );
            }
            return {
              data: {
                from: targetLabel(beforeTarget),
                to: destination,
                category: input.category,
                ...(input.name ? { name: slugify(input.name) } : {}),
              },
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

  const tasksSchema = z
    .object({
      action: z.enum(["list", "update", "add"]),
      path: vaultPathSchema.optional(),
      file: vaultPathSchema.optional(),
      folder: vaultPathSchema.optional().describe("Folder scope for list (maps to path= on tasks CLI)"),
      ref: z.string().min(1).optional(),
      line: z.number().int().positive().optional(),
      filter: z.enum(["todo", "done", "all"]).default("todo"),
      status: z.string().length(1).optional(),
      done: z.boolean().optional(),
      daily: z.boolean().default(false),
      scope: z
        .enum(["life", "daily", "all"])
        .default("all")
        .describe("Convenience scope: life → Life/Todos.md, daily → daily note tasks"),
      text: z.string().min(1).optional().describe("Task text when action is add"),
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
    )
    .refine((value) => value.action !== "add" || Boolean(value.text), {
      message: "Adding a task requires text.",
    });

  server.registerTool(
    "manage_tasks",
    {
      title: "Manage Tasks",
      description:
        "List, add, or update tasks. Use scope life for Life/Todos.md, daily for the daily note, or folder/path for a project.",
      inputSchema: tasksSchema,
      outputSchema: envelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const useDaily = input.daily || input.scope === "daily";
        const lifePath = input.scope === "life" ? LIFE_TODOS_PATH : undefined;
        const optionalTarget: Target | undefined = input.path
          ? { path: input.path }
          : input.file
            ? { file: input.file }
            : lifePath
              ? { path: lifePath }
              : input.folder
                ? { path: input.folder }
                : undefined;

        if (input.action === "list") {
          const args = ["tasks"];
          if (optionalTarget) args.push(...targetArgs(optionalTarget));
          if (useDaily) args.push("daily");
          if (input.status) args.push(`status=${input.status}`);
          if (input.filter !== "all") args.push(input.filter);
          args.push("verbose", "format=json");
          const result = await runChecked(deps.executor, args, { vault: deps.defaultVault });
          return output({
            ok: true,
            data: {
              scope: input.scope,
              tasks: parseJsonOrText(result.stdout),
            },
          });
        }

        if (input.action === "add") {
          const taskLine = `- [ ] ${input.text!.replace(/^\s*-\s*\[[ xX]\]\s*/, "")}\n`;
          const envelope = await auditMutation({
            tool: "manage_tasks",
            input,
            deps,
            ...(optionalTarget && !useDaily ? { beforeTarget: optionalTarget, afterTarget: optionalTarget } : {}),
            action: async () => {
              if (useDaily) {
                const result = await runChecked(
                  deps.executor,
                  ["daily:append", `content=${taskLine}`],
                  { vault: deps.defaultVault },
                );
                return {
                  data: { action: "add" as const, scope: "daily" as const, target: "daily", text: input.text },
                  results: [result],
                };
              }
              const target = optionalTarget ?? { path: LIFE_TODOS_PATH };
              if (target.path === LIFE_TODOS_PATH && !(await noteExists(LIFE_TODOS_PATH))) {
                const seed = seedNotes().find((note) => note.path === LIFE_TODOS_PATH)!;
                await runChecked(
                  deps.executor,
                  ["create", `path=${seed.path}`, `content=${seed.content}`],
                  { vault: deps.defaultVault },
                );
              }
              const result = await runChecked(
                deps.executor,
                ["append", ...targetArgs(target), `content=${taskLine}`],
                { vault: deps.defaultVault },
              );
              return {
                data: {
                  action: "add" as const,
                  scope: input.scope,
                  target: targetLabel(target),
                  text: input.text,
                },
                results: [result],
              };
            },
          });
          return output(envelope);
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
            if (useDaily) args.push("daily");
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
      description:
        "Analyze native graph, PARA, and task signals, then rank contextual second-brain workflows.",
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
        const para = await collectParaOverview(deps, sampleLimit);
        const inboxCount =
          typeof para.entries === "object" &&
          para.entries &&
          "Inbox" in (para.entries as Record<string, { count?: number }>)
            ? ((para.entries as Record<string, { count?: number }>).Inbox?.count ?? 0)
            : 0;
        const projectsCount =
          typeof para.entries === "object" &&
          para.entries &&
          "Projects" in (para.entries as Record<string, { count?: number }>)
            ? ((para.entries as Record<string, { count?: number }>).Projects?.count ?? 0)
            : 0;
        const areasCount =
          typeof para.entries === "object" &&
          para.entries &&
          "Areas" in (para.entries as Record<string, { count?: number }>)
            ? ((para.entries as Record<string, { count?: number }>).Areas?.count ?? 0)
            : 0;
        const signals = {
          orphans: sampleLines(results[0]!.stdout, sampleLimit),
          deadends: sampleLines(results[1]!.stdout, sampleLimit),
          unresolved: sampleLines(results[2]!.stdout, sampleLimit),
          tags: sampleLines(results[3]!.stdout, sampleLimit),
          incompleteTasks: sampleLines(results[4]!.stdout, sampleLimit),
          recentNotes: sampleLines(results[5]!.stdout, sampleLimit),
          inboxNotes: { count: inboxCount },
          projectNotes: { count: projectsCount },
          areaNotes: { count: areasCount },
        };
        const candidates = [
          {
            title: "PARA inbox triage",
            score: inboxCount * 5 + signals.incompleteTasks.count,
            why: `${inboxCount} Inbox items are waiting to be filed into Projects, Areas, Resources, or Archives.`,
            nextPrompt: "Use prompt para_inbox_triage and file confirmed notes with file_note.",
          },
          {
            title: "Weekly life review",
            score: areasCount * 2 + signals.incompleteTasks.count * 2 + signals.recentNotes.count,
            why: "Areas coverage plus unfinished tasks can become a weekly life narrative and next-action list.",
            nextPrompt: "Use prompt weekly_life_review and append the summary to today's daily note.",
          },
          {
            title: "Project next-actions sweep",
            score: projectsCount * 3 + signals.incompleteTasks.count,
            why: `${projectsCount} project notes with open tasks need a crisp next-action pass.`,
            nextPrompt: "Pick an active project and run prompt project_status with its folder name.",
          },
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
            para,
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
