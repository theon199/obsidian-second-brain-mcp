# MCP prompts

Prompts teach the **host LLM** which typed tools to call. They do not run multi-step workflows inside the server.

## `para_inbox_triage`

**Goal:** Review Inbox and file notes into PARA.

**Typical tool sequence:**

1. `list_para` (`category: "inbox"`) or read `obsidian-sb://inbox`
2. `read_note` per candidate
3. `file_note` with `category` + `name`
4. Summarize moves

**Sample utterance:** “Triage my Inbox.”

## `weekly_life_review`

**Goal:** Synthesize Areas, life todos, and open tasks into a daily-note review.

**Typical tool sequence:**

1. `list_para` for Areas (and skim Projects)
2. `manage_tasks` with `scope: "life"` then broader todo list
3. Read `obsidian-sb://life/todos`
4. `daily_note` `append` with the written review

**Sample utterance:** “Run my weekly life review.”

## `capture_life_todo`

**Args:** `text` — the todo to capture.

**Typical tool sequence:**

1. `ensure_para` if `Life/Todos.md` may be missing
2. `manage_tasks` `action: "add"`, `scope: "life"`, `text`
3. `manage_tasks` `action: "list"`, `scope: "life"` to confirm

**Sample utterance:** “Remind me to schedule a dentist appointment.”

## `project_status`

**Args:** `project` — folder name under `Projects/`.

**Typical tool sequence:**

1. `list_para` / `search_notes` with folder under `Projects`
2. `read_note` on key notes
3. `manage_tasks` scoped to the project path
4. Summarize progress, blockers, next actions

**Sample utterance:** “Status on project Launch.”

## Resources (read-only)

| URI | Contents |
| --- | --- |
| `obsidian-sb://para/overview` | Counts/samples under all PARA roots |
| `obsidian-sb://inbox` | Inbox file list |
| `obsidian-sb://life/todos` | Markdown body of `Life/Todos.md` |
| `obsidian-sb://templates` | Vault templates from the Obsidian CLI |
