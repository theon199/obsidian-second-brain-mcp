# PARA conventions

This MCP treats the vault as a **PARA second brain**: Projects, Areas, Resources, Archives, plus an Inbox and a standing life-todo note. The server stays CLI-thin — it creates paths and moves notes; the host LLM decides *where* things belong from natural language.

## Folder map

| Path | Role |
| --- | --- |
| `Inbox/` | Unsorted captures. Default landing zone for `capture`. |
| `Projects/` | Outcome-bound work with a finish line. One subfolder per project. |
| `Areas/` | Ongoing life domains (health, finances, home, career). No end date. |
| `Resources/` | Reference and evergreen material. |
| `Archives/` | Inactive projects, areas, and resources. |
| `Life/Todos.md` | Default scratchpad for standing life todos. |

Call `ensure_para` once to seed README notes under each PARA root and create `Life/Todos.md` if they are missing. Existing trees are never renamed.

## Frontmatter (optional)

New captures and filed notes may receive:

| Property | Values | Meaning |
| --- | --- | --- |
| `para` | `inbox` \| `project` \| `area` \| `resource` \| `archive` | PARA bucket |
| `status` | `active` \| `someday` \| `done` | Lifecycle hint |
| `project` / `area` | string | Bucket name when category is project or area |

Legacy notes without these properties still work; tools do not require them.

## Capture → file workflow

1. **Capture** — `capture` with a title (and optional body / `asTask`) writes under `Inbox/`.
2. **Review** — `read_note` or resource `obsidian-sb://inbox`; use prompt `para_inbox_triage` for coaching.
3. **File** — `file_note` with `category` + `name` (required for project/area) moves the note, e.g. `Projects/Launch/idea.md`.
4. **Act** — `manage_tasks` lists or updates checkboxes; `scope: "life"` targets `Life/Todos.md`.

## Life todos

- **Add:** `manage_tasks` `{ "action": "add", "scope": "life", "text": "Call dentist" }`
- **List:** `manage_tasks` `{ "action": "list", "scope": "life", "filter": "todo" }`
- **Daily:** `scope: "daily"` or `daily: true` uses the active daily note instead.

Prefer life scope for standing personal tasks; put outcome-bound work under `Projects/{name}/` and file notes with `file_note`.

## Natural-language examples

```text
Capture "renew passport" as a life todo.
Put today's meeting notes into project Website Redesign.
Triage my Inbox with PARA.
What's open in Areas and Life/Todos for a weekly review?
```
