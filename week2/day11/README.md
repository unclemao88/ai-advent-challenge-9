# DeepSeek Agent with Three-Layer Memory

A web chat agent on the DeepSeek API. It keeps **short-term**, **work** and
**long-term** memory as separate layers, lets you choose where each layer is
stored (JSON file, in-memory, or disabled), and shows how many tokens each layer
takes up and how big the full context sent to DeepSeek is.

- Node.js + Express 5, plain HTML/CSS/JS in the browser, no build step
- One runtime dependency (`express`); tests use Node's built-in runner
- The API key stays on the server

---

## Installation

Requires Node.js 22 or newer (developed on Node 24).

```bash
npm install
```

## Configuration

Set your DeepSeek API key in `.env` in the project root:

```text
DEEPSEEK_API_KEY=your_api_key_here
```

`.env` is git-ignored. `.env.example` lists every option:

| Variable              | Default                    | Purpose                                  |
|-----------------------|----------------------------|------------------------------------------|
| `DEEPSEEK_API_KEY`    | —                          | Required to get answers                  |
| `DEEPSEEK_API_URL`    | `https://api.deepseek.com` | Base URL or full `/chat/completions` URL |
| `DEEPSEEK_MODEL`      | `deepseek-chat`            | Model id                                 |
| `DEEPSEEK_TIMEOUT_MS` | `60000`                    | Timeout for the whole DeepSeek call      |
| `PORT`                | `3000`                     | HTTP port                                |
| `HOST`                | `127.0.0.1`                | Bind address (loopback by default)       |
| `DATA_DIR`            | `./data`                   | Where memory and settings are stored     |

Variables already set in the environment win over `.env`.

If no key is set, the server still starts. The UI shows a banner saying the key
is missing, and questions fail with that message instead of an obscure error.
The placeholder `your_api_key_here` counts as missing.

## Running

```bash
npm start
```

Then open <http://127.0.0.1:3000>.

## Development

```bash
npm run dev   # restarts when anything in src/ changes (node --watch)
npm test      # 63 tests; DeepSeek is mocked, no API key or network needed
```

---

## Architecture

```text
Browser (src/public)
   │  fetch /api/*            ← never talks to DeepSeek, never sees the key
   ▼
Express API (src/app.js, src/routes/*)
   │  validation, HTTP status codes, no agent logic
   ▼
Agent (src/agent/agent.js)
   ├── Memory manager ──────── Short-term memory ─┐
   │                           Work memory        ├─ StorageProvider
   │                           Long-term memory  ─┘   ├── JsonFileStorage
   │                                                  ├── InMemoryStorage
   │                                                  └── DisabledStorage
   ├── Memory extractor   (what an exchange adds to work/long-term memory)
   ├── Context builder    (the exact message array for DeepSeek)
   ├── Token counter      (estimates for layers and the full context)
   └── DeepSeek client    (HTTP, timeouts, error mapping)
```

What one question goes through (`Agent.ask`):

```text
validate → load all layers → build the final context → count its tokens
        → send to DeepSeek → (failure: stop here, no memory changed)
        → append question + answer to short-term memory
        → apply work-memory updates → apply long-term updates
        → return answer, sent-context counts, DeepSeek's usage, new memory counts
```

### Project layout

```text
src/
  server.js                 bootstrap: env, client, listen, graceful shutdown
  app.js                    wires settings → memory → agent → routes; error handler
  config.js                 environment → configuration
  agent/
    agent.js                request/response flow, measureContext()
    memoryManager.js        the three layers + switching their storage
    contextBuilder.js       system prompt + memory sections + conversation + request
    tokenCounter.js         token estimation (the only tokenizer-specific file)
    deepseekClient.js       the only module that talks to DeepSeek
    memoryExtractor.js      rules deciding what gets remembered
  memory/
    memoryLayer.js          shared layer behaviour: documents, locking, clear, switch
    shortTermMemory.js      conversation window
    workMemory.js           current task
    longTermMemory.js       profile, preferences, solutions, knowledge
    storageManager.js       registry of storage modes
    storage/                StorageProvider + JSON, in-memory, disabled
  settings/settingsStore.js data/settings.json, validation
  routes/                   chat.js, memory.js, settings.js, status.js
  utils/                    atomic JSON files, serial queue, HttpError
  public/                   index.html, app.js, styles.css
test/                       node:test suites
deploy/                     systemd unit
```

---

## Memory

| Layer          | Holds                                                                  | Stored as                         |
|----------------|------------------------------------------------------------------------|-----------------------------------|
| **Short-term** | The current conversation, oldest first, with ISO 8601 timestamps       | `data/short-term/conversation.json` |
| **Work**       | The current task: task, current state, requirements, constraints, decisions, intermediate results, TODOs, files/entities | `data/work/current-task.json` |
| **Long-term**  | Profile, preferences, solutions to earlier problems, knowledge         | `data/long-term/profile.json`, `preferences.json`, `solutions.json`, `knowledge.json` |

Settings are stored apart from all of these, in `data/settings.json`.

**Short-term memory** is a sliding window: it keeps the newest *Max messages*
(default 20, adjustable from 2 to 500 in the settings). When a new exchange
overflows it, the oldest messages are dropped. A window never starts with an
answer whose question was dropped. It is also what the chat shows after a page
reload: the browser rebuilds the conversation from `GET /api/history`, not from
localStorage.

**Work memory** can be cleared once a task is done, without touching the
conversation or long-term memory.

**Long-term memory** keeps each category in its own file and survives restarts.

### How things get into work and long-term memory

On purpose, extraction is simple and visible. The model's output is never saved
automatically. Rules are applied line by line to **your** message, and every
update is listed under the agent's answer (e.g. `saved to Work memory ·
decision: Use Express`).

| Write a line like                          | Saved to                                  |
|--------------------------------------------|-------------------------------------------|
| `task: Build a Node.js agent`              | work · task (replaces)                    |
| `state: …` / `status: …`                   | work · current state (replaces)           |
| `requirement: …` / `req: …`                | work · requirements                       |
| `constraint: …`                            | work · constraints                        |
| `decision: …` / `We decided to …`          | work · decisions                          |
| `result: …`                                | work · intermediate results               |
| `todo: …`                                  | work · TODOs                              |
| `file: …` / `entity: …`                    | work · files and entities                 |
| `my name is Max` / `call me Max`           | long-term · profile.name                  |
| `my role/job/location/city/country/time zone/preferred language is …`, `I live in …` | long-term · profile |
| `I prefer …` / `preference: …`             | long-term · preferences                   |
| `remember: …` / `remember that …` / `remember about Node.js: …` | long-term · knowledge |
| `solution: problem => solution`            | long-term · solutions                     |
| `that worked` / `solved` (right after an answer) | long-term · solutions (the previous question and answer) |

Duplicates are skipped. The agent calls `extractMemoryUpdates()` only through
its function signature, so a smarter extractor (for example a second LLM call
that proposes updates) can replace `memoryExtractor.js` without changing the
agent.

---

## Storage

Each layer's storage is chosen separately in **Memory settings**:

| Mode          | Behaviour                                                                          |
|---------------|------------------------------------------------------------------------------------|
| **JSON file** | Stored on disk in that layer's own directory. Survives restarts.                   |
| **In-memory** | Kept in the server process only. Gone after a restart.                             |
| **Disabled**  | Not read, not written, not sent to DeepSeek. The layer counts as 0 tokens.         |

Switching modes:

- **Between JSON and in-memory**, the current contents move along: changing
  where memory is kept does not change what the agent remembers. Going from
  in-memory back to JSON writes the contents to disk.
- **To disabled**, nothing is deleted. Files from an earlier JSON mode stay on
  disk untouched. Switching back to JSON loads them again.
- **From disabled to in-memory**, the layer starts empty.

Adding a backend means subclassing `StorageProvider` (`read`, `write`, plus
`enabled`/`persistent`) and calling `registerStorageProvider()` in
`storageManager.js`. The settings validation and the UI dropdown both read that
registry.

### Data safety

- **Atomic writes.** Each JSON write goes to a temporary file in the same
  directory and is then renamed over the target. A crash leaves the old file,
  never half a file.
- **No lost updates.** Every read-modify-write on a layer runs through that
  layer's serial queue, and writes to a given file are queued too. Two requests
  finishing together cannot drop each other's changes, and a question and its
  answer are always appended in one update.
- **Corrupt files are kept.** A file that is not valid JSON is renamed to
  `*.corrupt-<timestamp>` and logged, and that document starts empty. It is
  never silently overwritten.
- **Failed calls change nothing.** If DeepSeek fails, no memory is touched.

---

## Context construction

`contextBuilder.js` produces the message array that is sent:

```text
[system]    agent instructions
            ## LONG-TERM MEMORY   (omitted when empty or disabled)
            ## WORK MEMORY        (omitted when empty or disabled)
[user]      ┐
[assistant] ├ short-term memory: the conversation, oldest first
…           ┘
[user]      the current question
```

Memory is rendered as compact labelled lists rather than raw JSON, which uses
fewer tokens. It goes into the single system message, which every DeepSeek model
accepts. **Memory settings → "Exact context the next request will send"** shows
this array verbatim.

## Token counting

**All token counts in this app are estimates**, shown with `~` and labelled
*estimated* in the UI.

DeepSeek's tokenizer is a byte-level BPE published as a Hugging Face
`tokenizer.json` with Python tooling. There is no small, dependency-free Node.js
package for it. `tokenCounter.js` approximates it:

- Text, split into segments: about 1 token per 4–5 letters of a word, 1 per CJK
  character, 1 per 3 digits, 1 per punctuation mark or symbol. A single space
  merges into the next word; longer whitespace costs extra.
- Chat-template overhead, following DeepSeek's template
  (`<｜begin▁of▁sentence｜>`, `<｜User｜>`, `<｜Assistant｜>`,
  `<｜end▁of▁sentence｜>`): 0 for the system message, 1 per user turn, 2 per
  assistant turn, 2 for the request as a whole.

What is displayed:

| Label                       | Meaning                                                                |
|-----------------------------|------------------------------------------------------------------------|
| Short-term / Work / Long-term | Tokens of exactly the text that represents that layer in the request |
| **Current request context** | `tokens(final message array)`: system prompt, all memory, conversation, the question as typed, headers and template markers |
| Last request sent           | That estimate for the request that went out, **next to the exact `prompt_tokens` DeepSeek reported** |

The current request context is counted on the final message array, after it is
fully built. It is not counted on the question alone and not assembled from the
layer counts. The UI shows a breakdown (system, each layer, question, "headers
and chat markers"), and the parts always add up to the total. The three layer
counts on their own will not add up to the total.

While you type, the count comes from `POST /api/context/preview`. That endpoint
calls the same `Agent.prepareRequest()` that `POST /api/chat` uses, so the
preview is the real context.

The estimate is typically within about ±15% of DeepSeek's count. To switch to an
exact tokenizer, reimplement `countTextTokens()` in `tokenCounter.js` and set
`TOKENIZER.exact = true`; nothing else changes.

---

## API

| Method & path                | Body                                   | Returns                                                      |
|------------------------------|----------------------------------------|--------------------------------------------------------------|
| `POST /api/chat`             | `{ "message": "…" }`                   | `response`, `request`, `reply`, `tokenCounts` (sent context), `usage` (DeepSeek, exact), `memoryUpdates`, `memoryTokenCounts` |
| `GET /api/history`           | —                                      | Conversation from short-term memory                          |
| `POST /api/context/preview`  | `{ "message": "…", "includeMessages"?: true }` | Token counts for that draft (and the message array)  |
| `GET /api/memory`            | —                                      | Each layer's storage, contents, token counts; storage modes  |
| `POST /api/memory/clear`     | `{ "layer": "shortTerm"\|"work"\|"longTerm", "confirm"?: true }` | Updated overview. `longTerm` requires `confirm: true` |
| `GET /api/settings`          | —                                      | Settings and available storage modes                         |
| `POST /api/settings`         | `{ "memory": { "work": { "storage": "memory" } } }` (partial) | Saved settings and updated overview  |
| `GET /api/status`            | —                                      | Whether a key is configured (never the key), model, tokenizer |

Errors are JSON `{ "error": "<readable message>", "code": "<stable code>" }`.
DeepSeek failures map to: `missing_api_key` 503, `timeout` 504, `network` 502,
`auth` 502, `insufficient_balance` 502, `rate_limited` 429 (with `Retry-After`),
`bad_request` 502, `api_error` 502, `invalid_response` 502.

## Security

- The key is read from the environment and used only in the `Authorization`
  header. It is never logged, returned or sent to the browser; a test checks
  every endpoint's output for it.
- All chat and memory content is rendered with `textContent`, never `innerHTML`.
  Code fences are built from text nodes.
- A strict Content-Security-Policy (`default-src 'self'`, no inline scripts),
  plus `nosniff`, `no-referrer` and `frame-ancestors 'none'`.
- Input is validated: questions are 1–8000 characters, request bodies at most
  64 KB, and settings are checked against the storage-mode registry.
- No endpoint takes a path. Layer directories are fixed in code, document names
  must match `^[a-z0-9][a-z0-9-]*$`, and the JSON provider refuses any file
  outside its own directory. Only `src/public` is served statically.
- Binds to `127.0.0.1` by default.

---

## Deploying on Debian (systemd)

The unit `deploy/deepseek-app-day11.service` runs the app as user and group
`deepseek-app` from `/opt/deepseek-app-day11`. It listens on `127.0.0.1:3011`
and reads secrets from `/etc/deepseek-app.env`.

```bash
# 1. Node.js 22+ (Debian's own nodejs package is older; NodeSource is one option)
node --version && command -v node        # the unit expects /usr/bin/node

# 2. Service account
sudo useradd --system --user-group --home-dir /opt/deepseek-app-day11 \
  --no-create-home --shell /usr/sbin/nologin deepseek-app

# 3. Code: owned by root and read-only for the service; only data/ is writable
sudo mkdir -p /opt/deepseek-app-day11
sudo rsync -a --delete --exclude node_modules --exclude data --exclude .env ./ /opt/deepseek-app-day11/
cd /opt/deepseek-app-day11 && sudo npm ci --omit=dev
sudo chown -R root:deepseek-app /opt/deepseek-app-day11
sudo install -d -o deepseek-app -g deepseek-app -m 750 /opt/deepseek-app-day11/data

# 4. Secrets (systemd reads this file as root before dropping privileges)
sudo install -m 600 -o root -g root /dev/null /etc/deepseek-app.env
echo 'DEEPSEEK_API_KEY=sk-…' | sudo tee /etc/deepseek-app.env >/dev/null

# 5. Service
sudo cp deploy/deepseek-app-day11.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-app-day11
curl -s http://127.0.0.1:3011/api/status
journalctl -u deepseek-app-day11 -f
```

Notes:

- `PORT=3011` and `HOST=127.0.0.1` are set on the `ExecStart` line. In systemd,
  `EnvironmentFile=` values override `Environment=`, and a shared
  `/etc/deepseek-app.env` may set another `PORT`; setting them on the command
  line guarantees this instance's port.
- The unit uses `ProtectSystem=strict` with `ReadWritePaths` limited to
  `/opt/deepseek-app-day11/data`. That directory **must exist before the first
  start**, or systemd refuses to start the service.
- If `node` is not at `/usr/bin/node`, change `ExecStart`.
- To expose the app, put a reverse proxy (nginx, Caddy) in front of
  `127.0.0.1:3011` and add authentication. The app has no user accounts, and
  anyone who can reach it can read and clear its memory.

## Limitations

- **Token counts are estimates** (see above). DeepSeek's reported
  `prompt_tokens` is shown after every request for comparison.
- **Memory extraction is rule-based.** It only understands the line formats
  listed above, and the model cannot write to memory itself.
- **One shared memory.** There are no user accounts or sessions: everyone using
  one server shares the same memory.
- **No context budget.** The only cap is the short-term window. Very large
  long-term memory is sent in full, and DeepSeek will reject a request that
  exceeds the model's context length.
- **Answers are not streamed**, and markdown is shown as plain text, except
  fenced code blocks.
- **One process.** The locks are per process, so run a single instance per data
  directory.
