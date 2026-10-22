---
name: obsidian-tasks
description: Search, list, add, complete, reopen, and reschedule the user's Obsidian tasks (Tasks-plugin format) in their Daily Notes, synced with their Obsidian vault via the `tasks` CLI. Use when the user asks what is on their plate, what is due or overdue, or wants a task created, finished, reopened, or moved.
---

# Obsidian daily tasks

The `tasks` CLI reads and edits task lines in the user's **daily notes** (`YYYY-MM-DD.md`) in their Obsidian vault. Every command syncs with Obsidian Sync first and (for edits) again afterwards, so results are current and edits show up on the user's other devices. It can only see daily notes, so don't try to reach other notes through it.

**Always pass `--json`** and read the `ok` field. Never edit vault files directly; only use this CLI.

## Reading tasks

```bash
tasks list --json                                  # open tasks (todo + in progress), sorted by due date
tasks list --overdue --json                        # open and due before today
tasks list --happens-on-or-before today --json     # open with a due/scheduled/start date today or earlier ("on my plate today")
tasks list --due-before +7d --status open --json   # due within the next week
tasks list --priority ">=high" --json
tasks list --tag work --json
tasks list --note today --json                     # tasks written in today's daily note
tasks list --status done --from=-7d --json         # completed tasks from notes in the last week (use = for values starting with "-")
tasks search "accounting invoice" --json           # all words must match; searches every status unless --status is given
tasks get --id <id> --json                         # one task with its parent and children
```

Statuses: `open` (default for list), `todo`, `in_progress`, `done`, `cancelled`, `closed`, `all`.
Sort with `--sort due|priority|scheduled|file|note`. Results are capped at 100 (`--limit N`); check `truncated`.

Each task has `id`, `rev`, `status`, `description`, `tags`, `priority`, and optional `due`, `scheduled`, `start`, `done`, `cancelled`, `recurrence`, `inlineFields` (e.g. `{"cost":"2"}`), plus `file`, `line`, `noteDate`, `section` (heading it sits under), `parentId`, and `link` (an Obsidian wikilink to the note). Use `file`/`noteDate`/`section` to tell the user where a task lives.

## Dates

- 📅 **due**: deadline. ⏳ **scheduled**: the day the user plans to work on it. 🛫 **start**: not actionable before this date.
- "Overdue" means open and `due` < today. "Today's work" usually means open tasks with any of due, scheduled or start ≤ today.
- Date arguments accept `YYYY-MM-DD`, `today`, `tomorrow`, `yesterday`, `+3d`, `-1w`, `+1m`, `friday` (next Friday, or today if it is Friday), `next friday`. Relative dates use the user's configured timezone; every response includes `today`.
- Priorities, highest to lowest: `highest` 🔺, `high` ⏫, `medium` 🔼, `none`, `low` 🔽, `lowest` ⏬.

## Changing tasks

Always get the `id` and `rev` from a fresh `list`/`search`/`get`, and pass both:

```bash
tasks complete --id <id> --rev <rev> --json
tasks reopen   --id <id> --rev <rev> --json
tasks update   --id <id> --rev <rev> --due 2026-11-03 --json        # reschedule; use "none" to clear
tasks update   --id <id> --rev <rev> --scheduled tomorrow --priority high --json
tasks update   --id <id> --rev <rev> --text "New wording" --json    # tags and metadata are kept
tasks update   --id <id> --rev <rev> --add-tag waiting --remove-tag work --json
tasks update   --id <id> --rev <rev> --status in_progress --json    # todo | in_progress | cancelled
```

Adding tasks goes to **today's** daily note by default:

```bash
tasks add --text "Review proposal" --json
tasks add --text "Send Q3 numbers to Dana" --due friday --priority high --tag work --json
tasks add --text "Draft outline" --parent <id> --json               # sub-task under an existing task
tasks add --text "Book flights" --field cost=1 --field value=200 --json   # Dataview inline fields
```

- Write the task text the way the user would; put dates, priority and tags in flags, never as emoji in `--text`.
- Only set dates and priorities the user actually stated or clearly implied. Don't invent them.
- A response with `alreadyExisted: true` means an identical open task is already in that note, so nothing was added. Retrying `add` is safe.
- After any change, report the returned `task` (with its new `id`/`rev`). Updating the text changes the id.

## When to ask the user first

- Several tasks match the user's description: list the candidates and ask which one.
- The request would cancel or delete something, or change many tasks at once: confirm first.
- `NOTE_NOT_FOUND`: the target daily note doesn't exist yet. Ask before re-running with `--create-note`. Prefer adding to today's note with a `--due` date over creating notes for future days.
- A due date or priority is unclear ("soon", "important"). Ask, or leave it unset.

## Errors (`ok: false`, see `error.code`)

| code | what to do |
|---|---|
| `SYNC_FAILED` | Nothing is confirmed. If `details.localChangeApplied` is true, the edit is saved locally but **not** synced yet: tell the user it is pending, and don't say it's done. Retrying the same command later is safe. For reads, you may retry with `--allow-stale` and say the data may be out of date. |
| `STALE` | The task changed since you read it (e.g. edited on the user's phone). Show `details.current` and redo the request using its new `rev`. |
| `NOT_FOUND` | The id no longer matches (the text was edited or the task was removed). Search again. |
| `AMBIGUOUS` | Several identical tasks; pick from `details.candidates` or ask the user. |
| `CONFLICT` | Someone edited the same note at the same moment. Re-read, then retry once. If it repeats, tell the user. |
| `UNSUPPORTED` | Recurring task (🔁): it can be rescheduled but not completed or cancelled here. Ask the user to tick it in Obsidian so the next occurrence is generated. |
| `LOCK_TIMEOUT` | Another `tasks` command is running. Wait a few seconds and retry. |
| `CONFIG` / `PATH_REJECTED` / `USAGE` | Run `tasks doctor --json` and report the failing check to the user. Don't try to work around it. |

If a command fails with `CONFIG` saying it is not configured (for example on a fresh machine), run `tasks bootstrap --json`, which sets everything up from the environment. If that reports missing variables, tell the user which ones are needed. If it says you are not logged in, ask the user to take over your computer, open a terminal and run `tasks login` themselves, then run bootstrap again. Never ask for, type or handle their Obsidian password or token.

`tasks doctor --json` checks installation, login, sync and the daily notes folder. `tasks sync --json` forces a sync. Neither is needed in normal use, because every command syncs on its own.
