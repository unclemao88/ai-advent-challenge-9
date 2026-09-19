# DeepSeek Agent · day 14

A stateful AI agent on top of the DeepSeek API, built with Node.js and Express, with a small browser UI.

- **Three independent memory layers**: short-term, work and long-term. Each has its own storage provider and file.
- **User profile** (style, format, limitations). It goes into **every** request sent to DeepSeek.
- **Invariants**: hard rules the agent must never break. They go into every request, and requests, plans and results are checked against them. When a request conflicts with one, the agent stops and asks whether the invariant itself should change.
- **Task state machine**: `idle → planning → execution → validation → done`, plus `waiting_for_user`, `paused` and `failed`. Every answer shows the current state, the next state and the planned action.
- **Manual / Auto** execution, with **pause and resume** at any state.
- **Token counts** for each memory layer and for the complete API context. The context count uses DeepSeek's own tokenizer on the exact messages that are sent. After each call, the usage DeepSeek reports is shown as the authoritative figure.
- Everything is stored in local JSON files and survives restarts.

It listens on port **3014** and runs as the `deepseek-app` user from `/opt/deepseek-app-day14` under systemd.

---

## Contents

1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Development](#development)
4. [Production](#production)
5. [Service commands](#service-commands)
6. [Access](#access)
7. [Using the agent](#using-the-agent)
8. [Architecture](#architecture)
9. [Data files](#data-files)
10. [REST API](#rest-api)
11. [Testing](#testing)
12. [Security](#security)
13. [Troubleshooting](#troubleshooting)

---

## Installation

Requirements: Debian 12 (or similar) with systemd, and **Node.js 20 or newer** (22 LTS recommended). Debian's own `nodejs` package is too old, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
```

Create the service user and the application directory:

```bash
sudo useradd --system --create-home deepseek-app
sudo mkdir -p /opt/deepseek-app-day14
sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day14
```

Then install from a checkout of this directory. The script does every step below:

```bash
cd week2/day14
sudo sh scripts/install-service.sh
```

The installer:

1. checks for root, systemd and Node.js ≥ 20;
2. creates the `deepseek-app` user if it does not exist yet;
3. copies the application to `/opt/deepseek-app-day14`. Code only: `data/` is never overwritten;
4. installs production dependencies (`npm ci --omit=dev`);
5. downloads DeepSeek's tokenizer (~8 MB, checksum-verified) for exact token counts. Skip this with `--skip-tokenizer`; counts are then labelled as estimates;
6. creates `data/` and every data file as valid empty JSON (only files that are missing). It also creates the shared configuration file `/etc/deepseek-app.env` (root-only, `0600`) if it does not exist. An existing file is never changed;
7. gives the application to `deepseek-app`: directory `0750`; `data/` and its files owner-only;
8. installs `/etc/systemd/system/deepseek-app-day14.service` (with the path of your `node` binary), runs `systemctl daemon-reload`, enables and starts the service, and checks `/api/health`.

The script is idempotent: run it again after `git pull` to update. Pass `--no-start` to install without starting.

Finally, set the API key in the shared configuration file and restart:

```bash
sudo nano /etc/deepseek-app.env                            # DEEPSEEK_API_KEY=sk-...
sudo systemctl restart deepseek-app-day14
```

### Manual installation (without the script)

```bash
sudo cp -r . /opt/deepseek-app-day14
cd /opt/deepseek-app-day14
sudo npm ci --omit=dev
sudo sh scripts/fetch-tokenizer.sh             # optional: exact token counts
sudo mkdir -p data
sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day14
sudo chmod 700 data
# Shared configuration (skip if it already exists from another day's service):
sudo install -m 600 -o root -g root /dev/null /etc/deepseek-app.env
sudo nano /etc/deepseek-app.env                # DEEPSEEK_API_KEY=..., DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
sudo cp systemd/deepseek-app-day14.service /etc/systemd/system/
# If `command -v node` is not /usr/bin/node, fix ExecStart= in the unit.
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-app-day14
```

The data files are created on first start if they are missing.

---

## Configuration

All configuration comes from environment variables; `.env.example` documents every variable.

- **Production (systemd).** The unit sets `PORT=3014`, `HOST=0.0.0.0`, `DATA_DIR=/opt/deepseek-app-day14/data` and `NODE_ENV=production` itself. It loads everything else from **`/etc/deepseek-app.env`** (`EnvironmentFile=`), mainly `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`. That file is shared by all `deepseek-app-dayNN` services, owned by root with mode `0600`; systemd reads it before dropping privileges. **Keep `PORT`, `HOST` and `DATA_DIR` out of it**: values from an `EnvironmentFile` override the unit's `Environment=` lines, so they would apply to every service. The installer warns if it finds them. In production, a `.env` in the code tree is ignored.
- **Local development.** The app reads `.env` from the project directory (dotenv). Variables already set in the shell take precedence. `.env` is excluded from git.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Required.** Only the server uses it. It is never sent to the browser and never logged. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL (or the full `/chat/completions` URL). `DEEPSEEK_API_URL` is accepted too. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` or `deepseek-reasoner`. |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Timeout for one API call, body included. |
| `DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_TEMPERATURE` | API defaults | Optional generation settings. |
| `HOST` / `PORT` | `0.0.0.0` / `3014` | Listen address. |
| `NODE_ENV` | `development` | `production` refuses to run as root. |
| `DATA_DIR` | `data` | Where every data file lives (relative to the app directory). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_DIR` | off | Also write rotated `app.log` files there (the journal always gets everything). |
| `STORAGE_SHORT_TERM`, `STORAGE_WORK`, `STORAGE_LONG_TERM` | `json` | Initial storage provider per memory layer: `json` or `memory`. Changeable later in the UI. |
| `SHORT_TERM_MAX_MESSAGES` | `30` | Messages kept in short-term memory. |
| `LONG_TERM_CONTEXT_TOKENS` | `2000` | Token budget for relevant long-term memory in one request. |
| `MAX_CONTEXT_TOKENS` | `100000` | Upper bound for a whole request. The oldest chat turns are dropped first. |
| `DEFAULT_MODE` | `manual` | Mode for new tasks until changed in the UI. |
| `MAX_AUTO_STEPS` | `8` | The most states one auto-mode run may execute. |
| `MAX_VALIDATION_RETRIES` | `2` | Failed validations before the task waits for the user. |
| `MAX_INVARIANT_REVISIONS` | `1` | Automatic revisions of a result that the invariant check rejected. |
| `APP_AUTH_TOKEN` | off | Optional shared secret. Every `/api` call then needs `Authorization: Bearer …`; the UI asks for it once. |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-client limit on endpoints that call DeepSeek. |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy. |
| `SHUTDOWN_TIMEOUT_MS` | `90000` | How long shutdown waits for running steps before it forces an exit. |

---

## Development

```bash
cd week2/day14
npm install
npm run fetch:tokenizer          # optional: exact token counts
cp .env.example .env             # set DEEPSEEK_API_KEY
npm run dev                      # restarts on changes in src/
# or: npm start
```

Open http://localhost:3014.

**Without spending API credit**, run the bundled DeepSeek mock:

```bash
npm run mock:deepseek                                          # terminal 1, port 3999
DEEPSEEK_API_KEY=mock DEEPSEEK_BASE_URL=http://127.0.0.1:3999 npm start   # terminal 2
```

You can steer the mock with words in your question: `ask me` makes planning ask a question; `fail validation` makes validation fail once; `python code` makes execution produce Python first (the invariant check rejects it and it is revised); `always python` keeps producing Python, which ends in a conflict; `model conflict` makes the model itself report a conflict with the first invariant.

> If your shell exports a real `DEEPSEEK_API_KEY`, it overrides `.env`. Use the mock command above for experiments.

---

## Production

The unit file is [`systemd/deepseek-app-day14.service`](systemd/deepseek-app-day14.service), installed as `/etc/systemd/system/deepseek-app-day14.service`:

```ini
[Service]
Type=simple
User=deepseek-app
Group=deepseek-app
WorkingDirectory=/opt/deepseek-app-day14
ExecStart=/usr/bin/node /opt/deepseek-app-day14/src/server.js
Environment=NODE_ENV=production
Environment=PORT=3014
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/opt/deepseek-app-day14/data
EnvironmentFile=/etc/deepseek-app.env      # shared: DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, …
Restart=always
RestartSec=5
# … plus hardening: ProtectSystem=strict, the code is read-only,
#   only data/ is writable, no capabilities, a syscall filter, UMask=0077
[Install]
WantedBy=multi-user.target
```

- The process runs as **`deepseek-app`**, never as root. With `NODE_ENV=production` the app refuses to start as root.
- It starts at boot (`WantedBy=multi-user.target`) and restarts 5 s after a crash (`Restart=always`).
- On `SIGTERM` it stops accepting connections, lets running agent steps finish writing their memory and task state, then exits.
- Logs are structured JSON lines in the journal: startup, request ids, task ids, state transitions, DeepSeek call duration and token usage, API and storage errors, invariant conflicts. Conversation text and the API key are never logged.
- If `node` lives somewhere other than `/usr/bin/node`, the installer fixes `ExecStart=` for you. When you install by hand, check it with `command -v node`.

This setup has been verified end to end in a Debian 12 container with systemd: the installer, `systemd-analyze verify` (no warnings), `systemd-analyze security` (exposure 1.5, "OK"), running as `deepseek-app`, persistence across `systemctl restart`, an automatic restart after `kill -9`, and a read-only code tree.

---

## Service commands

```bash
sudo systemctl enable deepseek-app-day14
sudo systemctl start deepseek-app-day14
sudo systemctl status deepseek-app-day14
sudo systemctl restart deepseek-app-day14
sudo journalctl -u deepseek-app-day14 -f
```

Also useful:

```bash
sudo systemctl stop deepseek-app-day14
curl http://127.0.0.1:3014/api/health
sudo journalctl -u deepseek-app-day14 -o cat | grep invariant.conflict    # structured log search
```

---

## Access

The application listens on:

```text
http://server-address:3014
```

Open the port if a firewall is active (e.g. `sudo ufw allow 3014/tcp`). There are no user accounts. On an untrusted network, set `APP_AUTH_TOKEN`, or bind to `HOST=127.0.0.1` and put a TLS reverse proxy in front (then set `TRUST_PROXY=true`).

---

## Using the agent

**The layout.** The chat scrolls on its own. The form at the bottom stays fixed: the text field (placeholder *ask your question, master*), **ask**, and **profile** next to it. The side panel (the **Status** button on narrow screens) shows the agent status, the memory token counts and the invariants.

**A task.** Each question starts a task (or, while a task is open, answers it):

| State | What happens |
|---|---|
| `idle` | Task created. The question starts planning immediately. |
| `planning` | DeepSeek writes a numbered plan. The plan is checked against the invariants. |
| `waiting_for_user` | The agent needs an answer, or an invariant conflict needs your decision. |
| `execution` | DeepSeek produces the result. A result that violates an invariant is rejected and revised. |
| `validation` | DeepSeek checks the result against the objective, the requirements and the invariants. The result is also re-checked by the rules. |
| `done` | Finished. The next question starts a new task. |
| `paused` | Stopped by you. **Resume** returns to exactly the saved state. |
| `failed` | An error (timeout, API error): **Retry** re-runs the same state. Or the task was cancelled. |

Every agent answer ends with a separate block: **Current state / Next state / Planned action**.

**Manual / Auto.** In *Manual* mode the agent runs one state and stops. **Continue** runs the next one. In *Auto* mode it runs through to `done`. It still stops for a question, an invariant conflict, too many failed validations, a pause, or an error. **Pause** works at any time; during a running step, the pause lands as soon as that step ends.

**Profile.** **profile** opens a modal where you can view, edit, save, clear or delete *style*, *format* and *limitations*. The next request uses the new values.

**Invariants.** **Invariants** (header) or **Manage** (side panel) opens the editor, where you can create, edit, enable/disable and delete rules. **Add examples** adds *Selected architecture*, *Programming stack (Node.js + Express)* and *Secrets handling*. Try asking *Rewrite backend in Python* after that:

```text
Conflict detected with invariant "Programming stack" — Node.js + Express
- The request uses Python, but the invariant requires Node.js / JavaScript …

Current state: planning
Next state: waiting_for_user
Planned action: Request permission to modify the invariant …
[Update invariant] [Disable invariant] [Keep invariant] [Cancel task]
```

*Keep* re-works the task within the invariant. *Disable* turns it off and goes on. *Update* opens the rule for editing; then choose *I edited it — continue*.

**Memory.** **Memory** opens the inspector, with a tab for each layer:
- *Short-term*: view messages, forget one, or clear the layer. The visible chat history stays.
- *Work*: view, add or delete items, and **promote** one to long-term memory.
- *Long-term*: view, add, pin or delete entries, and test which entries a question would retrieve.
- *Storage*: pick the provider per layer.
- *Tasks*: open or delete tasks.
- *API context*: the exact messages the next request would send, with tokens per section.

Explicit commands work in any question:

```text
remember: the server runs Debian 12              → long-term knowledge
remember solution: nginx terminates TLS on 443   → long-term solutions
requirement: must listen on port 3014            → work memory of the current task
decision: … / fact: …                            → work memory of the current task
```

The agent may *suggest* saving something to long-term memory. The suggestion shows as a **Save** button under its answer, and nothing is saved without your click.

---

## Architecture

```text
src/
├── server.js                  entry: .env, config, logger, tokenizer, HTTP server, graceful shutdown
├── config/index.js            every environment variable, with defaults
├── api/deepseek.js            DeepSeekClient: the only module that calls DeepSeek
├── agent/
│   ├── agent.js               Agent: the task lifecycle (ask, continue, pause, resume, resolve, …)
│   ├── stateMachine.js        pure state machine: states, transition table, pause/resume/fail/recover
│   ├── planner.js             planning step + request pre-check
│   ├── executor.js            execution step + reject/revise on invariant violations
│   ├── validator.js           validation step + re-check of the result
│   ├── stepRunner.js          shared: build context → call LLM → parse
│   ├── invariantChecker.js    InvariantChecker: check(), checkPlan(), checkResponse(), fromModel()
│   ├── contextBuilder.js      ContextBuilder: the single source of the API context and its token count
│   ├── prompts.js             system prompt and per-state instructions
│   └── responseParser.js      the model's JSON reply → a bounded, trusted structure
├── memory/
│   ├── memoryManager.js       MemoryManager: the three layers, storage switching, promotion
│   ├── shortTermMemory.js     current conversation
│   ├── workMemory.js          one document per task, with an update log
│   ├── longTermMemory.js      solutions + knowledge (profile joined in from ProfileManager)
│   ├── retrieval.js           KeywordRetriever: relevance selection (swap in a vector retriever later)
│   ├── memoryCommands.js      "remember:", "requirement:", … rules
│   └── storage/               StorageProvider, JSONFileStorage, InMemoryStorage, registry, storage config
├── profile/profileManager.js  the user profile
├── invariants/                InvariantManager (CRUD) and the technology catalogue used by the checker
├── tasks/taskManager.js       task persistence, per-task lock, restart recovery
├── conversation/              the complete chat log (conversation.json)
├── token/tokenCounter.js      DeepSeek tokenizer (exact) or a labelled estimate
├── http/                      Express app, middleware, one router per resource
└── utils/                     logger, atomic JSON files, validation, errors
public/                        index.html, app.js, styles.css, markdown.js (no framework, no CDN)
```

### Request lifecycle (`POST /api/ask`)

```text
validate input → load profile, invariants, short-term, work, relevant long-term memory
→ create/update the task → save the message (conversation + short-term) → apply memory commands
→ invariant pre-check of the request ──conflict──▶ waiting_for_user (no API call)
→ planning: ContextBuilder → token count → DeepSeek → parse → checkPlan + model-reported conflicts
→ execution: … → checkResponse (reject & revise, or conflict)
→ validation: … → verdict + re-check of the result
→ update the state machine → save the answer → update work memory → persist the task
→ return {task, response, messages, tokens}
```

In manual mode the chain stops after one state. In auto mode it continues while allowed.

### The API context

The `ContextBuilder` assembles, in this order:

```text
system:     [SYSTEM INSTRUCTIONS] [USER PROFILE] [AGENT INVARIANTS] [SHORT-TERM MEMORY] (note)
            [WORK MEMORY] [LONG-TERM MEMORY] (relevant entries only)
user/assistant …  short-term memory as chat turns
user:       [TASK STATE] (task id, mode, state, step instruction, notes) [CURRENT REQUEST]
```

The system prompt defines the agent's role and keeps four things apart: *profile = preferences*, *invariants = hard constraints*, *memory = what the agent knows*, *task state = what it is doing*. It also sets the rules for each state, the JSON reply format, and the memory update rules. The model answers in JSON: `response`, `nextState`, `plannedAction`, `needsUserInput`, `invariantConflicts`, `validation`, `workMemory`, `memoryProposals`. The state machine decides the transition; the model only suggests one.

### Token counting

- **Current API context** = `tokenCounter.countRequest(contextBuilder.build(...).messages)`. That is the same object that is sent, rendered with DeepSeek's chat template, special tokens included. It is never rebuilt separately, so the number cannot drift from the request.
- **Layers**: short-term memory as chat turns; work memory of the active task as formatted into the context; long-term memory as the profile plus every stored entry.
- **Exact vs estimated**: exact with DeepSeek's `tokenizer.json` (`npm run fetch:tokenizer`, the same tokenizer for `deepseek-chat` and `deepseek-reasoner`). Without it, a documented heuristic is used, typically within ±15%, and the UI labels it *estimated*.
- **Authoritative**: after each call, the `prompt_tokens` / `completion_tokens` DeepSeek reports are shown as "Last DeepSeek call", next to the count made before sending.

### Invariant enforcement

1. Every enabled invariant goes into every request (`[AGENT INVARIANTS]`), marked as a hard constraint.
2. **Rule check** (deterministic, no API call):
   - A technology catalogue reads what an invariant allows ("Node.js + Express") or forbids ("never MongoDB").
   - A request, plan or result that *adopts* another technology of the same kind conflicts. Adopting means a change verb or "in/with/using X", not negated, not a pure question. Frameworks count as their language (Django → Python), and code blocks count too (```` ```python ````).
   - Optional per-invariant **forbidden terms** cover business and security rules.
3. **Model check**: the model must report conflicts in `invariantConflicts`. The reports are validated against the active invariants.
4. When a conflict is found, the result depends on where:
   - the request → stop before calling DeepSeek;
   - the plan → stop;
   - the result → reject and revise automatically; if it still violates, stop;
   - validation → stop.

   "Stop" always means `waiting_for_user`, with the conflict, and a question: should the invariant change? The agent never changes or bypasses an invariant on its own.

### Storage providers

`StorageProvider` is a small key → JSON value interface: `get`, `set`, `delete`, `keys`, `getAll`, `replaceAll`. Each layer has its own instance:

- `JSONFileStorage` keeps one file per layer, writes atomically (temp file + fsync + rename) with a `.bak` copy, and moves a corrupt file aside instead of overwriting it.
- `InMemoryStorage` is volatile.

The provider per layer is stored in `data/storage-config.json` and can be switched in the UI. Switching copies the layer's data. To add SQLite, PostgreSQL or Redis, write a subclass and one `registerProvider()` call; the MemoryManager stays unchanged.

---

## Data files

All files live in `data/`. They are created on first start if missing and never overwritten. Every file is owner-only (`0600`).

| File | Content |
|---|---|
| `conversation.json` | Every question and answer: `id`, `role`, `tag` (`you asked` / `agent answered`), `content`, ISO-8601 `timestamp`, the task and state. Reloaded by the UI. |
| `short-term-memory.json` | `{ "messages": [...] }`: the recent conversation replayed to the model. |
| `work-memory.json` | `{ "task-…": { objective, plan, requirements, decisions, facts, intermediateResults, validationResults, variables, invariantChecks, log } }` |
| `long-term-memory.json` | `{ "solutions": [...], "knowledge": [...] }` |
| `profile.json` | `{ "profile": { style, format, limitations, createdAt, updatedAt } }` or `{ "profile": null }` |
| `invariants.json` | `{ "invariants": [ { id, name, value, category, enabled, forbidden } ] }` |
| `tasks.json` | `{ activeTaskId, defaultMode, tasks: [ { id, state, nextState, plannedAction, mode, status, … } ] }` |
| `storage-config.json` | Storage provider per memory layer. |

Back up by copying `data/`. Delete a file to reset that part only.

---

## REST API

All endpoints are JSON. Errors are `{ error, code, requestId }` with a fitting status: 400 invalid input, 404, 409 invalid state or conflict, 413, 415, 429 rate limit, 502/503/504 DeepSeek problems, 500 storage failure without internals.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ask` | `{message, mode?}`: start a task or answer the active one |
| GET / DELETE | `/api/conversation` | the chat log (+ active task, tokens) / clear the log |
| GET | `/api/memory` | all three layers, separately, with token counts and storage |
| GET / DELETE | `/api/memory/short-term` | short-term memory / clear it |
| DELETE | `/api/memory/short-term/:id` | forget one message |
| GET | `/api/memory/work` | work memory of every task (`?taskId=` for one) |
| POST / PUT / DELETE | `/api/memory/work/:taskId/items` | add / edit / remove an item |
| DELETE | `/api/memory/work/:taskId` | clear a task's work memory |
| GET | `/api/memory/long-term` | profile + solutions + knowledge (`?q=` shows the retrieval) |
| POST / PUT / DELETE | `/api/memory/long-term[/:id]` | add / edit / delete an entry |
| POST | `/api/memory/promote` | work memory item → long-term memory |
| GET / PUT | `/api/memory/storage` | storage provider per layer |
| GET / POST / PUT / DELETE | `/api/profile` | view / create / update / delete the profile |
| POST | `/api/profile/clear` | empty every field |
| GET / POST | `/api/invariants` | list / create |
| PUT / DELETE | `/api/invariants/:id` | edit, enable/disable / delete |
| POST | `/api/invariants/examples` | add the example invariants |
| POST | `/api/invariants/check` | dry-run the rule checker on a text |
| GET | `/api/tasks`, `/api/tasks/active`, `/api/tasks/:id` | tasks |
| POST | `/api/tasks/:id/continue` | run the next state / retry |
| POST | `/api/tasks/:id/pause`, `/resume` | pause / resume |
| POST | `/api/tasks/:id/mode` | `{mode: "manual" \| "auto"}` |
| POST | `/api/tasks/:id/resolve` | `{decision: "keep" \| "disable" \| "updated" \| "cancel"}` after a conflict |
| POST | `/api/tasks/:id/cancel`, `/activate` | cancel / make active |
| DELETE | `/api/tasks/active`, `/api/tasks/:id` | start a new task / delete a task |
| GET / POST | `/api/token-count` | token counts of all layers and of the next request (`message`, `includeText`) |
| GET | `/api/health`, `/api/config` | liveness / non-secret server info |

---

## Testing

```bash
npm test
```

There are 67 tests on Node's built-in runner. They need no API key and no network: DeepSeek is replaced by a fake client or a mocked `fetch`. They cover:

- **Memory**: save/load of each layer; the layers stay in separate files; storage switching; corrupt files; retrieval relevance; explicit promotion.
- **Profile**: create/update/clear/delete; the profile is present in *every* request; edits apply immediately.
- **Invariants**: CRUD, enable/disable, detection of conflicting actions (the spec's Python example, frameworks, databases, forbidden terms, code blocks), no false positives for questions and negations, model-reported conflicts.
- **State machine**: `idle→planning`, `planning→execution`, `execution→validation`, `validation→done`, `planning→waiting_for_user`, `execution→paused`, `paused→execution`, plus retries, failure, cancel, restart recovery and invalid transitions.
- **Tokens**: the context contains profile, invariants, every memory layer, task state and request, in order; the count is computed from the exact messages sent; old turns are trimmed first; exact vs estimated.
- **Agent and API**: manual and auto flows, the conflict stop without an API call, keep/disable/cancel, reject-and-revise, pause during a running step, restart survival, validation and status codes, no leaked key or stack trace, missing key, and the DeepSeek client's error handling (401/402/429/400/5xx, timeout, network, malformed JSON).

---

## Security

- The API key lives only in `/etc/deepseek-app.env` (root, `0600`); for local development, in `.env` (git-ignored). The browser only talks to this server, never to DeepSeek. The key is not in any response, page or log line; the logger redacts credential-like fields and values.
- All input is validated on the server: types, lengths, enums, unknown fields and id formats.
- Cross-site state changes are refused (`Sec-Fetch-Site`/`Origin` checks, JSON bodies only). A per-client rate limit applies to the calls that reach DeepSeek.
- There is no XSS path. The Content-Security-Policy allows no inline script and nothing from third parties. User text is inserted as text; model output goes through an escaping Markdown renderer that only allows http(s) links.
- File access is restricted to fixed file names inside `DATA_DIR`. Keys are validated, and paths are checked to stay inside the directory. Only `public/` is served statically.
- Production responses never include stack traces or file paths. Unexpected errors are logged in full and answered with one generic sentence plus a request id.
- The service runs as `deepseek-app` with systemd hardening. The code is read-only; only `data/` is writable.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner "DEEPSEEK_API_KEY is not configured" | Set it in `/etc/deepseek-app.env`, then `sudo systemctl restart deepseek-app-day14`. |
| Service fails with `Failed to load environment files` | `/etc/deepseek-app.env` is missing. Re-run the installer, or create it (see Installation). |
| The service listens on another port | `/etc/deepseek-app.env` sets `PORT` (or `HOST`/`DATA_DIR`) and overrides the unit. Remove those lines. |
| "DeepSeek API rejected the API key" | The key is wrong or revoked. |
| "insufficient balance" | Top up the DeepSeek account. |
| "did not answer within 60s" | Retry the step (**Retry**), or raise `DEEPSEEK_TIMEOUT_MS`. |
| Token counts say *estimated* | `sudo sh /opt/deepseek-app-day14/scripts/fetch-tokenizer.sh`, then restart. |
| `EADDRINUSE` in the journal | Another process uses port 3014 (`sudo ss -ltnp 'sport = :3014'`). |
| `EACCES` / storage error | `sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day14/data` |
| A data file was corrupted by hand | It has been moved aside as `*.corrupt-<time>` and an empty one is used. Fix and move it back. |
| `status=203/EXEC` | `ExecStart=` points to the wrong `node`. Re-run the installer, or fix the path. |
