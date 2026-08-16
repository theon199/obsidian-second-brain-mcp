# Obsidian Second Brain MCP

Local MCP server for Codex and Antigravity that automates an open Obsidian
vault through Obsidian's official command-line interface. It uses MCP over
STDIO, so no HTTP listener, API key, embeddings index, or cloud service is
required. Obsidian remains the system of record; the server does not edit an
iCloud vault directly.

## Requirements

- macOS with Obsidian 1.12.7 or newer.
- Node.js 20 or newer (the installer uses the Node executable that launched it).
- A built checkout of this project (`npm install` then `npm run build`).
- An open Obsidian vault.

Enable Obsidian's CLI before installing the MCP server:

1. Open Obsidian and choose Settings → General → Command line interface.
2. Enable the CLI and accept the macOS registration prompt.
3. Confirm that `command -v obsidian` prints a path (usually
   `/usr/local/bin/obsidian`). If it is elsewhere, set `OBSIDIAN_BIN` when
   starting the MCP server or before running the installer.

The server selects the most recently opened vault ID from
`~/Library/Application Support/obsidian/obsidian.json`. This means the vault
can stay in iCloud while commands still go through Obsidian. Set
`OBSIDIAN_VAULT_ID` to target a different registered vault.

## Install and configure

From the project directory:

```sh
npm install
npm run build
node scripts/install.mjs --dry-run
node scripts/install.mjs
```

The installer verifies Node, `dist/index.js`, and the Obsidian CLI; discovers
the open vault ID; and merges an `obsidian` STDIO server into both client
configurations:

- Codex: `~/.codex/config.toml`
- Antigravity: `~/.gemini/config/mcp_config.json`

Existing files are backed up with a timestamped `.bak.*` suffix before a real
update. Existing settings and custom fields in the `obsidian` server entry are
preserved; the command, entrypoint arguments, detected vault/CLI environment,
and approval setting are refreshed. Codex receives
`default_tools_approval_mode = "auto"` inside the
`[mcp_servers.obsidian]` table so normal calls to this server do not require a
confirmation for every operation.

Use one of these flags when only one client should be changed:

```sh
node scripts/install.mjs --codex-only
node scripts/install.mjs --antigravity-only
```

`--dry-run` performs prerequisite checks and prints the planned paths and
backups without creating directories, backups, or configuration files. A
missing Obsidian CLI is reported as a warning in dry-run mode, but blocks a
real install. The installer never reads or prints note contents.

After installation, restart Codex and Antigravity, or use each client's MCP
refresh/reload action. A running client does not automatically reload a changed
MCP configuration; `/mcp` can show the current session's server state, but a
full client restart may still be needed after the first install.

## Tools

The server exposes ten tools. Read-only tools return structured data and do not
write the audit log; mutations return concise before/after evidence and append
one JSONL audit record.

| Tool | Purpose |
| --- | --- |
| `vault_overview` | Counts and samples files, folders, tags, properties, orphans, dead ends, unresolved links, and incomplete tasks. |
| `search_notes` | Native Obsidian search with query, folder, case-sensitive, context, and result-limit controls. |
| `read_note` | Reads content plus file metadata, outline, properties, outgoing links, and backlinks. Identify a note by `path` or `file`. |
| `create_note` | Creates by path/name, content or template, optional properties, open, and overwrite controls. |
| `update_note` | Appends or prepends content, sets/removes properties, and changes a task's status. |
| `organize_note` | Moves, renames, or sends a note to Obsidian trash. It never permanently deletes. |
| `daily_note` | Reads, opens, appends to, or prepends to the active daily note. |
| `manage_tasks` | Lists tasks or completes/reopens/assigns a custom one-character task status. |
| `suggest_use_cases` | Uses native graph and organization signals to rank three contextual second-brain workflows. |
| `run_obsidian_command` | Runs an argument array for other Obsidian/plugin commands after safety checks. |

The server instructions encourage an MCP client to search before assuming a
note exists, inspect links/backlinks before proposing connections, use typed
tools for ordinary work, and call `suggest_use_cases` when the user wants
creative ideas grounded in their actual vault.

## Creative workflows

The recommendation tool can surface workflows such as:

- **Forgotten-note resurfacing:** rotate orphan notes into a daily review and
  connect the useful ones to active projects.
- **Bridge-note generator:** find disconnected tag/link clusters and outline a
  synthesis note that gives them a shared concept.
- **Knowledge-gap radar:** turn unresolved links and dead ends into a ranked
  research queue.
- **Weekly synthesis cockpit:** combine recent notes and unfinished tasks into
  wins, open loops, decisions, and next actions.
- **Idea-collision studio:** combine unrelated tag clusters into writing,
  experiment, or project concepts grounded in real notes.

Example prompts:

```text
Find three overlooked connections in my vault and explain why they matter.
Turn today's loose notes into a connected synthesis note.
Show unfinished tasks and append the best next actions to today's daily note.
Suggest three creative second-brain workflows based on how my vault is structured.
```

For changes that affect several notes, ask the client to search/read first,
show the proposed targets, and then perform the writes. The server permits
autonomous writes by design, so client-level approval settings remain an
important user choice.

## Configuration

The MCP process reads these environment variables at startup:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OBSIDIAN_BIN` | `obsidian` | Absolute path or executable name for the Obsidian CLI. |
| `OBSIDIAN_VAULT_ID` | Detected open vault ID | Registered Obsidian vault ID to pass on every command. |
| `OBSIDIAN_MCP_AUDIT_LOG` | `~/Library/Application Support/obsidian-mcp/audit.jsonl` | JSONL mutation audit path. |
| `OBSIDIAN_MCP_TIMEOUT_MS` | `30000` | Per-command timeout; invalid/non-positive values use 30 seconds. |

The generated client entry uses the absolute Node executable, `dist/index.js`,
the resolved Obsidian CLI path, and the detected vault ID, so it is independent
of the shell's PATH. If the project moves or the default vault changes, rerun
the installer to refresh those absolute values.

## Safety and audit behavior

- All Obsidian arguments are passed as an array to `execFile`; there is no shell
  interpolation.
- Permanent deletion, arbitrary `eval`, and raw `dev:*`/developer-control
  commands are blocked, including through `run_obsidian_command`.
- `organize_note` uses Obsidian's delete/trash command only.
- Every mutation records timestamp, tool, vault, affected targets, sanitized
  arguments, status, duration, and before/after metadata or content hashes.
- Content/body/text arguments are represented only by length and SHA-256 in the
  audit log. Note contents are not copied to logs or printed by the installer.
- The audit directory is created with mode 0700 and the JSONL file with mode
  0600.

## Development and tests

```sh
npm run check       # TypeScript type-check without emitting
npm run build       # Compile to dist/index.js
npm test            # Unit and MCP contract tests
npm run test:smoke  # Optional real-vault smoke test
node --check scripts/install.mjs
node scripts/install.mjs --dry-run
```

The real-vault smoke test is opt-in because it creates, updates, and trashes
fixture notes. It should only be run with Obsidian open on the intended test
vault. It exercises linked notes, search/read, properties, backlinks, tasks,
trash, and audit entries, and must leave no fixture behind.

## Troubleshooting

**`Obsidian CLI was not found`** — enable the CLI under Obsidian Settings →
General, accept the registration prompt, and verify `command -v obsidian`. Set
`OBSIDIAN_BIN=/absolute/path/to/obsidian` if registration used a non-standard
path.

**`Compiled entrypoint not found`** — run `npm install` and `npm run build` from
the project directory, then rerun the installer. The configured entrypoint is
the absolute `dist/index.js` path.

**No vault is detected** — open the desired vault in Obsidian, or set
`OBSIDIAN_VAULT_ID` to a vault ID from the `vaults` object in Obsidian's
`obsidian.json` registry.

**Tools do not appear** — restart the client after installation and inspect its
MCP page (`/mcp` in Codex). Check that the configured command and `dist/index.js`
still exist and that Node is version 20 or newer.

**A command fails** — run the same read-only command in a terminal (for
example, `obsidian vault`) and inspect the returned error. The server applies a
vault ID to every command; a stale ID can be corrected with
`OBSIDIAN_VAULT_ID` or by rerunning the installer after opening the desired
vault.
