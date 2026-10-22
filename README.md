# obsidian-tasks-agent-access

A small CLI that lets an AI agent search, create and edit [Obsidian Tasks](https://publish.obsidian.md/tasks/) in your **daily notes**. It works from the agent's own container through your existing **Obsidian Sync** subscription, using the official [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless) client.

- No server, endpoint or background process. Each command syncs, does its work, syncs again and exits.
- Only daily notes are reachable: files whose name matches the daily-note format (e.g. `2026-10-22.md`) in the configured folder, which can be the vault root. Other notes beside them, traversal and symlink escapes are all rejected.
- Edits are surgical: one line changes, and everything else in the note (unknown fields, links, spacing, CRLF, BOM) is left byte-for-byte as it was.
- Safe under concurrency: a cross-process lock, optimistic `rev` checks, re-verification after every push, and conflicted-copy detection.

## Install on an agent

Agents need Node.js 22+, internet access and two secrets.

### 1. Get an Obsidian token (once, on your own machine)

`ob login` asks for your password and 2FA code, so do it yourself rather than through an agent:

```bash
npx -y obsidian-headless login
cat ~/.obsidian-headless/auth_token      # Linux: ~/.config/obsidian-headless/auth_token
```

Store that value as a secret named `OBSIDIAN_AUTH_TOKEN` in each agent's environment (its platform's secret store, not a prompt or a file). Then delete the local `auth_token` file rather than running `ob logout`, which may revoke the token.

The token grants access to your whole Obsidian account (all vaults, Sync, Publish), not just this tool, so treat it like a password. To revoke it, sign out devices or change your password in your Obsidian account settings.

For end-to-end encrypted vaults, also provide `OBSIDIAN_E2E_PASSWORD`.

### 2. Configure the agent's environment

| variable | example | notes |
|---|---|---|
| `OBSIDIAN_AUTH_TOKEN` | *(secret)* | required |
| `TASKS_REMOTE_VAULT` | `Personal` | required on first run; see `npx obsidian-headless sync-list-remote` |
| `TASKS_VAULT_PATH` | `~/obsidian-vault` | default |
| `TASKS_DAILY_DIR` | `""` | daily notes folder; empty = vault root (default) |
| `TASKS_NOTE_FORMAT` | `YYYY-MM-DD` | default |
| `TASKS_TZ` | `America/Los_Angeles` | containers usually run on UTC, so set this |
| `TASKS_BULLET` | `*` | |
| `TASKS_TEMPLATE` | `daily_note_template.md` | used by `add --create-note` |
| `TASKS_HEADING` | `## Tasks` | default: append to the end of the note |
| `TASKS_STATUSES` | `>=in_progress` | custom status symbols from your Tasks plugin settings |
| `TASKS_EXCLUDE_FOLDERS` | `Projects,Archive` | top-level folders not to download |
| `TASKS_FILE_TYPES` | `unsupported` | skip images, audio, video, PDFs |
| `TASKS_SKILLS_DIR` | `~/.claude/skills` | where to install the agent skill |
| `TASKS_DEVICE_NAME` | `assistant` | shown in Obsidian Sync version history |

### 3. Install and bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/doneel/obsidian-tasks-agent-access/master/install.sh | bash
```

This installs the latest release with npm (into `~/.local` if the global prefix isn't writable), then runs `tasks bootstrap`. Bootstrap links the vault, configures selective sync, does the first sync, installs the skill and runs `tasks doctor`. It is idempotent: when the machine is already set up it only runs the health check, so it can go in an agent's session start-up. Pin a version with `TASKS_VERSION=v0.1.0`; force an upgrade with `TASKS_UPGRADE=1`.

Without the script:

```bash
npm install -g https://github.com/doneel/obsidian-tasks-agent-access/releases/latest/download/obsidian-tasks-agent-access.tgz
tasks bootstrap
```

Config is written to `~/.config/obsidian-tasks-agent-access/config.json` (override with `TASKS_CONFIG`), and the vault link to `~/.config/obsidian-headless/`. As long as the agent's home directory persists, later sessions need no reinstall or reconfiguration; if it doesn't, re-running the install line restores everything from the environment.

Native-module note: `obsidian-headless` uses `better-sqlite3`, which ships prebuilt binaries for common Linux images. On Alpine/musl you may need `python3 make g++`.

### Manual setup (interactive machines)

`tasks setup` takes the same settings as flags (`tasks setup --help`), for example:

```bash
tasks setup --remote-vault "My Vault" --vault-path ~/obsidian-vault --daily-dir "" --timezone America/Los_Angeles \
  --bullet "*" --template daily_note_template.md --statuses ">=in_progress" --exclude-folders "A,B" --file-types unsupported
```

`config.example.json` shows a full config for a vault with root-level `YYYY-MM-DD.md` notes.

### Selective sync

Obsidian Sync downloads the whole vault unless told otherwise. When daily notes live at the vault root, you can exclude every top-level folder, but the other root-level notes still download (they stay unreachable through the CLI). `--exclude-folders` skips top-level folders the agent never needs. Exclusions only cover **folders**: root-level files still sync, and `tasks doctor` lists them along with any large folders you haven't excluded. `--file-types unsupported` stops images, audio, video and PDFs from downloading. Markdown always syncs. App config syncing is turned off.

## Config reference (`config.json`)

| key | default | meaning |
|---|---|---|
| `vaultPath` | | local vault folder |
| `vaultName` | | used for `obsidian://` links |
| `dailyNotesDir` | `""` (vault root) | folder holding daily notes; only files in it matching `noteFormat` are reachable |
| `noteFormat` | `YYYY-MM-DD` | daily note path format (moment tokens, e.g. `YYYY/MM/YYYY-MM-DD`) |
| `timezone` | system | IANA zone for `today` and relative dates (`TASKS_TZ` overrides) |
| `bullet` | match note, else `-` | bullet for new tasks |
| `heading` | none | new tasks go under this heading, e.g. `## Tasks` (otherwise the end of the note) |
| `template` | none | vault-relative template used by `add --create-note` (`{{date}}`, `{{date:FORMAT}}`, `{{date+1d:FORMAT}}`, `{{title}}`). A trailing empty bullet (`* `) is filled by the first task |
| `globalFilter` | none | Tasks-plugin global filter, e.g. `#task` |
| `statuses` | plugin defaults | custom status symbols → `todo`/`in_progress`/`done`/`cancelled`, matching your Tasks plugin status settings, e.g. `{">": "in_progress"}` |
| `setCreatedDate` | `false` | add ➕ created date to new tasks |
| `sync.enabled` | `true` | |
| `sync.command` | bundled `ob sync` | argv override |
| `sync.timeoutSec` | `180` | |
| `lockTimeoutSec` | `120` | |

## Commands

```
tasks list | search | get | add | update | complete | reopen | sync | doctor | setup | bootstrap | skill
```

Run `tasks help` for flags. Add `--json` for structured output. Exit codes: 2 usage, 3 not found, 4 ambiguous, 5 stale/conflict, 6 sync failed, 7 unsupported, 8 config, 9 lock timeout.

## Agent skill

`SKILL.md` documents the commands and the expected agent behaviour. Install it into a skills directory with:

```bash
tasks skill --install ~/.claude/skills      # or set TASKS_SKILLS_DIR for bootstrap
```

## Design notes

**Task identity.** Ids look like `3f2a9c01be:14`: a hash of the note path plus the task text (without tags or metadata), and the line number at read time. Status, date, priority and tag edits keep the id, and line shifts don't break it unless several tasks share identical text, in which case the command fails with `AMBIGUOUS`. `rev` is a hash of the exact line; passing it turns any concurrent edit into `STALE` instead of a blind overwrite.

**Sync safety.** Every command does lock → `ob sync` → act → `ob sync` → verify that the edited line is still present and no new conflicted copy appeared → unlock. If the final push fails, the command returns `SYNC_FAILED` with `localChangeApplied: true` and never reports success. All mutations are idempotent (complete/reopen are no-ops when already in that state, and `add` won't duplicate an identical open task), so retries are safe.

**Tasks-plugin compatibility.** Parsing mirrors the plugin's emoji serializer: fields are read from the end of the line backwards, with `️` variants and the 📆/🗓/⌛ aliases. It supports statuses ` `/`x`/`X`/`/`/`-`, and treats other symbols as todo, like the plugin. On completion it appends `✅ date`; cancelling appends `❌ date`.

**Recurring tasks** (🔁) can be listed and rescheduled. Completing or cancelling them is refused with `UNSUPPORTED`, because generating the next occurrence needs the plugin's recurrence engine. Tick those in Obsidian.

**Not in v1:** multiple vaults, notes other than daily notes, task deletion, dependency (`🆔`/`⛔`) editing, Dataview-format task fields.

## Development

```bash
npm install
npm test        # compiles and runs the node:test suite (parser, edits, sync failure/conflict simulations, CLI)
npm pack        # produces the installable tarball (attached to GitHub releases as obsidian-tasks-agent-access.tgz)
```
