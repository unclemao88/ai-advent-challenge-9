# DeepSeek Agent · day 15

A stateful AI agent on top of the DeepSeek API, built with Node.js and Express, with a small browser UI. It is not a proxy: every request goes through a task manager, a controlled state machine, three separate memory layers, a user profile and enforced invariants before and after DeepSeek is called.

```text
User request → Task Manager → State Machine ─┬─ Profile
                                              ├─ Invariants
                                              ├─ Short-term / Work / Long-term memory
                                              ▼
                Context Builder → Token Counter → DeepSeek API
                                              ▼
                Response validation: state transition · invariants · profile
                                              ▼
                Memory / task updates → Persistence (JSON) → Web UI
```

| | |
|---|---|
| Path | `/opt/deepseek-app-day15` |
| Port | `3015` |
| Service | `deepseek-app` (`/etc/systemd/system/deepseek-app.service`), user `deepseek-app` |
| Configuration | `/etc/deepseek-app.env` (production), `.env` (development) |
| Data | `/opt/deepseek-app-day15/data` (local JSON files) |

## Contents

1. [Requirements](#1-requirements)
2. [Node.js version](#2-nodejs-version)
3. [Installation](#3-installation)
4. [Directory structure](#4-directory-structure)
5. [Environment configuration](#5-environment-configuration)
6. [DeepSeek API configuration](#6-deepseek-api-configuration)
7. [Development startup](#7-development-startup)
8. [Production startup](#8-production-startup)
9. [Creating the deepseek-app user](#9-creating-the-deepseek-app-user)
10. [File permissions](#10-file-permissions)
11. [systemd installation](#11-systemd-installation)
12. [Starting, stopping, restarting](#12-starting-stopping-restarting)
13. [Viewing logs](#13-viewing-logs)
14. [Checking application status](#14-checking-application-status)
15. [Accessing the web interface](#15-accessing-the-web-interface)
16. [Backup of local JSON data](#16-backup-of-local-json-data)
17. [Restoring local data](#17-restoring-local-data)
18. [Troubleshooting](#18-troubleshooting)

Then: [Using the agent](#using-the-agent) · [Architecture](#architecture) · [REST API](#rest-api) · [Testing](#testing) · [Security](#security)

---

## 1. Requirements

- Debian 12 (or another systemd-based Linux) for production; macOS or Linux for development
- Node.js 20 or newer, with npm (see below)
- A DeepSeek API key (<https://platform.deepseek.com>)
- `curl` (the installer uses it for the health check and the tokenizer download)
- Outbound HTTPS to `api.deepseek.com` (and once to `huggingface.co` for the tokenizer)

No database, no build step, no CDN: the dependencies are `express`, `dotenv` and `@huggingface/tokenizers` (pure JS).

## 2. Node.js version

**Node.js ≥ 20** is required (`engines` in `package.json`); **22 LTS** is recommended. It was developed on Node 24 and verified on Debian 12 with Node 22. Debian's own `nodejs` package is too old, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node -v            # v22.x
command -v node    # the path goes into ExecStart= (the installer finds it)
```

## 3. Installation

From a checkout of this directory on the server:

```bash
cd week2/day15
sudo sh scripts/install-service.sh        # --no-start, --skip-tokenizer
```

The script does steps 9 to 12 for you and is idempotent. Run it again after `git pull` to update. It never overwrites `data/` or an existing `/etc/deepseek-app.env`:

1. checks root, systemd, Node.js ≥ 20, and finds the real `node` path;
2. creates the system user `deepseek-app` if it is missing;
3. copies the code to `/opt/deepseek-app-day15` (code only);
4. `npm ci --omit=dev`;
5. downloads DeepSeek's tokenizer (~8 MB, SHA-256 checked) for exact token counts;
6. creates the `data/` structure (missing files only) and `/etc/deepseek-app.env` (root, `0600`) if absent;
7. sets permissions: code `root:deepseek-app` read-only, `data/` owned by `deepseek-app`;
8. installs `/etc/tmpfiles.d/deepseek-app-day15.conf` (systemd recreates `data/` before the services start at every boot) and `/etc/systemd/system/deepseek-app.service` with the detected node path (a unit of the same name from another installation is saved as `.bak-<time>`), runs `systemd-analyze verify`, `daemon-reload`, `enable`, `restart`, and checks `/api/health`.

Then set the API key and restart:

```bash
sudo nano /etc/deepseek-app.env          # DEEPSEEK_API_KEY=sk-...
sudo systemctl restart deepseek-app
```

Manual installation (without the script) is described in sections 9 to 11.

## 4. Directory structure

```text
/opt/deepseek-app-day15/
├── src/
│   ├── server.js                  entry: config validation, logger, tokenizer, HTTP server, graceful shutdown
│   ├── config/index.js            configuration: every environment variable, validated at startup
│   ├── api/deepseek.js            DeepSeek API communication (the only module that calls DeepSeek)
│   ├── agent/
│   │   ├── agent.js               agent orchestration: the task lifecycle and every rule around the API call
│   │   ├── stateMachine.js        task state machine: states, transition table, validation (pure functions)
│   │   ├── contextBuilder.js      context construction: the single source of the API context
│   │   ├── planner.js / executor.js / validator.js   one class per working state
│   │   ├── stepRunner.js          context → DeepSeek → parse → profile check (+ one correction)
│   │   ├── invariantChecker.js    invariant enforcement (rules + model reports)
│   │   ├── responseParser.js      the model's JSON reply → a bounded, trusted structure
│   │   └── prompts.js             system prompt and per-state instructions
│   ├── tasks/taskManager.js       task management and persistence (one file per task)
│   ├── memory/
│   │   ├── shortTermMemory.js     short-term memory (the current conversation)
│   │   ├── workMemory.js          work memory (one document per task)
│   │   ├── longTermMemory.js      long-term memory (solutions, knowledge; profile joined in)
│   │   ├── memoryManager.js       the three layers, storage switching, explicit promotion
│   │   ├── retrieval.js           relevance selection of long-term entries
│   │   ├── memoryCommands.js      "remember: …", "requirement: …" rules
│   │   └── storage/               MemoryStorage abstraction: StorageProvider, JSONFileStorage, InMemoryStorage, registry, config
│   ├── profile/                   user profile (profileManager.js) and profile consistency check (profileChecker.js)
│   ├── invariants/                invariants (invariantManager.js) and the technology catalogue
│   ├── history/chatHistory.js     chat history (what the UI shows)
│   ├── token/tokenCounter.js      token counting (DeepSeek tokenizer or a labelled estimate)
│   ├── persistence/               data layout, atomic JSON files, JSON documents
│   ├── http/                      web/API routes: Express app, middleware, one router per resource
│   └── utils/                     logging, errors, validation, serial queue
├── public/                        index.html, app.js, styles.css, markdown.js (no framework, no CDN)
├── test/                          node:test suites
├── scripts/                       install-service.sh, backup-data.sh, restore-data.sh, fetch-tokenizer.sh, mock-deepseek.js
├── systemd/
│   ├── deepseek-app.service       the unit file
│   └── tmpfiles.conf              installed as /etc/tmpfiles.d/deepseek-app-day15.conf (recreates data/ at boot)
├── vendor/deepseek-tokenizer/     tokenizer.json (downloaded)
└── data/                          all persistent data (see below), writable by deepseek-app only
```

### Local JSON storage structure

```text
data/
├── memory/
│   ├── short-term.json       { "messages": [ {id, role, kind, content, timestamp, taskId, state} ] }
│   ├── work-memory.json      { "task-<id>": { objective, plan, requirements, decisions, facts,
│   │                           intermediateResults, validationResults, variables,
│   │                           invariantChecks, profileChecks, proposals, log } }
│   └── long-term.json        { "solutions": [...], "knowledge": [...] }
├── profile/profile.json      { "profile": { style, format, limitations, createdAt, updatedAt } | null }
├── invariants/invariants.json
│                             { "architecture": [...], "technicalSolutions": [...],
│                               "stackLimitations": [...], "businessRules": [...] }
├── tasks/
│   ├── task-<uuid>.json      one task: state, nextState, plannedAction, currentAction, mode,
│   │                         objective, validation, completion, workMemory ref, history, …
│   └── active.json           { "activeTaskId": "task-…" | null, "defaultMode": "manual" }
├── history/chat-history.json { "messages": [ {id, role, tag, content, date, time, timestamp, task, …} ] }
└── config/memory-storage.json
                              { "shortTerm": {provider, options}, "work": {…}, "longTerm": {…},
                                "shortTermMaxMessages": 30 }
```

Every write is atomic (temporary file, `fsync`, `rename`) and keeps the previous version as `<file>.bak`. A file that is not valid JSON is moved aside as `<file>.corrupt-<time>` and the domain starts empty; nothing else is affected. Files are created on first start if missing, never overwritten.

## 5. Environment configuration

All configuration comes from environment variables, read and validated in one place (`src/config/index.js`). A present but invalid value (for example `PORT=abc`) **stops the server at startup** with a log line naming the variable. A missing API key is only a warning: the UI loads, and questions fail with a clear message.

- **Production:** the unit sets `NODE_ENV=production`, `PORT=3015`, `HOST=0.0.0.0` and `DATA_DIR=/opt/deepseek-app-day15/data`. Everything else comes from `/etc/deepseek-app.env` (`EnvironmentFile=`), which is shared with the other deepseek-app services. **Keep `PORT`, `HOST` and `DATA_DIR` out of that file:** values from an `EnvironmentFile` override the unit's `Environment=` lines (the installer warns). In production a `.env` file is ignored.
- **Development:** `cp .env.example .env`. Variables already set in the shell take precedence over `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Required.** Server only; never sent to the browser, never logged. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Base URL or full `/chat/completions` URL (`DEEPSEEK_API_URL` is accepted too). |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` or `deepseek-reasoner`. |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Timeout for one API call, body included. |
| `DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_TEMPERATURE` | API defaults | Optional generation settings. |
| `PORT` / `HOST` | `3015` / `0.0.0.0` | Listen address. |
| `NODE_ENV` | `development` | `production` refuses to run as root and ignores `.env`. |
| `DATA_DIR` | `data` | Data directory (relative paths: from the app directory). |
| `LOG_LEVEL` / `LOG_DIR` | `info` / off | Log level; optional rotated `app.log` in addition to the journal. |
| `STORAGE_SHORT_TERM`, `STORAGE_WORK`, `STORAGE_LONG_TERM` | `json` | Initial storage provider **per layer** (`json` or `memory`); later changed in the UI and kept in `data/config/memory-storage.json`. |
| `SHORT_TERM_MAX_MESSAGES` | `30` | Messages kept in short-term memory. |
| `LONG_TERM_CONTEXT_TOKENS` | `2000` | Token budget for relevant long-term memory per request. |
| `MAX_CONTEXT_TOKENS` | `100000` | Upper bound per request; oldest chat turns are dropped first. |
| `DEFAULT_MODE` | `manual` | Mode of new tasks until changed in the UI. |
| `MAX_AUTO_STEPS` | `8` | Most states one auto run executes. |
| `MAX_VALIDATION_RETRIES` | `2` | Failed validations before the task waits for the user. |
| `MAX_INVARIANT_REVISIONS` | `1` | Automatic revisions of a result the invariant check rejected. |
| `MAX_PROFILE_REVISIONS` | `1` | Automatic corrections of a response that breaks the profile. |
| `APP_AUTH_TOKEN` | off | Optional shared secret; every `/api` call then needs `Authorization: Bearer …`. |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-client limit on endpoints that call DeepSeek. |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy. |
| `SHUTDOWN_TIMEOUT_MS` | `90000` | How long shutdown waits for running steps. |

## 6. DeepSeek API configuration

```ini
# /etc/deepseek-app.env   (root:root, 0600)
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

- The endpoint is built once from `DEEPSEEK_BASE_URL` (`…/chat/completions` is appended unless already present). The model is sent as configured. Nothing else in the code hard-codes them.
- Requests use DeepSeek's JSON output mode; the agent's reply is a JSON object (see [Architecture](#architecture)).
- Errors are mapped to clear messages: missing key (503), wrong key (401/403), no balance (402), rate limit (429, with `Retry-After`), timeout (504), network or 5xx (502), invalid/empty response (502). The task goes to `failed` and **Retry** re-runs the same state; nothing already stored is lost.
- Token counting uses DeepSeek's own `tokenizer.json` (`npm run fetch:tokenizer`); without it, counts are labelled *estimated*.

## 7. Development startup

```bash
cd week2/day15
npm install
npm run fetch:tokenizer          # optional: exact token counts
cp .env.example .env             # set DEEPSEEK_API_KEY
npm run dev                      # restarts on changes in src/   (or: npm start)
```

Open <http://localhost:3015>.

**Without spending API credit**, use the bundled mock:

```bash
npm run mock:deepseek                                                    # terminal 1, port 3999
DEEPSEEK_API_KEY=mock DEEPSEEK_BASE_URL=http://127.0.0.1:3999 npm start   # terminal 2
```

Words in your question steer the mock: `ask me` (planning asks a question), `fail validation`, `python code` (a Python draft that the invariant check rejects and the model revises), `always python` (ends in a conflict), `model conflict`, `skip ahead` (the model proposes planning → done, which is rejected), `verbose` (breaks a word-limit/no-code profile once), `store the card` (breaks the business-rule example), `microservices` (breaks the architecture example).

> If your shell exports a real `DEEPSEEK_API_KEY`, it overrides `.env`. Use the mock command above for experiments.

## 8. Production startup

Production always runs under systemd as `deepseek-app` (sections 9 to 12). To start the production build by hand once (for example to see a startup error on the terminal):

```bash
sudo systemctl stop deepseek-app
sudo -u deepseek-app env $(sudo cat /etc/deepseek-app.env | grep -v '^#' | xargs) \
  NODE_ENV=production PORT=3015 DATA_DIR=/opt/deepseek-app-day15/data \
  node /opt/deepseek-app-day15/src/server.js
```

With `NODE_ENV=production` the app refuses to run as root. On `SIGTERM` it stops accepting connections, lets running agent steps finish writing their memory and task state, then exits.

## 9. Creating the deepseek-app user

The installer does this; by hand:

```bash
sudo useradd --system --create-home --user-group --shell /usr/sbin/nologin deepseek-app
id deepseek-app
```

## 10. File permissions

Only `data/` is writable by the service; the code cannot be changed by it, and the API key file is root-only.

| Path | Owner | Mode | Why |
|---|---|---|---|
| `/opt/deepseek-app-day15` (code, `node_modules`, `vendor`) | `root:deepseek-app` | dirs `750`, files `640` | the service reads, never writes |
| `/opt/deepseek-app-day15/data` (and subdirectories) | `deepseek-app:deepseek-app` | `700` | the only writable place |
| `data/**/*.json` | `deepseek-app:deepseek-app` | `600` | personal data |
| `/etc/deepseek-app.env` | `root:root` | `600` | holds the API key; systemd reads it before dropping privileges |

```bash
sudo mkdir -p /opt/deepseek-app-day15/data
sudo chown -R root:deepseek-app /opt/deepseek-app-day15
sudo chmod -R u=rwX,g=rX,o= /opt/deepseek-app-day15
sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day15/data
sudo find /opt/deepseek-app-day15/data -type d -exec chmod 700 {} +
sudo find /opt/deepseek-app-day15/data -type f -exec chmod 600 {} +
sudo install -m 600 -o root -g root /dev/null /etc/deepseek-app.env   # only if it does not exist yet
```

The unit enforces the same at runtime: `ProtectSystem=strict`, `ReadOnlyPaths=/opt/deepseek-app-day15`, `ReadWritePaths=/opt/deepseek-app-day15/data`, `UMask=0077`.

## 11. systemd installation

The unit is [`systemd/deepseek-app.service`](systemd/deepseek-app.service), installed as `/etc/systemd/system/deepseek-app.service`:

```ini
[Unit]
Description=DeepSeek Agent (day 15: …)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=deepseek-app
Group=deepseek-app
WorkingDirectory=/opt/deepseek-app-day15
ExecStart=/usr/bin/node /opt/deepseek-app-day15/src/server.js   # replaced by the real node path
Environment=NODE_ENV=production
Environment=PORT=3015
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/opt/deepseek-app-day15/data
EnvironmentFile=/etc/deepseek-app.env
Restart=always
RestartSec=5
# … hardening: ProtectSystem=strict, read-only code, writable data/ only,
#   no capabilities, syscall filter, UMask=0077
[Install]
WantedBy=multi-user.target
```

Do not assume `/usr/bin/node`: the installer puts `command -v node` (resolved) into `ExecStart=`. By hand — **create the data directory first**, because the unit lists it in `ReadWritePaths=` and systemd builds the mount namespace before the application runs:

```bash
sudo install -d -o deepseek-app -g deepseek-app -m 700 /opt/deepseek-app-day15/data
sudo cp systemd/tmpfiles.conf /etc/tmpfiles.d/deepseek-app-day15.conf   # recreates it at boot
NODE=$(readlink -f "$(command -v node)")
sed "s|^ExecStart=/usr/bin/node |ExecStart=$NODE |" systemd/deepseek-app.service | sudo tee /etc/systemd/system/deepseek-app.service >/dev/null
sudo systemd-analyze verify /etc/systemd/system/deepseek-app.service
sudo systemctl daemon-reload
sudo systemctl enable deepseek-app
sudo systemctl start deepseek-app
sudo systemctl status deepseek-app
```

To follow a per-day unit name instead, install it under that name (the paths and the port stay the same):

```bash
sudo SERVICE_NAME=deepseek-app-day15 sh scripts/install-service.sh
```

Verified in a Debian 12 container with systemd and Node 22 at `/usr/local/bin/node`: the installer (twice, idempotent), `systemd-analyze verify` (clean), `systemd-analyze security` (exposure **1.5 OK**), process user `deepseek-app`, code not writable and env file not readable by the service user, a full task through the service, persistence across `systemctl restart`, automatic restart 5 s after `kill -9`, backup and restore.

## 12. Starting, stopping, restarting

```bash
sudo systemctl daemon-reload          # after changing the unit file
sudo systemctl enable deepseek-app    # start at boot
sudo systemctl start deepseek-app
sudo systemctl stop deepseek-app
sudo systemctl restart deepseek-app   # after changing /etc/deepseek-app.env
sudo systemctl disable deepseek-app   # no longer start at boot
```

## 13. Viewing logs

Logs are JSON lines in the journal (`SyslogIdentifier=deepseek-app`): startup, validated configuration (without secrets), request ids, task creation, state transitions, rejected transition proposals, DeepSeek call duration and token usage, API errors, invariant conflicts, profile corrections, persistence errors. Conversation text and the API key are never logged.

```bash
sudo journalctl -u deepseek-app -f                        # follow
sudo journalctl -u deepseek-app -n 100 --no-pager         # last 100 lines
sudo journalctl -u deepseek-app -o cat | grep '"task.transition"'
sudo journalctl -u deepseek-app -o cat | grep -E '"(invariant.conflict|state.proposal_rejected|profile.response_rejected)"'
sudo journalctl -u deepseek-app -o cat | grep '"deepseek.request"'   # duration and tokens per call
```

## 14. Checking application status

```bash
sudo systemctl status deepseek-app
systemctl is-active deepseek-app && systemctl is-enabled deepseek-app
curl -s http://127.0.0.1:3015/api/health            # {"status":"ok","uptimeSeconds":…}
curl -s http://127.0.0.1:3015/api/config            # model, apiKeyConfigured (true/false), tokenizer, storage
sudo ss -ltnp 'sport = :3015'
systemctl show -p NRestarts deepseek-app            # automatic restarts so far
```

## 15. Accessing the web interface

```text
http://<server-address>:3015
```

Open the port if a firewall is active (`sudo ufw allow 3015/tcp`). There are no user accounts. On an untrusted network set `APP_AUTH_TOKEN` in `/etc/deepseek-app.env`, or bind to `127.0.0.1` in the unit and put a TLS reverse proxy in front (then `TRUST_PROXY=true`).

## 16. Backup of local JSON data

```bash
sudo sh /opt/deepseek-app-day15/scripts/backup-data.sh                 # → /var/backups/deepseek-app/deepseek-app-day15-data-<time>.tar.gz
sudo sh /opt/deepseek-app-day15/scripts/backup-data.sh /srv/backups    # another directory
sudo sh /opt/deepseek-app-day15/scripts/backup-data.sh --stop          # stop the service for a snapshot consistent across files
```

Each file is written atomically, so a backup of the running service is consistent per file. By hand: `sudo tar -czf data-backup.tar.gz -C /opt/deepseek-app-day15 data`. Back up `/etc/deepseek-app.env` separately (it holds the key).

## 17. Restoring local data

```bash
sudo sh /opt/deepseek-app-day15/scripts/restore-data.sh /var/backups/deepseek-app/deepseek-app-day15-data-<time>.tar.gz
```

The script stops the service, moves the current `data/` aside as `data.before-restore-<time>` (never deleted), unpacks the archive (refusing unsafe paths), restores ownership and permissions, and starts the service. To reset a single domain, stop the service and delete its file (for example `data/memory/long-term.json`); it is recreated empty on start.

## 18. Troubleshooting

| Symptom | Fix |
|---|---|
| Banner "DEEPSEEK_API_KEY is not configured" | Set it in `/etc/deepseek-app.env`, then `sudo systemctl restart deepseek-app`. |
| `config.invalid` in the journal, service keeps restarting | A variable has an invalid value; the log names it. Fix `/etc/deepseek-app.env`. |
| `Failed to load environment files` | `/etc/deepseek-app.env` is missing. Re-run the installer, or create it (section 10). |
| The service listens on another port / uses another data dir | `/etc/deepseek-app.env` sets `PORT`, `HOST` or `DATA_DIR` and overrides the unit. Remove those lines. |
| `status=203/EXEC` | `ExecStart=` points to the wrong `node`. Re-run the installer, or fix it with `command -v node`. |
| `EACCES` / "Storage failure" | `sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day15/data` (section 10). |
| `EADDRINUSE` | Another process uses port 3015: `sudo ss -ltnp 'sport = :3015'`. |
| "DeepSeek API rejected the API key" / "insufficient balance" | Check the key / top up the DeepSeek account. |
| "did not answer within 60s" | Press **Retry** (the same state re-runs), or raise `DEEPSEEK_TIMEOUT_MS`. |
| Token counts say *estimated* | `sudo sh /opt/deepseek-app-day15/scripts/fetch-tokenizer.sh /opt/deepseek-app-day15/vendor/deepseek-tokenizer`, then restart. |
| A data file was edited by hand and broke | It was moved aside as `*.corrupt-<time>` and that domain started empty. Fix and move it back while the service is stopped. |
| "Invalid task transition … (a paused task can only resume …)" | Expected: the state machine refused an illegal step. Resume or continue as the task bar offers. |
| `Failed to set up mount namespacing: /opt/deepseek-app-day15/data: No such file or directory` and `Failed at step NAMESPACE` | The data directory does not exist. systemd mounts it (`ReadWritePaths=`) before starting the app, so it must exist first: `sudo install -d -o deepseek-app -g deepseek-app -m 700 /opt/deepseek-app-day15/data`, then restart. The message names `node` only because that is the command it was about to run. The shipped unit tolerates the missing path and `/etc/tmpfiles.d/deepseek-app-day15.conf` recreates it at boot; a unit copied by hand from an older revision does not. |
| `app.data_dir_unusable` in the journal | The data directory is missing or not writable by `deepseek-app`. The log line names it and the command to fix it (see also section 10). |
| A task stayed "running" after a crash | On start it is reset to its step, pending; **Continue** re-runs that step. |

---

## Using the agent

**Layout.** The chat scrolls on its own. The bottom form is fixed: the text field (*ask your question, master*), **ask**, and **profile** right next to it. Directly above the form, the **task bar** shows the task's *Current state*, *Next state*, *Mode* and *Planned action*, plus the controls that are valid right now: **Continue**, **Pause**, **Resume**, **Switch to Auto**, **Switch to Manual**, **New task**, **Cancel task**. The side panel (**Status** on narrow screens) shows the lifecycle, objective, current action, allowed transitions, validation, the transition history, the token counters and the invariants.

**Chat.** Every question and answer is stored in `data/history/chat-history.json` with id, role, text, date, time and timestamp, and reloaded after a page reload. User bubbles are tagged *you asked*, agent bubbles *agent answered*. Every agent answer ends with the state block generated from the real task:

```text
Current state: planning
Next state: execution
Planned action: Define implementation approach
Mode: Manual
```

**Task lifecycle.**

| State | What happens |
|---|---|
| `planning` | DeepSeek writes a numbered plan, checked against the invariants. |
| `execution` | DeepSeek produces the result. A result that breaks an invariant is rejected and revised. |
| `validation` | DeepSeek checks the result against objective, requirements and invariants; the rules re-check it. Failed → back to `execution` (limited retries). |
| `done` | Finished. The completion message offers the task's durable results for long-term memory (**Save** each one you want). Next state: none. |
| `paused` | Stopped by you. **Resume** returns to exactly the saved state. |
| `failed` | An error (timeout, API error). **Retry** re-runs the same state. |
| `cancelled` | Stopped for good. |

The transition table is defined once, in `src/agent/stateMachine.js`:

```text
planning   → planning, execution, paused, failed, cancelled
execution  → execution, validation, planning, paused, failed, cancelled
validation → validation, execution, done, paused, failed, cancelled
paused     → (only the state it was paused in), cancelled
failed     → (only the state that failed), cancelled
done, cancelled → final
```

A self-transition re-runs the stage (you answered a question or added information). `planning → validation`, `planning → done` and `execution → done` are illegal. They are refused with HTTP 409, and the current state is kept. When the model *proposes* an illegal next state, the proposal is rejected, recorded on the task and shown under the answer, and the task keeps its lifecycle.

When the agent needs an answer or an invariant conflict needs your decision, there is no special "waiting" state: the task **stays in its current valid state** and the task bar says what it is waiting for.

**Manual / Auto.** *Manual*: the agent runs one state and stops. Review it, type more information (the same stage re-runs with it), or press **Continue**. *Auto*: it moves through the legal transitions by itself until `done`. It still stops for a question, an invariant conflict, too many failed validations, a pause or an error. **Switch to Auto** on a task waiting for Continue carries on at once. **Switch to Manual** during an auto run stops it after the running step. **Pause** works any time; during a running step it lands when that step ends.

**Profile.** **profile** opens a modal over the page: view, edit, **Save**, **Clear** (empty fields, keep the profile), **Delete profile**, **Close**. It goes into every request from the next one on, and responses are checked against it (word limits, *no code*, *plain text*, *no emoji*, *bullet points*, *as a table*, English/Russian). A response that breaks it is corrected once automatically; if it still breaks it, the answer says so.

**Invariants.** **Invariants** (header) or **Manage** opens the editor: add, edit, enable/disable, delete, by category (*Architecture*, *Adopted technical solution*, *Stack limitation*, *Business rule*). **Add examples** adds one per category. Then ask *Rewrite backend in Python*:

```text
Conflict detected with invariant "Backend stack" — Backend must use Node.js + Express.
- The request uses Python, but the invariant requires Node.js / JavaScript …

Current state: planning
Next state: planning (again)
Planned action: Request permission to modify the invariant "Backend stack", or keep it and re-work the task within it.
[Update invariant] [Disable invariant] [Keep invariant] [Cancel task]
```

Invariants change only through the editor or these explicit decisions, never as a side effect of an answer.

**Memory.** **Memory** opens the inspector (short-term, work, long-term, storage per layer, tasks, the exact API context). Commands inside a question: `remember: …` / `remember solution: …` (long-term), `requirement: …` / `decision: …` / `fact: …` (work memory of the current task). Nothing reaches long-term memory without your click.

## Architecture

### Request processing (`POST /api/ask`)

```text
 1 validate input                          12 DeepSeek (StepRunner → DeepSeekClient)
 2 save the question (history + short-term) 13 receive, parse the JSON reply
 3 find the active task or create one      14 profile check → one correction if needed
 4-7 load profile, invariants, work and    15 invariant check (rules + model report) → revise or stop
     relevant long-term memory                 in the current state
 8 determine the state for this message    16 state machine: validate the proposed transition
 9 invariant pre-check of the request          (illegal → rejected, recorded)
   (conflict → stop, no API call)          17 update work memory (plan, decisions, results, checks)
10 ContextBuilder: the complete context    18 persist task, memory, history (atomic writes)
11 token count of exactly those messages;  19 save the answer (history + short-term)
   state machine validates entering the    20-22 return {task, response, messages, tokens}
   state (beginStep)                             → new bubbles, task bar, counters
```

In manual mode the chain stops after one state; in auto mode it continues while the state machine allows.

### Context construction

`ContextBuilder` (the only place that builds the context) assembles, in a fixed order:

```text
system:  [SYSTEM INSTRUCTIONS] [USER PROFILE] [AGENT INVARIANTS] [CURRENT TASK]
         [WORK MEMORY] [LONG-TERM MEMORY] (relevant entries) [SHORT-TERM MEMORY] (note)
user/assistant …   short-term memory as chat turns
user:    [TASK STATE] (state, step instruction, notes) [CURRENT REQUEST]
```

`[CURRENT TASK]` lists the objective, the mode, the lifecycle position and the allowed transitions. The model answers in JSON: `response`, `nextState` (a proposal), `plannedAction`, `needsUserInput`, `invariantConflicts`, `validation`, `workMemory`, `memoryProposals`. Every section is always present; an empty one says so. **Memory → API context** shows the exact messages.

### Token counting

- **Short-term**: the layer as chat turns; **Work**: the active task's work memory as formatted into the context; **Long-term**: profile + all stored entries.
- **Current request/context** = `tokenCounter.countRequest(contextBuilder.build(…).messages)`: the same object that is sent (system instructions, profile, invariants, task, work memory, relevant long-term memory, short-term turns, task state and your draft, rendered with DeepSeek's chat template). It is not only the typed text, and it updates as you type.
- DeepSeek's `tokenizer.json` gives exact counts; without it a documented estimate is used and labelled. The tokenizer lives behind `TokenCounter` and can be replaced. After each call, the `prompt_tokens`/`completion_tokens` DeepSeek reports are shown as "Last DeepSeek call".

### Invariant enforcement

1. Every enabled invariant is in every request, grouped by category, as hard constraints.
2. Rules (no API call): a technology catalogue (languages, frameworks, databases, caches, frontends, **architecture styles**, **API styles**) reads what an invariant allows or forbids. A text that *adopts* a different technology of the same kind conflicts, as do code blocks in another language. **Prohibitions** in the rule text ("Never store full credit card numbers") catch sentences that do exactly that, unless negated. Optional forbidden terms are supported too.
3. The model reports conflicts it sees; the reports are validated against the active invariants.
4. Request → stop before the API call; plan → stop; result → rejected and revised, then stop if it still violates; validation → stop. "Stop" means the task stays in its current state and you decide.

### Memory storage abstraction

`StorageProvider` (key → JSON value: `get`, `set`, `delete`, `keys`, `getAll`, `replaceAll`) is the `MemoryStorage` interface. `JSONFileStorage` and `InMemoryStorage` implement it, and `registry.js` maps names to classes. Each layer has its own instance and its own configuration in `data/config/memory-storage.json`; switching a layer copies its data. To add SQLite/PostgreSQL/Redis: one subclass + one `registerProvider()` call.

## REST API

JSON everywhere. Errors: `{ error, code, requestId }` with 400 (invalid input), 404, 409 (invalid transition, busy, conflict), 413, 415, 429, 502/503/504 (DeepSeek), 500 (storage, no internals).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ask` | `{message, mode?}`: start a task or give input to the active one |
| GET / DELETE | `/api/history` | chat history + active task + tokens / clear the visible history |
| GET / POST / PUT / DELETE | `/api/profile` | view / create / update / delete the profile |
| POST | `/api/profile/clear` | empty all fields |
| GET / POST | `/api/invariants` | list (flat and grouped) / add |
| PUT / DELETE | `/api/invariants/:id` | edit, enable/disable / delete |
| POST | `/api/invariants/examples`, `/api/invariants/check` | add examples / dry-run the rule checker |
| GET | `/api/tasks`, `/api/tasks/active`, `/api/tasks/:id` | tasks (`:id` includes its work memory) |
| POST | `/api/tasks/:id/continue` | next state (validated) / retry |
| POST | `/api/tasks/:id/pause`, `/resume` | pause / resume |
| POST | `/api/tasks/:id/auto`, `/manual` | switch mode |
| POST | `/api/tasks/:id/resolve` | `{decision: keep \| disable \| updated \| cancel}` after a conflict |
| POST | `/api/tasks/:id/cancel`, `/activate` | cancel / make active |
| DELETE | `/api/tasks/active`, `/api/tasks/:id` | start a new task / delete a task |
| GET | `/api/memory` | all three layers separately, with token counts and storage |
| … | `/api/memory/short-term`, `/work`, `/long-term`, `/promote`, `/storage` | per-layer management, promotion, storage per layer |
| GET / POST | `/api/token-counts` | per-layer counts and the complete next request (`message`, `includeText`) |
| GET | `/api/health`, `/api/config` | liveness / non-secret server info |

## Testing

```bash
npm test
```

94 tests on Node's built-in runner; no API key or network needed (DeepSeek is replaced by a fake client or a mocked `fetch`):

- **State machine**: explicit states/table, valid transitions, invalid transitions (state preserved), attempts to skip a stage, rejected model proposals, pause/resume, pause during a step, auto mode, questions and conflicts keep the current state, validation retries, failure/retry, cancel, restart recovery.
- **Invariants**: CRUD and grouped storage; a valid response; violations of an architecture invariant, an adopted technical solution (incl. PostgreSQL → MongoDB), a stack limitation and a business rule; no false positives for questions and negations; model-reported conflicts.
- **Memory**: each layer in its own file; save/load; persistence after restart; independent storage configuration per layer; provider switching; corrupt files; explicit promotion only.
- **Profile**: create, edit, clear, delete; included in every request; rule parsing and response checks; automatic correction.
- **Tokens / context**: per-layer counts; the complete request count equals the count of the messages actually sent; every component present, in order; budget trimming.
- **Agent & API**: manual and auto flows, switching modes, conflicts and resolutions, reject-and-revise, API failures, persistence and recovery after restart, input validation, no leaked key or stack trace, config validation.

## Security

- The API key is only in `/etc/deepseek-app.env` (root, `0600`) or a local `.env` (git-ignored). The browser only talks to this server, never to DeepSeek. The key is in no response, page or log line (the logger redacts credential-like fields and values).
- All input is validated (types, lengths, enums, unknown fields, id formats). File access is limited to fixed names and validated ids inside `DATA_DIR`; paths are checked to stay inside it. Only `public/` is served.
- Cross-site state changes are refused (`Sec-Fetch-Site`/`Origin`, JSON bodies only); rate limit on endpoints that call DeepSeek; strict Content-Security-Policy (no inline script, nothing third-party); model output is rendered by an escaping Markdown renderer.
- Production responses never include stack traces or file paths.
- The service runs as `deepseek-app` with systemd hardening; the code is read-only and only `data/` is writable.
