import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { NoopAuditLogger } from "../src/audit.js";
import type { CommandResult, ObsidianExecutor } from "../src/types.js";

const commandResult = (args: readonly string[], stdout: string, exitCode = 0): CommandResult => ({
  args: [...args],
  stdout,
  stderr: "",
  exitCode,
  durationMs: 1,
});

describe("MCP contract", () => {
  const clients: Client[] = [];
  const servers: Array<{ close?: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map((server) => server.close?.() ?? Promise.resolve()));
  });

  async function connect(executor: ObsidianExecutor) {
    const server = buildServer({ executor, audit: new NoopAuditLogger(), defaultVault: "Personal" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "1.1.0" });
    clients.push(client);
    servers.push(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it("initializes, lists all typed tools, exposes annotations, and calls search through a fake executor", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) =>
        commandResult(args, JSON.stringify([{ path: "Notes/idea.md", line: 2, text: "idea" }])),
      ),
    };
    const client = await connect(executor);

    const listing = await client.listTools();
    const names = listing.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "vault_overview",
      "search_notes",
      "read_note",
      "create_note",
      "update_note",
      "organize_note",
      "daily_note",
      "ensure_para",
      "list_para",
      "capture",
      "file_note",
      "manage_tasks",
      "suggest_use_cases",
      "run_obsidian_command",
    ]);
    const searchTool = listing.tools.find((tool) => tool.name === "search_notes");
    expect(searchTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(searchTool?.inputSchema).toMatchObject({ type: "object" });

    const call = await client.callTool({
      name: "search_notes",
      arguments: { query: "idea", context: false, limit: 5 },
    });
    expect(call.isError).not.toBe(true);
    expect(call.structuredContent).toMatchObject({
      ok: true,
      data: [{ path: "Notes/idea.md", line: 2, text: "idea" }],
    });
    expect(executor.run).toHaveBeenCalledWith(
      ["search", "query=idea", "limit=5", "format=json"],
      { vault: "Personal" },
    );
  });

  it("lists PARA prompts and second-brain resources", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === "files") return commandResult(args, "Inbox/a.md\nInbox/b.md\n");
        if (args[0] === "read") return commandResult(args, "# Life Todos\n\n- [ ] pay rent\n");
        if (args[0] === "templates") return commandResult(args, "Daily\nMeeting\n");
        return commandResult(args, "");
      }),
    };
    const client = await connect(executor);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      "capture_life_todo",
      "para_inbox_triage",
      "project_status",
      "weekly_life_review",
    ]);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
      "obsidian-sb://inbox",
      "obsidian-sb://life/todos",
      "obsidian-sb://para/overview",
      "obsidian-sb://templates",
    ]);

    const inbox = await client.readResource({ uri: "obsidian-sb://inbox" });
    expect(inbox.contents[0]).toMatchObject({ mimeType: "application/json" });
    expect(String((inbox.contents[0] as { text?: string }).text)).toContain("Inbox/a.md");

    const got = await client.getPrompt({
      name: "capture_life_todo",
      arguments: { text: "Schedule dentist" },
    });
    expect(got.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Schedule dentist"),
    });
  });

  it("captures to Inbox, files into a project, and adds a life todo", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === "file") {
          if (args.includes("path=Life/Todos.md")) return commandResult(args, "", 1);
          return commandResult(args, JSON.stringify({ path: "Inbox/Ship-docs.md" }));
        }
        return commandResult(args, "ok");
      }),
    };
    const client = await connect(executor);

    const capture = await client.callTool({
      name: "capture",
      arguments: { title: "Ship docs", content: "Write release notes", asTask: true },
    });
    expect(capture.isError).not.toBe(true);
    expect(capture.structuredContent).toMatchObject({
      ok: true,
      data: { path: "Inbox/Ship-docs.md", asTask: true },
    });
    expect(executor.run).toHaveBeenCalledWith(
      expect.arrayContaining(["create", "path=Inbox/Ship-docs.md"]),
      { vault: "Personal" },
    );

    const filed = await client.callTool({
      name: "file_note",
      arguments: { path: "Inbox/Ship-docs.md", category: "project", name: "Launch" },
    });
    expect(filed.isError).not.toBe(true);
    expect(filed.structuredContent).toMatchObject({
      ok: true,
      data: { to: "Projects/Launch/Ship-docs.md", category: "project" },
    });
    expect(executor.run).toHaveBeenCalledWith(
      ["move", "path=Inbox/Ship-docs.md", "to=Projects/Launch/Ship-docs.md"],
      { vault: "Personal" },
    );

    const added = await client.callTool({
      name: "manage_tasks",
      arguments: { action: "add", scope: "life", text: "Call dentist" },
    });
    expect(added.isError).not.toBe(true);
    expect(executor.run).toHaveBeenCalledWith(
      expect.arrayContaining(["append", "path=Life/Todos.md"]),
      { vault: "Personal" },
    );
  });

  it("returns an MCP error for blocked generic commands without invoking the executor", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) => commandResult(args, "unexpected")),
    };
    const client = await connect(executor);

    const call = await client.callTool({
      name: "run_obsidian_command",
      arguments: { args: ["eval", "code=alert(1)"] },
    });
    expect(call.isError).toBe(true);
    expect(call.content).toEqual([
      { type: "text", text: "The generic tool blocks arbitrary JavaScript eval." },
    ]);
    expect(executor.run).not.toHaveBeenCalled();
  });
});
