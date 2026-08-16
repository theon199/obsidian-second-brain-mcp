import { createHash } from "node:crypto";

const READ_ONLY_COMMANDS = new Set([
  "help",
  "version",
  "vault",
  "vaults",
  "files",
  "folder",
  "folders",
  "file",
  "read",
  "backlinks",
  "links",
  "unresolved",
  "orphans",
  "deadends",
  "outline",
  "plugins",
  "plugins:enabled",
  "plugin",
  "aliases",
  "properties",
  "property:read",
  "tags",
  "tag",
  "tasks",
  "templates",
  "template:read",
  "themes",
  "theme",
  "snippets",
  "snippets:enabled",
  "bookmarks",
  "commands",
  "hotkeys",
  "hotkey",
  "history",
  "history:list",
  "history:read",
  "diff",
  "search",
  "search:context",
  "daily:path",
  "daily:read",
  "random:read",
  "wordcount",
  "workspaces",
  "workspace",
  "tabs",
  "recents",
  "sync:status",
  "sync:history",
  "sync:read",
  "sync:deleted",
  "publish:site",
  "publish:list",
  "publish:status",
  "bases",
  "base:views",
  "base:query",
]);

export function commandName(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith("vault=")) ?? "";
}

export function validateGenericArgs(args: readonly string[]): void {
  if (args.length === 0) throw new Error("At least one Obsidian CLI argument is required.");
  if (args.some((arg) => arg.includes("\0"))) throw new Error("NUL bytes are not allowed.");
  if (args.some((arg) => arg.startsWith("vault="))) {
    throw new Error("Per-command vault overrides are blocked; use the server's configured vault.");
  }
  const command = commandName(args).toLowerCase();
  if (!command) throw new Error("An Obsidian CLI command is required.");
  if (command === "eval") throw new Error("The generic tool blocks arbitrary JavaScript eval.");
  if (command.startsWith("dev:" ) || command === "devtools") {
    throw new Error("The generic tool blocks raw developer-control commands.");
  }
  if (command === "delete" && args.some((arg) => arg.toLowerCase() === "permanent")) {
    throw new Error("Permanent deletion is blocked. Obsidian trash must be used.");
  }
  for (const arg of args) {
    const match = /^(?:path|file|name|to)=(.*)$/.exec(arg);
    if (match?.[1] && !isVaultRelativePath(match[1])) {
      throw new Error("Obsidian paths must remain relative to the configured vault.");
    }
  }
}

export function isVaultRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === "..");
}

export function isMutation(args: readonly string[]): boolean {
  return !READ_ONLY_COMMANDS.has(commandName(args).toLowerCase());
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactString(value: string, key = ""): unknown {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("content") || lowerKey.includes("body") || lowerKey.includes("text")) {
    return { redacted: true, length: value.length, sha256: digest(value) };
  }
  if (value.startsWith("content=")) {
    const content = value.slice("content=".length);
    return `content=<redacted length=${content.length} sha256=${digest(content)}>`;
  }
  return value;
}

export function sanitizeForAudit(value: unknown, key = ""): unknown {
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitizeForAudit(child, childKey)]),
    );
  }
  return value;
}

export function inferTargets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const keys = ["path", "file", "name", "target", "destination", "to", "ref"];
  const direct = keys.flatMap((key) => (typeof record[key] === "string" ? [record[key]] : []));
  const commandTargets = Array.isArray(record.args)
    ? record.args.flatMap((arg) => {
        if (typeof arg !== "string") return [];
        const match = /^(?:path|file|name|to|ref)=(.+)$/.exec(arg);
        return match?.[1] ? [match[1]] : [];
      })
    : [];
  return [...new Set([...direct, ...commandTargets])];
}
