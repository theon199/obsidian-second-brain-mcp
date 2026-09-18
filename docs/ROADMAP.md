# Roadmap

## Shipped in 1.1 (this release)

- PARA folder conventions (`Inbox`, `Projects`, `Areas`, `Resources`, `Archives`, `Life/Todos.md`)
- Typed tools: `ensure_para`, `list_para`, `capture`, `file_note`
- Extended `manage_tasks` (`add`, `scope`, `folder`)
- MCP prompts for inbox triage, weekly life review, life-todo capture, project status
- MCP resources for PARA overview, Inbox, life todos, templates
- PARA-aware `suggest_use_cases` scoring
- Docs: [PARA.md](PARA.md), [PROMPTS.md](PROMPTS.md)

## Later (explicit non-goals for 1.1)

| Idea | Why deferred |
| --- | --- |
| Embeddings / semantic search | Stays CLI-thin; host LLM + native search for now |
| Server-side mega-workflows (`inbox_triage` as one tool) | Orchestration belongs in prompts + host |
| Multi-vault runtime switching | One vault ID per process today |
| Undo / restore from audit | Audit is forensic (hashes only), not a snapshot store |
| Batch multi-note typed ops | Client can loop typed tools |
| Non-macOS vault auto-detect | Obsidian registry path is macOS-centric |

## Candidate follow-ups

- Tag rename/add typed helpers if Obsidian CLI gains clearer mutation commands
- Stronger project dashboards via Bases / Dataview only through `run_obsidian_command` allowlist
- Cursor / Claude Desktop installer profiles alongside Codex and Antigravity
