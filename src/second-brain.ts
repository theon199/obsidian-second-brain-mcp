import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  LIFE_TODOS_PATH,
  PARA_CATEGORY_TO_ROOT,
  PARA_ROOTS,
  filterLinesUnderRoot,
  type ParaCategory,
} from "./para.js";
import { nonEmptyLines, parseJsonOrText } from "./parse.js";
import { runChecked } from "./runner.js";
import type { ServerDependencies } from "./types.js";

function sampleLines(text: string, max = 50): { count: number; sample: string[]; truncated: boolean } {
  const lines = nonEmptyLines(text);
  return { count: lines.length, sample: lines.slice(0, max), truncated: lines.length > max };
}

async function listRootFiles(
  deps: ServerDependencies,
  root: string,
  sampleLimit: number,
): Promise<{ count: number; sample: string[]; truncated: boolean }> {
  try {
    const result = await runChecked(deps.executor, ["files", `path=${root}`], {
      vault: deps.defaultVault,
    });
    return sampleLines(result.stdout, sampleLimit);
  } catch {
    const result = await runChecked(deps.executor, ["files"], { vault: deps.defaultVault });
    const filtered = filterLinesUnderRoot(nonEmptyLines(result.stdout), root as (typeof PARA_ROOTS)[number]);
    return {
      count: filtered.length,
      sample: filtered.slice(0, sampleLimit),
      truncated: filtered.length > sampleLimit,
    };
  }
}

export async function collectParaOverview(
  deps: ServerDependencies,
  sampleLimit = 30,
  category?: ParaCategory | "all",
): Promise<Record<string, unknown>> {
  const roots =
    !category || category === "all"
      ? [...PARA_ROOTS]
      : [PARA_CATEGORY_TO_ROOT[category]];
  const entries: Record<string, unknown> = {};
  for (const root of roots) {
    entries[root] = await listRootFiles(deps, root, sampleLimit);
  }
  return { roots, entries, lifeTodosPath: LIFE_TODOS_PATH };
}

export function registerSecondBrainSurface(server: McpServer, deps: ServerDependencies): void {
  server.registerResource(
    "para-overview",
    "obsidian-sb://para/overview",
    {
      title: "PARA Overview",
      description: "Folder counts and sample paths under Inbox, Projects, Areas, Resources, and Archives.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await collectParaOverview(deps, 40);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "inbox",
    "obsidian-sb://inbox",
    {
      title: "Inbox Notes",
      description: "Files currently under Inbox/.",
      mimeType: "application/json",
    },
    async (uri) => {
      const inbox = await listRootFiles(deps, "Inbox", 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ root: "Inbox", ...inbox }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "life-todos",
    "obsidian-sb://life/todos",
    {
      title: "Life Todos",
      description: "Contents of Life/Todos.md when present.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        const result = await runChecked(deps.executor, ["read", `path=${LIFE_TODOS_PATH}`], {
          vault: deps.defaultVault,
        });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: result.stdout || `# Life Todos\n\n(empty)\n`,
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: `# Life Todos\n\n\`${LIFE_TODOS_PATH}\` is missing. Call \`ensure_para\` to create it.\n`,
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "templates",
    "obsidian-sb://templates",
    {
      title: "Obsidian Templates",
      description: "Templates available in the vault via the Obsidian CLI.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await runChecked(deps.executor, ["templates"], { vault: deps.defaultVault });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { templates: parseJsonOrText(result.stdout) ?? sampleLines(result.stdout, 100) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "para_inbox_triage",
    {
      title: "PARA Inbox Triage",
      description: "Review Inbox notes and file each into the right PARA destination.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Triage my Obsidian Inbox using PARA.",
              "1. Call `list_para` with category `inbox` (or read resource `obsidian-sb://inbox`).",
              "2. For each Inbox note, `read_note` and propose Projects / Areas / Resources / Archives / keep-in-Inbox.",
              "3. After I confirm (or if autonomous writes are allowed), use `file_note` with the right category and name.",
              "4. Summarize what moved and what stayed.",
              "Do not invent vault paths outside PARA roots. Prefer typed tools over `run_obsidian_command`.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "weekly_life_review",
    {
      title: "Weekly Life Review",
      description: "Synthesize Areas, life todos, and open tasks into a daily-note review.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run a weekly life review against my vault.",
              "1. `list_para` for Areas (and skim Projects).",
              "2. `manage_tasks` with scope `life` and filter `todo`, then scope `all` or daily if useful.",
              "3. Read `obsidian-sb://life/todos` or `Life/Todos.md`.",
              "4. Draft wins, open loops, decisions, and next actions.",
              "5. Append the review to today's daily note via `daily_note` action `append`.",
              "Keep recommendations grounded in actual notes and tasks you read.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "capture_life_todo",
    {
      title: "Capture Life Todo",
      description: "Turn a free-text request into a life todo on Life/Todos.md.",
      argsSchema: z.object({
        text: z.string().min(1).describe("The todo or life action to capture"),
      }),
    },
    async ({ text }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Capture this as a life todo: ${text}`,
              "1. Prefer `manage_tasks` with action `add`, scope `life`, and a clear checkbox title.",
              "2. If `Life/Todos.md` is missing, call `ensure_para` first.",
              "3. Confirm the resulting task list with `manage_tasks` action `list` and scope `life`.",
              "Do not file this into Projects unless I explicitly ask.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "project_status",
    {
      title: "Project Status",
      description: "Inspect a named project folder, open tasks, and suggest next actions.",
      argsSchema: z.object({
        project: z.string().min(1).describe("Project folder name under Projects/"),
      }),
    },
    async ({ project }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Give me status for project "${project}".`,
              `1. Search or list under Projects/${project} (use \`list_para\` category \`project\` and/or \`search_notes\` with folder \`Projects\`).`,
              "2. Read the key notes; list incomplete tasks with `manage_tasks` (path scoped to the project folder when possible).",
              "3. Summarize progress, blockers, and the best next actions.",
              "4. Optionally append next actions to the daily note or `Life/Todos.md` only if I ask.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
