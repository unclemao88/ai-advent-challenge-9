# DeepSeek Agent — day 13

A web chat agent on the DeepSeek API. Every question becomes a **task** that runs
through an explicit state machine (`planning → execution → validation → done`),
in **manual** mode (stop after each state) or **auto** mode (run straight through).
Tasks can be paused and resumed, and they survive browser reloads and server restarts.

The agent keeps three separate memory layers: short-term, work and long-term.
You choose where each layer is stored. A user profile (style, format and
limitations) is attached to every request. Token counts are exact, computed
with DeepSeek's own tokenizer, and cover the whole request.

| | |
|---|---|
| Application directory | `/opt/deepseek-app-day13` |
| Port | `3013` |
| System user | `deepseek-app` |
| systemd unit | `deepseek-app-day13` ([`systemd/deepseek-app-day13.service`](systemd/deepseek-app-day13.service)) |
| Data | `/opt/deepseek-app-day13/data` |
| Logs | journal + `/opt/deepseek-app-day13/logs/app.log` |
| Runtime | Node.js ≥ 20.12 (22 LTS recommended), one dependency besides Express (`@huggingface/tokenizers`, pure JS) |

---

## Contents

1. [Architecture](#architecture)
2. [Installation on Debian](#installation-on-debian)
3. [Configuration](#configuration)
4. [DeepSeek API](#deepseek-api)
5. [Running manually](#running-manually)
6. [systemd](#systemd)
7. [Logs](#logs)
8. [Using the agent](#using-the-agent)
9. [Memory and storage](#memory-and-storage)
10. [Token counting](#token-counting)
11. [REST API](#rest-api)
12. [Security](#security)
13. [Tests](#tests)
14. [Troubleshooting](#troubleshooting)

---

## Architecture

```text
/opt/deepseek-app-day13/
├── src/
│   ├── server/          index.js (startup, shutdown), app.js (assembly), middleware.js, routes/
│   ├── agent/           Agent (step runner), ContextBuilder, prompts, responseParser
│   ├── state-machine/   StateMachine — pure transition logic, no I/O
│   ├── tasks/           TaskManager — task persistence, active task, locks, restart recovery
│   ├── memory/          ShortTermMemory, WorkMemory, LongTermMemory, MemoryManager, memoryCommands
│   ├── storage/         StorageBackend contract, JsonFileBackend, MemoryBackend, registry, StorageConfigStore
│   ├── profile/         ProfileManager
│   ├── deepseek/        DeepSeekClient + provider factory
│   ├── tokens/          TokenCounter (DeepSeek tokenizer + chat template, or estimate)
│   ├── utils/           logger, atomic JSON files, validation, errors, serial queue
│   └── config.js        every environment variable, read in one place
├── public/              index.html, app.js, markdown.js, styles.css (no build step, no CDN)
├── data/                short-term/ work-memory/ long-term/ profiles/ tasks/ config/ backups/
├── logs/                app.log (+ rotated app.log.1 … .4)
├── vendor/deepseek-tokenizer/   tokenizer.json (downloaded, not committed)
├── scripts/             install.sh, fetch-tokenizer.sh, smoke-test.sh, mock-deepseek.js
├── systemd/             deepseek-app-day13.service
└── test/                node:test suites (no network)
```

How a request flows:

```text
browser ──POST /api/chat──▶ routes/chat ──▶ Agent.chat
                                              │ TaskManager: create or pick the task, lock it
                                              │ MemoryManager: save the question (short-term), apply memory commands
                                              │ StateMachine: enter the state to run
                                              ▼
                                  ContextBuilder.build  ◀── ProfileManager, long-term, work, short-term
                                              │  messages + exact token counts
                                              ▼
                                  DeepSeekClient.complete (JSON mode)
                                              │
                                  responseParser → work memory update → StateMachine.completeStep
                                              │  auto mode: advance and loop
                                              ▼
                       { response, messages, task, tokens, usage } ──▶ browser
```

The pieces are independent:

- The agent only needs an object with `complete(messages, { json })`. Adding another LLM provider means adding one case in `src/deepseek/index.js`.
- The memory layers only use the `StorageBackend` interface: `get`, `put`, `delete`, `list`, and optionally `search`.
- The state machine is pure functions over task objects.

---

## Installation on Debian

### Automated

```sh
# as root, from a checkout of this directory
sh scripts/install.sh            # add --no-start to install without starting
```

The script is idempotent: running it again updates the code and keeps `data/`,
`logs/` and `.env`. It performs every manual step below, rewrites `ExecStart`
if `node` is not at `/usr/bin/node`, and runs a health check at the end.

### Manual

**1. Node.js 20.12+ (22 LTS recommended).** Debian 12's own `nodejs` package (18.x) is too old; 20.12 is the floor because the app reads `.env` with `process.loadEnvFile()`. Install from NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node --version      # v20.12 or newer
which node          # /usr/bin/node (otherwise adjust ExecStart in the unit)
```

**2. System user.**

```sh
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home \
  --shell /usr/sbin/nologin deepseek-app
```

**3. Application directory.**

```sh
sudo mkdir -p /opt/deepseek-app-day13
sudo cp -a src public scripts systemd package.json package-lock.json README.md .env.example \
  /opt/deepseek-app-day13/
cd /opt/deepseek-app-day13
sudo npm ci --omit=dev                      # installs Node.js dependencies
sudo sh scripts/fetch-tokenizer.sh          # exact token counts (~8 MB, checksum-verified)
sudo mkdir -p data logs
sudo cp .env.example .env                   # then edit it, see Configuration
```

**4. Ownership and permissions.**

```sh
sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day13
sudo chmod 750 /opt/deepseek-app-day13
sudo chmod 700 /opt/deepseek-app-day13/data /opt/deepseek-app-day13/logs
sudo chmod 600 /opt/deepseek-app-day13/.env
```

The service user owns the tree, but the systemd unit mounts the code read-only.
The running process can write only to `data/` and `logs/`.

---

## Configuration

Configuration comes from environment variables. Sources, highest priority first:

1. `Environment=` lines in the systemd unit (`NODE_ENV`, `PORT`, `HOST`, `DATA_DIR`, `LOG_DIR`)
   and `EnvironmentFile=-/etc/deepseek-app.env`. The file overrides `Environment=`,
   so keep `PORT`, `HOST` and the directories out of it.
2. `/opt/deepseek-app-day13/.env`, which the application reads itself. A variable that is already set is never overridden.

Every variable, with its default:

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — (required) | DeepSeek API key. Server-side only. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` or `deepseek-reasoner` |
| `DEEPSEEK_API_URL` | `https://api.deepseek.com` | Base URL or full `/chat/completions` URL |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Timeout per DeepSeek call (1000–600000) |
| `DEEPSEEK_MAX_TOKENS` | API default | `max_tokens` per answer |
| `DEEPSEEK_TEMPERATURE` | API default | 0–2 |
| `PORT` | `3013` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address; `127.0.0.1` behind a reverse proxy |
| `NODE_ENV` | `development` | `production` under systemd |
| `DATA_DIR` | `./data` | Persistent storage |
| `LOG_DIR` | `./logs` | Log file directory; `off` = journal/stdout only |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `TOKENIZER_DIR` | `vendor/deepseek-tokenizer` | DeepSeek tokenizer files |
| `DEFAULT_MODE` | `manual` | Initial mode for new tasks (the UI changes it) |
| `MAX_AUTO_STEPS` | `8` | States one auto run may execute before stopping |
| `MAX_VALIDATION_RETRIES` | `2` | Failed validations before auto mode waits for the user |
| `SHORT_TERM_MAX_MESSAGES` | `40` | Initial short-term retention (the UI changes it) |
| `LONG_TERM_CONTEXT_TOKENS` | `4000` | Budget for long-term memory in one request |
| `MAX_CONTEXT_TOKENS` | `100000` | Request limit; the oldest chat turns are dropped beyond it |
| `APP_AUTH_TOKEN` | — | Optional access token for the API (see [Security](#security)) |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-client limit for endpoints that call DeepSeek |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `SHUTDOWN_TIMEOUT_MS` | `90000` | How long shutdown waits for running steps |

`.env` holds a secret: keep it at mode `600` and never commit it (`.gitignore` excludes it).

---

## DeepSeek API

1. Create a key at <https://platform.deepseek.com/api_keys>.
2. Put it in **one** of these places:
   ```sh
   # shared by all day apps (recommended)
   echo 'DEEPSEEK_API_KEY=sk-...' | sudo tee /etc/deepseek-app.env
   sudo chown root:deepseek-app /etc/deepseek-app.env && sudo chmod 640 /etc/deepseek-app.env
   # or only for this app
   sudoedit /opt/deepseek-app-day13/.env
   ```
3. Choose the model with `DEEPSEEK_MODEL`:
   - `deepseek-chat` (default): fast, non-thinking.
   - `deepseek-reasoner`: thinking mode. It is slower, and the token count ends the prompt with `<think>`.
4. Restart: `sudo systemctl restart deepseek-app-day13`.

The agent asks DeepSeek for JSON output (`response_format: json_object`). The
reply carries the answer, the suggested next state, the planned action, work-memory
updates and optional long-term memory suggestions. A reply that is not valid JSON
does not fail the step: its text is used as the answer, and the default transition applies.

Each state is one API call: a task costs three calls (planning, execution,
validation), plus one more execution/validation round per failed validation.
The `done` state makes no call.

Without a key the application still starts. The UI shows a banner, and
questions fail with a clear message; the question is still saved.

---

## Running manually

```sh
cd /opt/deepseek-app-day13
sudo -u deepseek-app node src/server/index.js       # production layout
```

For development on your own machine:

```sh
npm install
npm run fetch:tokenizer        # optional: exact token counts
cp .env.example .env           # set DEEPSEEK_API_KEY; for local use set
                               # DATA_DIR=./data and LOG_DIR=./logs
npm start                      # or: npm run dev  (restarts on changes)
open http://localhost:3013
```

To try the application without spending API credit, use the bundled mock:

```sh
npm run mock:deepseek &        # http://127.0.0.1:3999, answers in the agent's JSON format
DEEPSEEK_API_KEY=mock DEEPSEEK_API_URL=http://127.0.0.1:3999 npm start
```

A key already exported in your shell takes precedence over `.env`. Set
`DEEPSEEK_API_URL` as shown when you don't want real calls.

---

## systemd

```sh
sudo cp systemd/deepseek-app-day13.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable deepseek-app-day13
sudo systemctl start deepseek-app-day13
sudo systemctl status deepseek-app-day13
```

What the unit does:

- **User and paths.** Runs as `deepseek-app` in `/opt/deepseek-app-day13`, listening on port 3013.
- **Restarts.** `Restart=always` restarts the service 5 s after any exit (at most 10 restarts in 5 minutes). It starts on boot (`WantedBy=multi-user.target`).
- **Graceful stop.** On `SIGTERM` the app stops accepting connections and waits for running agent steps, so their memory and task writes complete. It then exits (`TimeoutStopSec=100`).
- **Hardening.** Uses `ProtectSystem=strict` and `ProtectHome`, with private `/tmp` and devices and no capabilities. System calls are filtered, and only `data/` and `logs/` are writable. `systemd-analyze security` rates it **1.5 (OK)**.
- **No `MemoryDenyWriteExecute`.** It would break V8's JIT.

Other commands:

```sh
sudo systemctl restart deepseek-app-day13
sudo systemctl stop deepseek-app-day13
sudo systemd-analyze verify /etc/systemd/system/deepseek-app-day13.service
sudo systemd-analyze security deepseek-app-day13
sh /opt/deepseek-app-day13/scripts/smoke-test.sh            # no DeepSeek call
sh /opt/deepseek-app-day13/scripts/smoke-test.sh --chat     # one real call
```

---

## Logs

Logs are structured JSON, one object per line, written to both the journal and `logs/app.log`:

```sh
journalctl -u deepseek-app-day13 -f                      # follow
journalctl -u deepseek-app-day13 -n 100 --no-pager
journalctl -u deepseek-app-day13 -p warning              # warnings and errors only
sudo tail -f /opt/deepseek-app-day13/logs/app.log
sudo jq -c 'select(.event=="task.transition")' /opt/deepseek-app-day13/logs/app.log
```

`app.log` rotates at 10 MB and keeps 5 files (`app.log.1` … `app.log.4`).

| Event | When |
|---|---|
| `app.starting`, `app.listening`, `app.shutdown_started`, `app.shutdown_complete` | lifecycle |
| `http.request` | every API call: method, path, status, duration (never bodies) |
| `task.created`, `task.transition`, `task.status`, `task.recovered_after_restart` | state machine |
| `agent.step.start`, `agent.step.reply`, `agent.step.failed` | each DeepSeek call: state, token counts, duration |
| `memory.*`, `profile.*` | memory and profile operations (ids and sizes, not contents) |
| `storage.failure`, `storage.corrupt_file_quarantined` | disk problems |
| `tokens.tokenizer_loaded` / `tokens.tokenizer_unavailable` | token counting method |

API keys, `Authorization` headers and anything that looks like `sk-…` are redacted
before writing. Conversation text is not logged; only message lengths are.

---

## Using the agent

**Layout.**

- **Top: the task panel.** It shows the task ID, current state, next state, planned action, status and execution mode. It also has the **continue**, **pause/resume** and **new task** controls, plus a progress stepper.
- **Below it: the token counters.** They show the short-term, work and long-term memory, and the **current request context**: the complete payload the next "ask" would send, updated as you type.
- **Middle: the chat.** It scrolls on its own. Bubbles are tagged `you asked` or `agent answered`, with date and time. Every agent bubble shows the task state it was given in.
- **Bottom: the form, always visible.** It has the input *ask your question, master*, the **Profile** button and **ask**.

**A task's life.**

- **Asking.** With no open task, a question starts a new task in **planning**.
- **Manual mode.** The agent stops after each state. Press **continue → execution**, then **continue → validation**, then **continue → done**.
- **Auto mode.** The agent runs through every state in one go. It stops early only if it needs your answer, if a validation fails more than `MAX_VALIDATION_RETRIES` times, if you pause, or if an error occurs.
- **Replying to a waiting task.** A new question re-runs the current state with your input; after validation it goes back to execution. Once a task is **done**, the next question starts a new task. **new task** does that at any time; old tasks stay under **Tasks**.
- **Pausing.** **pause** works at any time. While a step is running, the task pauses when that step ends. A paused task keeps its current state, next state, planned action, work memory and history, including across restarts. **resume** returns it to where it was; in auto mode it continues running.
- **Failures.** If DeepSeek fails (no key, timeout, network), your question stays saved and the task moves to `error`. **retry &lt;state&gt;** repeats the step.
- **Restarts.** A step interrupted by a restart is shown as waiting, and **continue** re-runs it.

**Profile.** Opens a dialog over the chat, where you can create, view, edit, save, clear or delete the profile. The Style, Format and Limitations fields take free text; the chips are only shortcuts. A saved profile applies to the very next request.

**Memory & tasks** (top right) opens these tabs:

- **Storage:** backend per layer, JSON-file options, short-term retention.
- **Short-term:** messages, with delete and clear.
- **Work:** edit or clear the active task's objective, plan, requirements, decisions, facts and variables. Results are listed read-only.
- **Long-term:** add, edit, move, delete, search and clear entries.
- **Tasks:** open or delete tasks.
- **Context:** the exact messages the next request would send, with a token breakdown.

---

## Memory and storage

| Layer | Contents | Stored in (JSON backend) | Sent to DeepSeek |
|---|---|---|---|
| Short-term | The current conversation (`role`, `content`, `timestamp`, task state) | `data/short-term/conversation.json` | As chat turns, oldest first |
| Work | Per task: objective, plan, requirements, decisions, facts, intermediate and validation results, variables | `data/work-memory/task-<id>.json` | `[WORK MEMORY]` of the active task |
| Long-term | Categories `profile`, `solutions`, `knowledge` | `data/long-term/<category>.json` | `[LONG-TERM MEMORY]`, within `LONG_TERM_CONTEXT_TOKENS` |
| Profile | Style, format, limitations | `data/profiles/user.json` | `[USER PROFILE]`, every request |
| Tasks | State, history, mode, status, work-memory reference | `data/tasks/task-<id>.json`, `session.json` | `[CURRENT REQUEST]` |
| Storage config | Backend per layer, retention | `data/config/storage.json` | — |

Every request is built in this order:

```text
system:  [SYSTEM INSTRUCTIONS] [USER PROFILE] [LONG-TERM MEMORY] [WORK MEMORY] [SHORT-TERM MEMORY]
turns:   short-term memory (user/assistant)
user:    [CURRENT REQUEST] task id, mode, state, step instruction, your message
```

An empty layer leaves its section empty.

**Writing to long-term memory.** The conversation is never copied into long-term memory. Entries get there only in these ways:

- through explicit lines in your message:
  - `remember: …` saves to knowledge;
  - `remember solution: …` saves to solutions;
  - `remember preference: …` saves to profile notes;
- when you save an entry in the memory panel;
- when you click **Save** on a suggestion the model attached to an answer. Suggestions that are already stored are not offered again.

Lines like `requirement: …`, `decision: …` or `fact: …` add to the current task's work memory.

**Where each layer is stored** is your choice in *Memory → Storage*:

- `json`: atomic files with fsync, and optionally the previous version kept as `.bak`.
- `memory`: volatile; nothing is written to disk.

Switching never deletes data:

- The layer's documents are copied into the new backend.
- Before anything is written into a JSON directory that already holds files, those files are copied to `data/backups/<layer>-<time>/`.
- The old files stay where they are.

To add SQLite, PostgreSQL or a vector database:

1. Subclass `StorageBackend`.
2. Optionally implement `search()`; long-term search then uses it.
3. Call `registerBackend()` in `src/storage/registry.js`.

The UI picks up the new backend automatically.

Corrupt JSON files are moved aside (`*.corrupt-<time>`) and the document reads as
empty, so a bad manual edit neither crashes the app nor gets overwritten.

**Backup** by copying `/opt/deepseek-app-day13/data`. It is safe while the service
runs because every write is an atomic rename.

---

## Token counting

**Exact counting.** With the tokenizer installed (`npm run fetch:tokenizer`), counts use **DeepSeek's own tokenizer**:

- The file is `tokenizer.json` from `deepseek-ai/DeepSeek-V3.2-Exp`, byte-identical to V3.1's. These are the models behind `deepseek-chat` and `deepseek-reasoner`.
- It runs in pure JavaScript and loads in about 0.1 s. With it loaded, the whole service used about 123 MB of memory in a Debian test.
- The complete request is first rendered with DeepSeek's chat template, so the count includes the begin-of-sentence, `<｜User｜>`, `<｜Assistant｜></think>` and end-of-sentence tokens.

**What the counters show.**

- *Short-term / Work / Long-term memory:* the stored contents of each layer.
- *Current request context:* the complete next request. That is the system instructions, profile, long-term memory, work memory, short-term turns and your current input, counted on exactly the messages that would be sent.
- *Last request sent:* our count for the previous call, next to DeepSeek's reported `prompt_tokens`.

**Known limits.**

- The count matches the prompt as the **published** chat template renders it. Anything DeepSeek's servers add on their side is invisible to the app. JSON output mode is one likely case (still unverified: every check here ran against the mock), so reported `prompt_tokens` may run a few tokens higher. Both numbers are shown.
- Without the tokenizer files, the app uses a character-based **estimate**, typically within ±15%. The UI labels it "≈ estimate" / "estimated token counts". It is never presented as exact.

---

## REST API

All endpoints take and return JSON. Errors look like `{ "error": "...", "code": "..." }`.
A failed agent step also returns `result`: the saved messages and the task in its error state.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | `{message, mode?}` → `{response, messages, task, tokens, usage, memoryUpdates}` |
| GET | `/api/chat/history` | Conversation, active task, token counts |
| DELETE | `/api/chat/history` | Clear the conversation |
| POST | `/api/context/preview` | `{message, includeText?}` → token counts (and messages) of the next request |
| GET / POST / PUT / PATCH / DELETE | `/api/profile` | View / create / save / edit / delete the profile |
| POST | `/api/profile/clear` | Empty every profile field |
| GET | `/api/memory` | Overview: storage, token counts, sizes |
| GET / PUT | `/api/memory/storage` | Storage configuration |
| GET / DELETE | `/api/memory/short-term` | Messages / clear |
| DELETE | `/api/memory/short-term/:messageId` | Delete one message |
| GET | `/api/memory/work` | Work memory of the active task |
| GET / PUT / DELETE | `/api/memory/work/:taskId` | View / replace / clear |
| GET | `/api/memory/long-term?q=&category=` | All entries, or a search |
| POST | `/api/memory/long-term` | `{category, content, tags?}` |
| PUT / DELETE | `/api/memory/long-term/:id` | Edit / delete an entry |
| DELETE | `/api/memory/long-term?category=` | Clear a category (or all) |
| GET | `/api/tasks` | All tasks, active task id, default mode |
| GET / DELETE | `/api/tasks/active` | Active task / detach it (next question starts a new task) |
| GET / DELETE | `/api/tasks/:id` | Task with history and work memory / delete |
| POST | `/api/tasks/:id/continue` | Run the next state, or retry a failed one |
| POST | `/api/tasks/:id/pause` · `/resume` | Pause / resume |
| POST | `/api/tasks/:id/auto` · `/manual` | Switch mode (also the default for new tasks) |
| POST | `/api/tasks/:id/activate` | Make it the active task |
| GET | `/api/config` | Model, tokenizer, storage, state machine, limits (no secrets) |
| GET | `/api/health` | Liveness (no authentication) |

Task shape in responses:

```json
{
  "id": "…", "currentState": "planning", "nextState": "execution",
  "plannedAction": "Execute the three-step plan.", "mode": "manual", "status": "waiting",
  "resumeState": null, "pauseRequested": false, "history": [{ "from": null, "to": "planning", "timestamp": "…", "reason": "task created" }]
}
```

**States:** `planning`, `execution`, `validation`, `done`, `paused`, `error`.

**Statuses:** `running`, `waiting`, `paused`, `completed`, `failed`.

**Allowed transitions:**

- `planning → execution`
- `execution → validation | planning`
- `validation → done | execution | planning`
- self-transitions (re-runs)
- any active state → `paused | error`
- `paused` / `error` → the state they came from

The model may suggest the next state. A suggestion that is not in the table is ignored.

---

## Security

- **API key.** It exists only on the server: read from the environment, sent only in the `Authorization` header to DeepSeek, never returned to the browser (`/api/config` only says whether one is configured) and redacted from logs.
- **Input validation.** Every input is validated for type, length, unknown fields and control characters. Invalid JSON gets a 400, bodies over 256 kB a 413, and non-JSON bodies a 415.
- **Path traversal.** Ids from requests are checked against strict patterns (UUID or `ltm_…`). Storage keys cannot contain separators or dots, and file backends verify that every resolved path stays inside their directory. Only `public/` is served as static files; `data/`, `logs/`, `src/` and dotfiles are not reachable.
- **Security headers.** Pages are served with a strict CSP (no inline script or style, no third-party origins) plus `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP and CORP. API responses are `no-store`. Model output is rendered through an escaping Markdown renderer.
- **Cross-site requests.** State-changing requests from other sites are rejected (checked via `Sec-Fetch-Site` and `Origin`).
- **Rate limiting.** Endpoints that call DeepSeek are limited per client (`RATE_LIMIT_PER_MINUTE`).
- **Concurrency.** A second operation on a busy task is refused with 409 rather than run in parallel.
- **Error responses.** Unexpected errors return a generic message; details go to the server log only.
- **Authentication.** The app is single-user. With `HOST=0.0.0.0` it is reachable on your network, so either
  - put it behind a reverse proxy with authentication and `HOST=127.0.0.1`, or
  - set `APP_AUTH_TOKEN`. Every API call then needs `Authorization: Bearer <token>`, and the page asks for it once.

  `authenticate()` in `src/server/middleware.js` is the hook for a real user system: it sets `req.user`, and the profile manager already takes a profile id.

---

## Tests

```sh
npm test
```

The suite uses `node:test` with 92 tests. It needs no network, API key or port 3013: DeepSeek is replaced by a fake client, and every test uses its own temporary data directory.

| File | Covers |
|---|---|
| `storage.test.js` | JSON backend: atomic writes, `.bak`, corrupt-file quarantine, key/path-traversal rejection, snapshots; memory backend; registry |
| `memory.test.js` | Short-term save/load/delete/clear/retention/token count; work memory create/merge/replace/clear/delete; long-term save/dedupe/update/move/search/delete/clear/budget; layer separation on disk; storage switching without data loss; restart; memory commands |
| `profile.test.js` | Create/view/edit/save/clear/delete, validation, free text, injection into every request (also right after an edit) |
| `stateMachine.test.js` | Valid and invalid transitions, pause/resume, pause while running, manual vs auto, validation retries, error and retry, restart recovery, completed tasks |
| `tokens.test.js` | Chat template, section order, empty profile, the current-request count includes system instructions, profile, long-term, work, short-term and request (estimate **and** exact tokenizer), known exact counts, fallbacks, context budget |
| `agent.test.js` | Manual and auto flows, failed validation loop, questions from the model, mode switching, pause mid-step and resume, API failures without data loss, malformed model output, context order, no implicit long-term writes, preview |
| `api.test.js` | Page and headers, static-file confinement, every endpoint, input validation, cross-site refusal, error hygiene, storage failures, auth token, rate limit, busy tasks |
| `deepseekClient.test.js` | Request format (JSON mode, auth), missing key, HTTP error mapping, invalid responses, timeouts, network errors, log redaction |
| `persistence.test.js` | Tasks, memory, profile and settings survive a restart; an interrupted step is recovered and retried; corrupt task files are ignored |

The tests for the exact tokenizer are skipped if `vendor/deepseek-tokenizer/` is empty.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Banner "DEEPSEEK_API_KEY is not configured" | Set the key (see [DeepSeek API](#deepseek-api)) and `systemctl restart deepseek-app-day13`. Check: `curl -s localhost:3013/api/config \| jq .llm` |
| "DeepSeek API rejected the API key" | The key is wrong or revoked. Replace it and restart. |
| "insufficient balance" | Top up the DeepSeek account. |
| "did not answer within 60s" | Network or DeepSeek is slow; retry, or raise `DEEPSEEK_TIMEOUT_MS`. The task is in `error`; press **retry**. |
| "Unable to connect to DeepSeek API" | Check outbound HTTPS: `sudo -u deepseek-app curl -sI https://api.deepseek.com`. Behind a proxy, set `HTTPS_PROXY` in the unit. |
| `Cannot find package 'express'` / `app.dependencies_missing` | Dependencies were never installed into the application directory. `cd /opt/deepseek-app-day13 && sudo npm ci --omit=dev && sudo chown -R deepseek-app:deepseek-app node_modules`, then restart. `npm ci` needs the npm registry; behind a proxy set `https_proxy` first. Copying the code without running it (or a `git clone` alone) leaves `node_modules` missing. |
| `EACCES: permission denied, mkdir '.../data/config'` / `app.init_failed` | `data/` and `logs/` belong to root, so the service user cannot write to them. This happens after a manual deployment. `cd /opt/deepseek-app-day13 && sudo chown -R deepseek-app:deepseek-app data logs vendor && sudo chmod 700 data logs`, then restart. |
| `Log file ... is not writable (EACCES)` | Same cause, log directory only. The service keeps running and logs to the journal. Same fix. |
| Service does not start, `status=203/EXEC` | Wrong node path in `ExecStart`. `which node`, fix the unit, `daemon-reload`. |
| `app.init_failed` / "Storage failure: not writable" | `sudo chown -R deepseek-app:deepseek-app /opt/deepseek-app-day13/data /opt/deepseek-app-day13/logs`. A different `DATA_DIR` must also be added to `ReadWritePaths=` in the unit. |
| `EADDRINUSE` in the journal | Port 3013 is taken: `sudo ss -ltnp \| grep 3013`. |
| Page not reachable from another machine | `HOST` must be `0.0.0.0`; open the firewall: `sudo ufw allow 3013/tcp` (or nftables). |
| Token counts say "estimated" | Tokenizer files missing: `sudo -u deepseek-app sh /opt/deepseek-app-day13/scripts/fetch-tokenizer.sh` (needs access to huggingface.co), then restart. |
| "The current task is paused" when asking | Press **resume**, or **new task** to start another one. |
| "The agent is still working on this task" (409) | A step is running (possibly from another tab). Wait, or pause it. |
| A task shows "interrupted by a server restart" | The server stopped mid-step. Press **continue** to re-run that step. |
| `429 Too many requests` | `RATE_LIMIT_PER_MINUTE` reached; wait or raise it. |
| Every API call returns 401 | `APP_AUTH_TOKEN` is set; enter it in the dialog (stored in the browser). |
| A memory file was edited by hand and is now empty | It was not valid JSON and was moved to `*.corrupt-<time>` next to it; fix and rename it back. |
| Old UI after an update | Assets are served `no-cache`; reload the page. |
| Service restarts in a loop | `journalctl -u deepseek-app-day13 -n 50`; `systemctl reset-failed deepseek-app-day13` after fixing. |
