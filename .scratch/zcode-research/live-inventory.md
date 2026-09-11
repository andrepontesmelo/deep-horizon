# Live `~/.zcode` inventory (dex gga3rniv)

Date: 2026-09-11. Method: read-only inspection of the live tree (`ls`, `find`, `jq`, `sqlite3 file:...?mode=ro`, `zcode --help`, `zcode commands list`, `zcode skills list`). Nothing under `~/.zcode` was modified. Secret-bearing values (credentials, env) were queried structurally and are not quoted here.

## 1. Top-level layout

| Path | What it is |
|---|---|
| `~/.zcode/AGENTS.md` | User-scope agent instructions (markdown). Loaded as context in every session — this session itself shows it sourced as "user default instructions". |
| `~/.zcode/cli/` | CLI-engine state: config, session DB, per-session dirs, diagnostics logs, plugins. |
| `~/.zcode/v2/` | Desktop (Electron) app state: settings, provider config, credentials, app logs, bot locks, task index, telemetry, certs, crash queue. |
| `~/.zcode/export-log-stage/`, `~/.zcode/feedback/{attachments,logs}/`, `~/.zcode/plugin-workspace/`, `~/.zcode/workspace/default/` | All empty. |
| `~/.zcode/tmp/paste-attachments/` | Transient paste payloads. |

## 2. Settings/config files

### User scope

**`~/.zcode/cli/config.json`** (mode 0600, plain JSON) — the CLI config ZCode reads. Top-level keys observed: `command, features, hooks, logging, mcp, memory, model, modelAnomalyGuard, modelCatalog, modelStream, network, permission, plugins, provider, skill, skills, storage, subagents, toolConcurrency, ui`.

Key sections (observed values):

- `hooks`: `{"enabled": false, "timeoutMs": 60000, "maxOutputBytes": 32768, "events": {"SessionStart": [], "UserPromptSubmit": [], "PreToolUse": [], "PermissionRequest": [], "PostToolUse": [], "PostToolUseFailure": [], "Stop": []}}` — this is the live hook-event vocabulary: **7 events, all empty, hooks disabled**.
- `mcp`: `{"servers": {"firecrawl": {type: "stdio", command: "npx", args: ["-y","firecrawl-mcp"], env: {...}, timeoutMs: 30000}}}` — note the path is `mcp.servers.<name>`, **not** `mcpServers`.
- `plugins`: `{enabled: true, dirs: [], enabledPlugins: {"browser-use@zcode-plugins-official": false}, options: {}, suppressedBuiltins: []}`.
- `skills` (plus empty `skill: {}`): `{enabled: true, includeInstructions: true, metadataBudget: 20000, roots: []}` — user skills are picked up from `~/.agents/skills/` with `roots` empty, so that is a built-in default (UNPROVEN whether `roots: []` means "default roots" vs "none"; observed behavior says skills load).
- `storage`: `{dir: "~/.zcode", sessionDbPath: "~/.zcode/cli/db/db.sqlite"}` — authoritative pointer to the session store.
- `permission`: `{mode: "yolo", allowedTools: [], disallowedTools: [], autoApproveHighRisk: false, allowMediumRiskInAuto: false}`.
- `logging`: `{level: "info", format: "text"}`; `features`: compact/rewind/subagent/memory/skill/mcp all `true`; `subagents`: `{autoBackgroundMs: 1000}`.
- Sibling backups `config.json.bak-manual` and `config.json.bak-20260910-firecrawl-mcp` show this file is edited in place by tooling.

Other user-scope files:

- `~/.zcode/cli/model-catalog.json` (0600) — fetched cache: `builtinModels, builtinProviders, endpoint, lastFetchedAt, retirementSafe`.
- `~/.zcode/cli/version.json` — update-check state (`checkedVersion: 3.11.2-22`).
- `~/.zcode/v2/setting.json` — desktop app preferences (JSON): `recentProjects`, `locale`, `desktopWindowSize`, indexing toggles, `enabledBuiltinAgentCliProviders: ["glm"]`, `lastWorkspaceSession`, `modelIoFullRetentionEnabled: false`, etc.
- `~/.zcode/v2/config.json` — model provider registry under top-level key `provider` (entries like `builtin:bigmodel` with `kind`, `options.baseURL`, `enabled`, `models`).
- `~/.zcode/v2/credentials.json` (0600) — auth material. Off-limits.
- Small state: `v2/agents-state.json`, `v2/bot-config.json`, `v2/bot-state.v2.json`, `v2/coding-plan-cache.json`, `v2/telemetry-state.json`.

### Workspace scope

- **None exists anywhere on this machine**: `find /home/andre/git -maxdepth 2 -name ".zcode*"` (excluding `.worktrees`) returns nothing; `/home/andre/git/horizon-line` has no repo-root `AGENTS.md` and no `.zcode/`. So there is no live example of workspace config, and the workspace slot is completely free.
- UNPROVEN (defer to the parallel docs ticket): the exact workspace-scope filename and precedence (e.g. `<repo>/.zcode/settings.json`), and whether workspace `AGENTS.md` is auto-loaded (user-scope `~/.zcode/AGENTS.md` definitively is).

## 3. Everything already configured (collision list)

| Kind | What exists | Config source |
|---|---|---|
| Hooks | **None** (all 7 event arrays empty, `enabled: false`) | `~/.zcode/cli/config.json` `.hooks` |
| Slash commands | **None** — `zcode commands list` → "No custom commands found." | (no commands dir anywhere under `~/.zcode`) |
| Skills | 64 listed: 53 user skills at `/home/andre/.agents/skills/<name>/SKILL.md` (source tag `user/agents` — outside `~/.zcode`), plus plugin skills at `~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin>/<version>/skills/<name>/SKILL.md` (zcode-guide x5, skill-creator, document-skills x4) | `~/.agents/skills/`, plugin cache |
| MCP | **One server: `firecrawl`** (stdio, `npx -y firecrawl-mcp`, env points FIRECRAWL_API_URL at a local/tailnet host). Tool namespace `mcp__firecrawl__*` is taken. | `~/.zcode/cli/config.json` `.mcp.servers` |
| Plugins | Marketplaces registered: `zcode-plugins-official` (11 plugins) and `claude-plugins-official` (287) in `~/.zcode/cli/plugins/known_marketplaces.json`; `installed_plugins.json` = `{"version":1,"plugins":[]}` (nothing user-installed); versioned cache at `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`; per-plugin writable data at `~/.zcode/cli/plugins/data/<name>@<marketplace>/`; marketplace content at `~/.zcode/cli/plugins/marketplaces/<id>/`; `browser-use@zcode-plugins-official` explicitly **disabled** in config | above paths |

## 4. CLI binary and `cli/` layout

- Binary: `/home/andre/.npm-global/bin/zcode`. `zcode --version` → `zcode-app-cli 3.11.2-22` + `zcode-runtime 0.16.5` (help banner says `zcode 0.16.5`).
- Subcommands: `app-server, commands, doctor, login, logout, plugins, skills, tui, version`. **No** `sessions`/`hooks`/`mcp`/`debug` subcommands. Relevant flags: `--resume <sessionId>` (sess_...), `-c/--continue`, `--prompt`/`-p --print` (headless), `--cwd`, `--mode <build|edit|plan|yolo>`, `--json`, `--verbose`, `--disallowed-tools`, `--target`, `--attach`, `--surface`. Slash: `/resume /fork /rewind /compact /mcp /model /mode /skill /goal /expert /new`.
- `cli/` roles: `config.json` = config; `db/db.sqlite` = session/conversation store; `agents/` = subagent run records; `artifacts/sess_*/` = spilled large tool results (`call_*-tool-result-*.json`); `exec/sess_*/` + `exec/bash-startup/sess_*/` + `exec/shell-snapshots/snapshot-bash-*.sh` = shell machinery; `log/` = diagnostics; `rollout/` = `model-io-*.jsonl` per-subagent model IO; `memories/projects/<slug-hash>/memory` = per-project memory; `plugins/` = cache (downloaded content) + `data/` (writable) + `marketplaces/` + registries. The CLI owns `cli/`; the plugin cache is inert versioned content — an adapter must treat `cache/` as disposable and never write there.

## 5. Sessions and session ids (what an adapter can cite)

- **Authoritative store: `~/.zcode/cli/db/db.sqlite`** (SQLite, WAL mode; `-wal`/`-shm` siblings present). Table `session`: `id` TEXT PRIMARY KEY (format `sess_<uuid>`), `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `title`, `version`, `time_created`/`time_updated` (ms epoch), `task_type` (`interactive` | `subagent_child`), `trace_id`, `time_archived`, `time_compacting`. Related tables: `message`, `part` (conversation content keyed by `session_id`), `todo`, `permission`, `tool_usage`, `model_usage`, `turn_usage`, `input_history`, `session_entry/input/target/task_link`, `workflow_*`. Counts: 141 sessions, 5350 messages.
- **Current session at research time: `sess_0a61d0e8-9031-45a0-bf40-72e33de5eb04`** (`directory=/home/andre/git/horizon-line`, `task_type=interactive`) — found via `SELECT id FROM session ORDER BY time_updated DESC`. This ticket's subagents appear as rows `sess_subagent_agent_<agent-uuid>` with `task_type=subagent_child`.
- Subagent disk records: `~/.zcode/cli/agents/sess_<parent>/agent_<uuid>/metadata.json` with keys `agentId, childSessionId, parentSessionId, parentToolUseId, createdAt, updatedAt, cwd, workspaceRoot, status, prompt, profileId, profileSnapshot, outputFile, taskOutputFile, metadataFile` — a JSON citation of parent/child session ids without touching the DB.
- Main-session transcripts are **in SQLite, not JSONL**. JSONL that does exist: `cli/rollout/model-io-sess_subagent_agent_*.jsonl` (subagent model IO; retention limited by `modelIoFullRetentionEnabled: false`) and `cli/log/zcode-YYYY-MM-DD.jsonl` (diagnostics).

## 6. Locks / state an adapter must not fight

- `~/.zcode/cli/db/db.sqlite-wal` / `-shm` — live WAL; open the DB read-only (`file:...?mode=ro`) or not at all.
- `~/.zcode/v2/tasks-index.sqlite{,-wal,-shm}` — desktop task/automation index (tables `automations`, `automation_runs`, `task_groups`, `off_peak_tasks`, ...).
- `~/.zcode/v2/bots-runtime-locks/telegram-polling/<sha256>.lock` — active telegram-bot polling lock; do not create/remove siblings there.
- `~/.zcode/v2/credentials.json` and `~/.zcode/v2/certs/zcode-network-ca.key`/`.pem` — auth/CA material, absolutely off-limits.
- `~/.zcode/v2/crash/{live,new,pending,completed,archive}` + `client_id` + `settings.dat` — crash reporter queue; don't touch.
- No `.pid` or `Singleton*` files found under `~/.zcode`.

## 7. Hook output / logging observability

- No hooks run today, so there is no hook-specific stream. The observable surface is:
  - `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` — one JSON object per line: `{timestamp, level, event, module, message, traceId, spanId, sessionId, ...}`. Events seen include `bootstrap.app.startup.plugins.completed`, `turn.phase.started/completed`. **Every line carries `sessionId`** — so live verification of an adapter's hook can be done by grepping this file for the session id. Verbosity governed by `config.json` `.logging.level` and the `--verbose` CLI flag.
  - `~/.zcode/v2/logs/YYYY-MM-DD.log` — desktop app/host log, lines like `[ts] [level] [pid: N] [main] [host-log] ... [rpc:call] <method> OK (Xms)`.

## Synthesis — where an adapter fits

- **Its config would live in `~/.zcode/cli/config.json`** (user scope): a hook handler goes under `.hooks.events.<Event>` (the 7-event vocabulary above; currently all empty and `enabled:false`, so the adapter must also flip `enabled` — the file is plainly hand-edited, see the `.bak` siblings). An MCP server would go under `.mcp.servers.<name>` (`firecrawl` is taken). A workspace-scope slot (repo `.zcode/...`) is completely free on this machine — but the exact workspace filename/precedence is UNPROVEN here; cross-check the docs ticket.
- **The session id it can cite: `session.id` from `~/.zcode/cli/db/db.sqlite`** (`sess_<uuid>`; current example `sess_0a61d0e8-9031-45a0-bf40-72e33de5eb04`), or for subagents `parentSessionId`/`childSessionId` in `~/.zcode/cli/agents/sess_<parent>/agent_<uuid>/metadata.json`. `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` lines also carry `sessionId` for cross-checking.
- **Must not touch**: `v2/credentials.json`, `v2/certs/*`, `v2/bots-runtime-locks/*`, `v2/crash/*`, the `-wal`/`-shm` files (write-wise), `plugins/cache/*` (disposable content, not config), and `~/.agents/skills/` (user's 53 skills — a new skill belongs in a plugin or a new root, not by overwriting these).
- **Collisions to avoid**: the names `firecrawl` (MCP), the 53 user skill names under `~/.agents/skills/`, plugin namespaces `<plugin>@zcode-plugins-official`, and built-in slash commands (`/resume`, `/fork`, `/compact`, `/mcp`, `/model`, `/mode`, `/skill`, `/goal`, `/expert`, ...). No custom commands or hooks exist, so those namespaces are empty.
