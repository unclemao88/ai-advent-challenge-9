# DeepSeek Agent — day 10: context management

A local web chat agent for the DeepSeek API. Every question and answer is
stored on the server in one JSON file. There are three ways to decide what
DeepSeek sees on each request:

- **Sliding window**: only the latest N messages.
- **Sticky facts (key-value memory)**: structured facts pulled from older
  messages, plus the latest N messages.
- **Branching**: one checkpoint with two alternative branches of the
  conversation.

Node.js + Express on the backend and plain HTML/CSS/JavaScript in the browser.
There is no database, no build step and no frontend framework. Express is the
only dependency.

## 1. Requirements

- Node.js 10 or newer. It is tested on Node 10.13, and Debian 12/13's `nodejs`
  (18/20) works too.
- npm
- A DeepSeek API key

## 2. Installation

```bash
npm install
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY
npm start
```

Open <http://localhost:3000>.

## 3. Configuration

Settings come from environment variables. For local development they can also
go in `.env` in the project root. A variable that is already set in the real
environment wins over `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Required** to ask questions. Without it the UI loads and shows history, but `/api/ask` returns 503. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model that answers. |
| `DEEPSEEK_FACTS_MODEL` | `DEEPSEEK_MODEL` | Model that extracts sticky facts. |
| `DEEPSEEK_API_URL` | `https://api.deepseek.com` | Base URL, or the full `/chat/completions` URL. |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Hard limit for one DeepSeek call. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. There is no authentication, so keep it local. |
| `DATA_DIR` | `./data` | Directory that holds `state.json`. |
| `CONTEXT_LIMIT_TOKENS` | `64000` | Context window budget of the model. |
| `MAX_OUTPUT_TOKENS` | `4096` | Tokens reserved for the answer (`max_tokens`). |
| `MAX_QUESTION_CHARS` | `8000` | Longest accepted question. |

## 4. DeepSeek API key

1. Sign in at <https://platform.deepseek.com/>.
2. Open **API keys** and create a key.
3. Put it in `.env` as `DEEPSEEK_API_KEY=sk-...` (or export it in your shell).
4. Restart the server.

Only the Node.js process reads the key. It is sent only in the
`Authorization` header to DeepSeek. It is never logged, never written to
`state.json`, never included in an API response, and never sent to the
browser.

## 5. Starting

```bash
npm start           # production-style start
npm test            # automated tests (no network, no API key needed)
```

The startup log shows the model, the context budget and the state file:

```text
Agent: DeepSeek deepseek-chat (facts: deepseek-chat)
Context limit: 64000 tokens, output reserve 4096
State: /path/to/day10/data/state.json
Listening on http://127.0.0.1:3000
```

## 6. Architecture

```text
Browser (public/)  ──HTTP/JSON──►  Express (src/server)  ──►  DeepSeekAgent  ──HTTPS──►  DeepSeek
                                                               │
                                             ContextManager ◄──┤──► FactExtractor
                              SlidingWindow · StickyFacts · Branching
                                                               │
                                                          StateStore ──► data/state.json
```

```text
src/
  config.js                  environment → config (the only place env is read)
  server/server.js           routes, error → HTTP status mapping, security headers
  agent/
    deepseekAgent.js         the turn: facts catch-up → context → DeepSeek → store → facts update
    contextManager.js        decides what DeepSeek sees; applies mode/N/checkpoint changes
    slidingWindow.js         latest-N selection
    stickyFacts.js           facts per branch, coverage, JSON validation, applying updates
    factExtractor.js         DeepSeek JSON-mode calls that produce fact updates
    branching.js             checkpoint, branches, active path, delete/merge
    prompts.js               agent system prompt, fact-extraction prompt
    deepseekClient.js        HTTPS transport, timeout, error mapping, usage parsing
    errors.js                AgentError (message safe to show a user + HTTP status)
  storage/
    schema.js                state shape, defaults, validation/repair, statistics
    stateStore.js            locked read-modify-write of state.json
    jsonFile.js              atomic JSON write, safe read, quarantine
  shared/tokenService.js     token estimator shared by server and browser
  utils/                     mutex, .env loader
public/                      index.html, app.js, styles.css
test/                        dependency-free test runner and tests
deploy/                      systemd unit, sysusers config, nginx example
```

Where the responsibilities sit:

- **Routes** only validate the transport and call the agent.
- **DeepSeekAgent** runs the turn in order and holds a turn lock. A mode change
  or branch switch therefore cannot interleave with a request that is waiting
  on DeepSeek. Reads (`GET /api/state`) skip that lock, so reloading the page
  in the middle of a turn still works.
- **ContextManager** is the only code that decides what goes to the model.
- **StateStore** is the only code that touches the file.

### REST API

| Method & path | Body | Result |
|---|---|---|
| `GET /api/state` | — | Everything the page needs after a reload (below) |
| `POST /api/ask` | `{"question": "..."}` | `{request, response, turn, warnings, state}` |
| `POST /api/context` | `{"mode"?, "slidingWindow"?: {"N"}, "stickyFacts"?: {"N"}}` | `{changed, state}` |
| `POST /api/checkpoint` | — | `{checkpoint, state}` (Branching mode only) |
| `POST /api/branch/switch` | `{"branchId"?}` (omit for "the other branch") | `{branch, state}` |
| `POST /api/checkpoint/delete` | `{"branchId": "<branch to remove>"}` | `{deleted, state}` |
| `GET /api/health` | — | `{ok, agentConfigured, model}` |

Errors always come back as `{"error": "<user-readable sentence>"}` with the
status codes 400 (invalid input), 409 (not allowed in the current state), 413
(too long), 429, 502 (DeepSeek failed), 503 (no API key) and 504 (timeout).
Stack traces and upstream details go to the server log only.

`state` in these responses contains the visible messages, each marked with
`contextStatus` (`in`, `out`, `facts` or `trimmed`). It also has the mode and
its settings, the active branch's facts, the branch list, a `context` preview
of the next request (message ids and estimated tokens), `statistics`,
`lastTurn` and storage `notices`.

## 7. JSON storage format

All state lives in **one file**, `data/state.json`. A turn changes messages,
statistics and sometimes facts together. With one file and one atomic rename,
a crash cannot leave those parts out of step with each other.

```json
{
  "version": 1,
  "createdAt": "2026-09-13T18:40:00.000Z",
  "updatedAt": "2026-09-13T18:43:08.456Z",
  "settings": { "model": "deepseek-chat" },
  "contextManagement": {
    "mode": "sticky-facts",
    "slidingWindow": { "N": 10 },
    "stickyFacts": {
      "N": 5,
      "memories": {
        "main": {
          "facts": {
            "user_name": { "value": "John", "createdAt": "…", "updatedAt": "…" },
            "server_os": { "value": "Ubuntu 24.04", "createdAt": "…", "updatedAt": "…" }
          },
          "messagesCovered": 4,
          "coveredThroughId": "mu00hszz-aa80b5653743",
          "updatedAt": "…",
          "lastError": null
        }
      }
    },
    "branching": {
      "checkpoint": null,
      "activeBranchId": "main",
      "branches": [{ "id": "main", "name": "Main", "parentId": null, "createdAt": "…" }]
    }
  },
  "messages": [
    {
      "id": "mu00hrts-711db4e38efe",
      "timestamp": "2026-09-13T18:42:10.123Z",
      "type": "request",
      "branchId": "main",
      "content": "What is Docker?",
      "tokens": 5,
      "tokensSource": "estimate",
      "context": { "mode": "sticky-facts", "messageCount": 2, "excludedCount": 4, "trimmedCount": 0,
                   "factsCount": 4, "estimatedTokens": 402, "promptTokens": 357 }
    },
    {
      "id": "mu00hrtu-633cc9e4dbd2",
      "timestamp": "2026-09-13T18:42:13.456Z",
      "type": "response",
      "branchId": "main",
      "content": "Docker is…",
      "tokens": 124,
      "tokensSource": "api",
      "replyTo": "mu00hrts-711db4e38efe",
      "model": "deepseek-chat",
      "finishReason": "stop",
      "durationMs": 2980,
      "usage": { "promptTokens": 357, "completionTokens": 124, "totalTokens": 481, "reasoningTokens": null }
    }
  ],
  "quarantinedMessages": [],
  "statistics": {
    "messageCount": 2, "requestCount": 1, "responseCount": 1,
    "totalRequestTokens": 5, "totalResponseTokens": 124, "totalTokens": 129, "estimated": true,
    "api": { "calls": 2, "answerCalls": 1, "factExtractionCalls": 1,
             "promptTokens": 1200, "completionTokens": 150, "totalTokens": 1350, "estimated": false }
  },
  "lastTurn": { "requestTokens": 5, "responseTokens": 124, "contextTokens": 357, "contextTokensSource": "api", "…": "…" }
}
```

Safety rules:

- **Atomic writes.** The new content goes to `state.json.<pid>.<random>.tmp`,
  is `fsync`ed, then renamed over `state.json`. After a crash you have either
  the old file or the new one, never a partial write.
- **Serialized writes.** Every read-modify-write runs under one in-process
  lock, and every conversation-changing operation runs under a second "turn"
  lock. Concurrent requests queue instead of overwriting each other.
- **Validated reads.** Every load goes through `schema.normalizeState()`.
  - A file that is not JSON (or is empty) is renamed to
    `state.corrupt-<time>.json` and a new conversation starts. The UI shows a
    notice.
  - A file that is JSON but partly invalid (unknown mode, bad N, a broken
    checkpoint, messages from a branch that no longer exists) is repaired. The
    original is saved first as `state.pre-repair-<time>.json`, and unusable
    messages are moved to `quarantinedMessages` instead of being dropped.
- The file and data directory are created automatically. Files are written
  with mode 0600.

## 8. Context management

There is a strict difference between the **complete history** and the
**active model context**:

- **Complete history** is `state.messages`: every question and answer in every
  branch. Context management never deletes anything from it. Messages are
  removed only when you delete a branch.
- **Active path** is the conversation you see: base messages plus the active
  branch's messages.
- **Active model context** is what DeepSeek receives for the next request:
  system prompt, [facts], the mode's selection from the active path, and the
  current question.

In the UI, messages outside the active context stay visible but faded. Each
one has a badge (`in AI context`, `outside AI context`, `outside AI context ·
in facts`, `trimmed to fit context limit`). A divider marks where the active
context begins. The line under the mode selector shows "Visible history: X
messages · Active AI context: Y messages".

Each mode keeps its own settings (`slidingWindow.N` and `stickyFacts.N` are
stored separately). If you switch to another mode and back, you get the
previous configuration. The checkpoint and branches also survive a mode
switch. In the other modes the active branch still defines the conversation,
and the checkpoint can be managed again in Branching mode.

**Context limit.** Before each request the context is estimated. If it is over
`(CONTEXT_LIMIT_TOKENS − MAX_OUTPUT_TOKENS) × 0.85`, the oldest selected
history messages are dropped until it fits. The 15% headroom covers the
estimator's error. The system prompt, facts and question are never dropped. If
the question alone does not fit, the request fails with 413 and no DeepSeek
call is made.

## 9. Sliding window

The context is the latest **N** stored messages of the active conversation,
plus the new question. N counts stored messages (a question and its answer are
2) and does not include the question being asked.

```text
History 1 2 3 4 5 6 7 8 9 10, N = 4  →  model gets 7 8 9 10 + the new question
```

A change to N is saved immediately (debounced while typing) and applies to the
next request. The allowed range is 1–500.

## 10. Sticky facts

The context is **PERSISTENT FACTS** plus the latest **N** messages. The facts
sit in a delimited block in the system prompt:

```text
=== PERSISTENT FACTS ===
server_os = Ubuntu 24.04
user_name = John
=== END OF PERSISTENT FACTS ===

=== RECENT CONVERSATION === follows as chat messages.
```

How facts are maintained:

1. After each answer, messages that are now older than the latest N and not yet
   covered are sent to DeepSeek together with the current facts. The call uses
   JSON output mode (`response_format: json_object`) and asks for:

   ```json
   { "factsToSet": { "preferred_language": "Russian" }, "factsToRemove": [] }
   ```

   `factsToUpdate` is accepted too and is treated like `factsToSet`.
2. The response is **validated** before it touches state.
   - It must be a JSON object with those fields.
   - Keys are normalized to snake_case (`[a-z][a-z0-9_]{0,63}`).
   - Values must be scalars (a list of scalars is joined, `null` means remove)
     and are capped at 500 characters. At most 200 facts are kept.
   - Anything else is dropped. A response that is not such an object is
     rejected completely.
3. The update is applied: a newer value replaces the old one (`updatedAt`
   changes, `createdAt` stays), and removals delete keys. The prompt tells the
   model to reuse existing keys, so contradictions overwrite instead of
   piling up.
4. `messagesCovered` / `coveredThroughId` record how far the facts reach. A
   long backlog, for example switching to Sticky facts after 200 messages, is
   processed in batches of up to 30 messages / ~12k tokens before the next
   answer.

If extraction fails (invalid JSON, network error, cut-off output), the previous
facts are kept and the error is saved in `lastError` and shown in the UI. The
messages that are not yet covered are then **sent in full** in addition to the
latest N, so nothing silently drops out of context. The next turn retries.

Facts are stored **per branch**. When a checkpoint is created, both branches
get a copy of the base facts. When one branch is deleted, the survivor's facts
become the main facts. A fact learned in Branch A never appears in Branch B.

The **Sticky facts [show/hide]** panel lists the active branch's facts with
their update times, how many messages they cover, and the last extraction
error.

## 11. Branching and checkpoints

When **Branching** mode is selected, **Enable checkpoint** appears under the
ask button.

- **Enable checkpoint.** The current conversation becomes the shared base
  (`branchId: "main"`) and two branches are created, **Branch A** (active) and
  **Branch B**. Both start from the same conversation. Only one checkpoint can
  exist; a second attempt returns 409.
- **Asking.** New messages are written with the active branch's `branchId`.
  The context is base + active branch; the inactive branch is never shown or
  sent. In this mode the whole active path is sent, trimmed only by the context
  limit.
- **Switch to another branch.** The active branch changes, the chat reloads
  with that branch's messages, and the context preview updates. The choice is
  saved. The other branch is not touched.
- **Delete checkpoint.** A dialog asks **which branch to remove**, and
  **Delete selected branch** stays disabled until you choose one. The selected
  branch's messages are removed from `state.json`. The surviving branch's
  messages are relabelled `main`, so it becomes the normal conversation
  unchanged. The checkpoint is cleared and **Enable checkpoint** returns.

```text
Message 1 ─ Message 2 ─ Message 3 ─┬─ checkpoint
                                   ├─ Branch A: A4, A5   (active → sent to DeepSeek)
                                   └─ Branch B: B4, B5   (inactive → never sent)
```

A divider in the chat shows where the checkpoint is and which branch is active.

## 12. Token counting

There are two kinds of numbers, and they are labelled differently:

| Number | Source | Shown as |
|---|---|---|
| Response tokens (per answer) | DeepSeek `usage.completion_tokens`, minus `reasoning_tokens` for reasoning models | `124` |
| Context sent to model | DeepSeek `usage.prompt_tokens` (system prompt + facts + history + question) | `357` |
| Request tokens (per question) | **Estimate**: DeepSeek only reports tokens for the whole prompt, not for one message | `~5 (estimated)` |
| Next context (before sending) | **Estimate** of system prompt + facts + selected history + what you are typing | `~402 tokens` |
| Whole history | Sum of the stored `tokens` of every message in all branches (exact answers + estimated questions) | `~445 tokens` |
| API usage | Cumulative `usage` of every DeepSeek call, including fact extraction (in the Whole history tooltip) | — |

The header shows **Current request**, **Current response**, **Context sent to
model**, **Whole history** and **Next context**. Each message bubble shows its
own token count.

The estimator is `src/shared/tokenService.js`. The server and browser use the
same file, so the live count under the input box matches the stored one.
DeepSeek does not publish a JavaScript tokenizer, so it approximates BPE:

- CJK: about 1 token per character
- digits: 1 token per 3
- words: 1 token per ~5 characters
- punctuation: 1 token each
- a small per-message overhead

On English prose it lands within roughly ±15% of DeepSeek's counts. Every
estimated value is stored with `tokensSource: "estimate"`. If DeepSeek omits
`usage`, the answer is estimated too and marked the same way. No number is
invented without being marked.

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| Banner "DEEPSEEK_API_KEY is not set" / HTTP 503 | Put the key in `.env` or the environment and restart. |
| "DeepSeek rejected the API key" | The key is wrong or revoked; create a new one. |
| "The DeepSeek account is out of credit" | Top up the DeepSeek balance. |
| "DeepSeek did not answer within 60s" | Network or DeepSeek is slow; retry or raise `DEEPSEEK_TIMEOUT_MS`. |
| "Could not reach DeepSeek" | No outbound HTTPS/DNS from the server. |
| "The question is too long for the configured context limit" | Shorten the question or raise `CONTEXT_LIMIT_TOKENS`. |
| Notice "state.json is not valid JSON" | The file was damaged outside the app. It was kept as `state.corrupt-*.json` and a fresh conversation started. |
| "Sticky facts were not fully updated" warning | Fact extraction failed. The old facts were kept and older messages are sent in full; it retries on the next question. |
| `EADDRINUSE` | Another process uses the port; set `PORT`. |
| `npm install` fails with `EACCES` under `~/.npm` | Your npm cache has root-owned files: `sudo chown -R $(id -u):$(id -g) ~/.npm` (or `npm install --cache /tmp/npm-cache`). |
| Start from scratch | Stop the server and delete `data/state.json`. |

A failed request never stores a fake answer. The question is not saved, stays
in the input box, and the error is shown above it.

## Running on Debian with systemd

Files in `deploy/`:

- `deepseek-app-day10.service`: runs as `deepseek-app:deepseek-app` from
  `/opt/deepseek-app-day10` on port **3009**, with its environment in
  `/etc/deepseek-app.env`
- `deepseek-app.sysusers.conf`: the service account
- `nginx.conf`: an optional reverse proxy

### 1. Node.js

```bash
sudo apt update && sudo apt install -y nodejs npm
command -v node          # the unit expects /usr/bin/node
```

### 2. Service account

```bash
sudo cp deploy/deepseek-app.sysusers.conf /etc/sysusers.d/deepseek-app.conf
sudo systemd-sysusers
id deepseek-app          # must print a uid and gid, or the unit fails with 217/USER
```

### 3. Code (read-only for the service)

```bash
sudo mkdir -p /opt/deepseek-app-day10
sudo rsync -a --delete ./ /opt/deepseek-app-day10/ \
     --exclude .git --exclude node_modules --exclude .env --exclude 'data/*.json'
cd /opt/deepseek-app-day10 && sudo npm ci --omit=dev     # older npm: npm ci --production
sudo chown -R root:deepseek-app /opt/deepseek-app-day10
sudo chmod -R o-rwx /opt/deepseek-app-day10
```

### 4. API key

```bash
# Skip if /etc/deepseek-app.env already exists from an earlier day.
printf 'DEEPSEEK_API_KEY=sk-your-key\n' | sudo tee /etc/deepseek-app.env >/dev/null
sudo chown root:deepseek-app /etc/deepseek-app.env
sudo chmod 640 /etc/deepseek-app.env
```

Variables in this file override the unit's `Environment=` lines, and other
deepseek-app units share the file. Do **not** put `PORT` or `DATA_DIR` in it.

### 5. Enable

```bash
sudo cp deploy/deepseek-app-day10.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/deepseek-app-day10.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-app-day10
systemctl status deepseek-app-day10
curl -s http://127.0.0.1:3009/api/health
journalctl -u deepseek-app-day10 -f
```

### Notes on the unit

- **State lives outside `/opt`.** `StateDirectory=deepseek-app-day10` makes
  systemd create `/var/lib/deepseek-app-day10` (owner `deepseek-app`, mode
  0700). `DATA_DIR` points there. The directory stays writable under
  `ProtectSystem=strict` and survives redeploys. The code tree is
  `ReadOnlyPaths`.
- **Bound to `127.0.0.1:3009`.** Put `deploy/nginx.conf` in front, or set
  `HOST=0.0.0.0` in the env file to expose it directly. There is no
  authentication.
- **`AF_NETLINK`** is allowed because glibc's `getaddrinfo()` needs it to
  resolve `api.deepseek.com`.
- **`SystemCallErrorNumber=EPERM`** turns a syscall outside the filter into an
  error instead of a SIGSYS kill.
- **`UV_USE_IO_URING=0`** keeps libuv off io_uring, whose syscalls the filter
  blocks.
- **`MemoryDenyWriteExecute`** is deliberately not set, because V8's JIT needs
  it off.

To wipe the conversation on the server:

```bash
sudo systemctl stop deepseek-app-day10
sudo rm /var/lib/deepseek-app-day10/state.json
sudo systemctl start deepseek-app-day10
```

## Design decisions

- **One state file instead of `conversation.json` + `settings.json`.** A single
  atomic rename keeps messages, branches, facts and statistics consistent.
- **Failed requests are not stored.** The spec says never to store a fake
  response. Leaving the question out as well keeps the history as clean
  question/answer pairs, and the text stays in the input box for a retry.
- **The checkpoint needs Branching mode** for create/switch/delete. Once made,
  it also stays in effect in the other modes.
- **Facts are per branch**, so alternative branches cannot contaminate each
  other.
- **Answers are shown as plain text**, with ``` fences as code blocks, built
  only with `textContent`. Nothing the model or user writes is interpreted as
  HTML, and a strict Content-Security-Policy blocks inline scripts.

## Known limitations

- Per-question token counts are estimates (see §12).
- Sticky facts cost an extra DeepSeek call after each answer once messages
  leave the window, which adds latency before the answer is returned.
- One conversation, one process, no authentication, no streaming.
