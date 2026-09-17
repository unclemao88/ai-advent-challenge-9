# DeepSeek Agent with a User Profile and Three-Layer Memory

A web chat agent on the DeepSeek API. It keeps a **user profile** plus
**short-term**, **work** and **long-term** memory as separate layers, lets you
choose where each layer is stored, and shows how many tokens each layer takes
up and how big the complete context sent to DeepSeek is.

- Node.js + Express 5, plain HTML/CSS/JS in the browser, no build step
- One runtime dependency (`express`); tests use Node's built-in runner
- The API key stays on the server and never reaches the browser
- Every layer is a separate file; the profile goes into every request

---

## 1. What it does

Ask a question in the box at the bottom. The server loads your profile and all
three memory layers, assembles one context, counts its tokens, sends it to
DeepSeek, stores the answer, updates the memory layers the exchange touched,
and returns the answer with fresh token statistics.

| You see | Where it lives |
|---|---|
| The conversation, as `you asked` / `agent answered` bubbles | `data/conversations/` |
| The token cost of each memory layer and of the whole request | computed per request |
| **Profile** (next to `ask`) — style, format, limitations | `data/profile/` |
| **Memory & settings** — view, edit, clear and reconfigure every layer | `data/short-term/`, `data/work/`, `data/long-term/` |

## 2. Installation

Requires **Node.js 22 or newer** (developed on Node 24). Nothing else — no
database, no build tooling.

```bash
cd week2/day12
npm install
```

## 3. Configuration

Put your DeepSeek API key in a `.env` file in the project root:

```text
DEEPSEEK_API_KEY=sk-your-real-key
```

`.env` is git-ignored. `.env.example` lists every option:

| Variable              | Default                    | Purpose                                  |
|-----------------------|----------------------------|------------------------------------------|
| `DEEPSEEK_API_KEY`    | —                          | Required to get answers                  |
| `DEEPSEEK_API_URL`    | `https://api.deepseek.com` | Base URL or a full `/chat/completions` URL |
| `DEEPSEEK_MODEL`      | `deepseek-chat`            | Model id                                 |
| `DEEPSEEK_TIMEOUT_MS` | `60000`                    | Timeout for the whole DeepSeek call      |
| `PORT`                | `3000`                     | HTTP port                                |
| `HOST`                | `127.0.0.1`                | Bind address (loopback by default)       |
| `DATA_DIR`            | `./data`                   | Where the profile, memory and settings go |

Variables already set in the environment win over `.env`, which is what lets
systemd supply the key in production.

Get a key at <https://platform.deepseek.com>. If none is set the server still
starts: the UI loads and shows a banner explaining what is missing, and
questions fail with that message instead of an opaque error. The placeholder
`your_api_key_here` counts as missing.

## 4. Running

```bash
npm start           # http://127.0.0.1:3000
npm run dev         # restarts when anything in src/ changes
npm test            # 51 tests; DeepSeek is mocked, no key or network needed
```

---

## 5. The three memory layers

Each layer answers a different question, is stored in its own directory, and is
configured separately. The profile is a fourth store, and the conversation log
a fifth.

### Short-term memory — *what were we just saying?*

`data/short-term/conversation.json`

The recent conversation as `{ role, content }` messages, replayed to DeepSeek on
every request. It is a **window**: only the last *N* messages are kept, `N` is
set in the UI (default 20, range 2–500), and older messages fall out. If the
window would open on an answer whose question was dropped, that orphaned answer
goes too, so the model never sees a reply with no question.

### Work memory — *what are we working on?*

`data/work/current-task.json`

The current task: `task`, `currentState`, `requirements`, `constraints`,
`decisions`, `facts`, `variables`, `results`, `todos`. It is a summary, not a
second copy of the chat — only lines the user writes as task information land
here. Clear it when the task is done; the conversation and long-term memory are
untouched.

### Long-term memory — *what should outlive this task?*

`data/long-term/solutions.json`, `data/long-term/knowledge.json`

- **Solutions** — a problem and the answer that solved it. Solving the same
  problem again updates the entry instead of leaving two that disagree.
- **Knowledge** — a topic and a fact worth keeping.

Nothing lands here on its own: an entry is written only when you ask for it, or
when you add it in the memory editor.

The third part of long-term memory in the design — the **profile** — is a store
of its own, because you edit it directly and it is attached to every request.

### What writes to memory

The memory manager decides what to store; the rules are deterministic and
documented, so you always know why something was remembered. The UI reports
every update under the answer that caused it.

| You write (on its own line)                    | Goes to |
|------------------------------------------------|---------|
| `task: …`, `state: …`, `requirement: …`, `constraint: …` | work memory |
| `decision: …`, `we decided …`, `fact: …`, `variable: …`, `result: …`, `todo: …` | work memory |
| `remember: …`, `remember about <topic>: …`, `remember that …` | long-term knowledge |
| `solution: <problem> => <answer>`               | long-term solutions |
| `that worked` / `it fixed it` / `solved`        | files the previous exchange as a solution |
| `style: …`, `format: …`, `limitations: …`, `my name is …` | profile |
| anything else                                   | short-term memory and the conversation log only |

Only your own words are read. Nothing the model says is stored by a rule, so the
agent can never talk itself into remembering something.

`src/agent/memoryExtractor.js` is one function —
`({ userMessage, assistantMessage, previousExchange }) => { work, longTerm, profile }`
— so an LLM-based extractor can replace it later without touching the agent.

### Conversation history vs. short-term memory

These are different on purpose, and stored separately:

| | Short-term memory | Conversation log |
|---|---|---|
| Holds | the last *N* messages | everything (capped at 500 entries) |
| Sent to DeepSeek | yes | never |
| Used for | context | rebuilding the chat after a reload |
| File | `data/short-term/` | `data/conversations/` |

So you can set short-term memory to 4 messages to keep requests cheap and still
scroll back through the whole conversation. Each log entry stores an id, an ISO
timestamp, the date, the time, the type and the tag:

```json
{
  "id": "e5eba83d-…",
  "timestamp": "2026-09-16T09:15:00.000Z",
  "date": "2026-09-16",
  "time": "09:15:00",
  "type": "user",
  "tag": "you asked",
  "content": "…"
}
```

## 6. The profile

`data/profile/profile.json`

```json
{
  "name": "Max",
  "style": "direct, technical, no small talk",
  "format": "short paragraphs, code in fenced blocks",
  "limitations": "no emojis",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`style`, `format` and `limitations` are the three fields the design calls for;
`name` is optional and only used to address you.

Press **Profile** next to `ask`. A modal opens over the conversation — it never
navigates away — and lets you create, view, edit and save the profile, **clear
fields** (empties every field, keeps the record and its creation date) or
**delete** it (removes everything, after a confirmation). A saved profile is in
effect for the very next question; the token counters update as soon as you
save.

The profile is added to the system message **once per request**, never repeated
per turn, and an empty profile is left out entirely so it costs nothing. Because
it is part of every request, its storage can be a JSON file or process memory,
but it cannot be switched off.

## 7. Storage configuration

Open **Memory & settings**. Every layer offers:

| Mode | Behaviour |
|---|---|
| `json` | Saved on disk under `data/<layer>/`. Survives restarts. *(default)* |
| `memory` | Kept in the server process only; gone on restart. |
| `disabled` | Not stored and not sent to DeepSeek. Short-term, work and long-term only. |

Switching between two enabled modes carries the contents across, so changing
*where* memory lives never changes *what* the agent remembers. Switching to
`disabled` leaves any files on disk alone — switching back brings them back.

Settings live in `data/settings.json`, apart from the memory contents, so
clearing a layer never resets its settings and changing a setting never rewrites
memory files.

### Replacing the storage backend

Storage is behind one small interface, `src/memory/storage/StorageProvider.js`:

```js
class StorageProvider {
  get enabled() {}           // false → the layer is off entirely
  get persistent() {}        // true → survives a restart
  async read(documentName) {}
  async write(documentName, value) {}
}
```

A layer keeps a few named *documents* and never learns where they end up. To add
SQLite, Redis or an encrypted file: subclass `StorageProvider`, then add one
`registerStorageProvider()` call in `src/memory/storageManager.js`. The new mode
appears in the settings dropdown and in the validator automatically; no memory
layer, route or agent code changes.

Adding a whole new layer is one entry in `src/memory/layers.js`.

## 8. Token counting

`src/agent/tokenCounter.js` is the only module that knows anything about
tokenization, and every number it produces is an **estimate**.

DeepSeek's tokenizer is a byte-level BPE with a ~128k vocabulary, published as a
Hugging Face `tokenizer.json` plus Python code. There is no small,
dependency-free Node.js package for it, so this module approximates it:

- ~1 token per 4–5 letters of a word (one leading space folds into the word, as
  BPE merges `" word"` into one token)
- 1 token per CJK character, 1 per 3 digits, 1 per punctuation mark or emoji
- plus DeepSeek's chat-template markers: 1 for a user turn, 2 for an assistant
  turn, 2 for the request as a whole

That lands within roughly ±15% of the count DeepSeek reports. To swap in an
exact tokenizer, reimplement `countTextTokens` and set `TOKENIZER.exact = true`;
no caller changes. Counts are shown with a `~` while `exact` is false, and every
answer also carries DeepSeek's own exact `prompt_tokens` in the API response.

### What "current context" means

This is the number that matters, and it is **not** the length of what you typed.

The context builder returns the final message array *and* each section as its
own string. `currentContext` is counted on that final array — the same object
handed to `client.send()` on the next line — so it includes everything that goes
over the wire:

```text
system instructions
+ user profile
+ long-term memory (solutions, knowledge)
+ work memory
+ short-term conversation
+ your current question
+ the chat template's role markers
```

Each layer is counted on exactly the text that represents it. Whatever the total
has that the parts do not — section headers, role markers, request framing — is
reported as `framing`, so the breakdown always adds up to the total exactly.

As you type, the browser asks `POST /api/context/preview`, which runs the same
`agent.prepareRequest()` used by `POST /api/chat`. The number in the UI is
therefore derived from the same context representation as the payload and cannot
drift from it.

## 9. Architecture

```text
Browser (public/)
   │  fetch /api/… only — never DeepSeek, never a key
   ▼
Express app (src/app.js)
   │
   ├── routes/          chat · profile · memory · settings · status
   │
   ├── Agent (src/agent/agent.js)
   │     ├── contextBuilder.js   assembles the exact API payload
   │     ├── tokenCounter.js     counts it
   │     ├── memoryExtractor.js  decides what the exchange stores
   │     └── memoryManager.js    owns the layers
   │
   ├── api/deepseekClient.js     the only module that talks to DeepSeek
   │
   └── memory/
         ├── shortTermMemory.js · workMemory.js · longTermMemory.js
         ├── profile.js · conversationStore.js
         ├── memoryLayer.js      shared read-modify-write, serialised
         ├── layers.js           the registry of layers
         └── storage/            JSON file · in-memory · disabled
```

Files:

```text
week2/day12/
├── src/
│   ├── server.js                 process: env, port, signals
│   ├── app.js                    wiring, security headers, error handling
│   ├── config.js
│   ├── agent/
│   │   ├── agent.js              ask() and prepareRequest()
│   │   ├── contextBuilder.js
│   │   ├── memoryManager.js
│   │   ├── memoryExtractor.js
│   │   └── tokenCounter.js
│   ├── api/
│   │   └── deepseekClient.js
│   ├── memory/
│   │   ├── memoryLayer.js
│   │   ├── layers.js
│   │   ├── shortTermMemory.js
│   │   ├── workMemory.js
│   │   ├── longTermMemory.js
│   │   ├── profile.js
│   │   ├── conversationStore.js
│   │   ├── storageManager.js
│   │   └── storage/{StorageProvider,JsonFileStorage,InMemoryStorage,DisabledStorage}.js
│   ├── routes/{chat,profile,memory,settings,status}.js
│   ├── settings/settingsStore.js
│   └── utils/{jsonFile,httpError,serialQueue}.js
├── public/{index.html,styles.css,app.js}
├── test/                         51 tests
├── data/                         created on first start, git-ignored
│   ├── settings.json
│   ├── profile/profile.json
│   ├── short-term/conversation.json
│   ├── work/current-task.json
│   ├── long-term/{solutions,knowledge}.json
│   └── conversations/conversations.json
├── deploy/deepseek-app-day12.service
├── .env.example
├── package.json
└── README.md
```

### One request, step by step

1. `POST /api/chat` validates the question (non-empty, ≤ 8000 characters).
2. The question is appended to the conversation log immediately, so it survives
   even if the answer never arrives.
3. Profile, short-term, work and long-term memory are loaded in parallel.
4. `buildContext()` assembles the message array in a fixed order.
5. `measureContext()` counts that array.
6. `DeepSeekClient.send()` sends it.
7. On failure: the error is recorded in the log and thrown. **No memory layer
   has been touched** — a failed request can never leave half an exchange
   remembered.
8. On success: the answer is logged, then short-term memory gets the exchange
   and work, long-term and profile get whatever the extractor matched.
9. Memory is measured again, and the answer, the two stored entries, both token
   sets and the list of memory updates go back to the browser.

## 10. API

All responses are JSON. Errors are `{ "error": "…", "code": "…" }`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/chat` | `{ message }` → answer, stored entries, token statistics |
| `GET` | `/api/history` | the full conversation log (what a reload renders) |
| `POST` | `/api/context/preview` | `{ message }` → token counts for a draft, nothing sent |
| `GET` | `/api/profile` | the profile and its field definitions |
| `PUT` | `/api/profile` | create or edit it |
| `POST` | `/api/profile/clear` | empty every field, keep the record |
| `DELETE` | `/api/profile` | delete it completely |
| `GET` | `/api/memory` | every layer's storage, contents and token counts |
| `PUT` | `/api/memory/work` | replace work memory with an edited copy |
| `PUT` | `/api/memory/long-term` | replace solutions and knowledge |
| `POST` | `/api/memory/long-term/remove` | `{ category, id }` — delete one entry |
| `POST` | `/api/memory/clear` | `{ layer, confirm? }` — long-term needs `confirm: true` |
| `GET` `POST` | `/api/settings` | read and change storage settings |
| `GET` | `/api/status` | whether a key is configured, the model, the tokenizer |

`POST /api/chat` answers with:

```json
{
  "response": "…",
  "timestamp": "2026-09-16T09:15:03.000Z",
  "request": { "id": "…", "timestamp": "…", "date": "…", "time": "…",
               "type": "user", "tag": "you asked", "content": "…" },
  "reply":   { "…": "…", "tag": "agent answered" },
  "model": "deepseek-chat",
  "tokens": {
    "shortTerm": 114, "work": 45, "longTerm": 15, "profile": 24,
    "currentContext": 400,
    "breakdown": { "system": 182, "profile": 24, "longTerm": 15, "work": 45,
                   "shortTerm": 114, "request": 12, "framing": 8 },
    "estimated": true
  },
  "usage": { "promptTokens": 210, "completionTokens": 42, "totalTokens": 252 },
  "memoryUpdates": { "work": [], "longTerm": [], "profile": [] },
  "memoryTokens": { "…": "counts for memory after this exchange" }
}
```

`tokens` describes the request that was sent; `usage` is DeepSeek's own exact
count of the same request, so the estimate can always be checked against it.

## 11. Security

- **The API key never reaches the browser.** It is read from the environment,
  used for one `Authorization` header in `deepseekClient.js`, and is never
  logged, returned or rendered. The front end only ever calls this app's `/api`.
- Request bodies are capped at 128 kB; questions at 8000 characters.
- Every route validates its input and answers with a readable message and a
  stable `code`. Unexpected failures are logged in full server-side and reported
  to the browser as one plain sentence — no stack traces, paths or configuration.
- Chat, profile and memory text is rendered with `textContent` only. There is no
  `innerHTML` anywhere in `public/app.js`, so a message containing HTML is
  displayed, never executed.
- A strict `Content-Security-Policy` (`default-src 'self'`, no inline scripts),
  plus `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`.
- Only `public/` is served; `data/` and `src/` are not reachable over HTTP.
- Memory document names are validated against a strict pattern, and the JSON
  backend refuses any path that would resolve outside its own directory.
- Writes are atomic: each file is written to a temporary file and renamed over
  the target, so an interrupted write cannot corrupt memory. A file that is not
  valid JSON is moved aside (`.corrupt-<timestamp>`) rather than overwritten, and
  the layer starts empty instead of the server refusing to boot.
- The server binds to `127.0.0.1` by default. Put a reverse proxy with TLS in
  front of it to expose it; the memory files are personal data.

## 12. Deploying on Debian (systemd)

`deploy/deepseek-app-day12.service` runs the app as `deepseek-app` on port 3012.

```bash
# 1. Code
sudo mkdir -p /opt/deepseek-app-day12
sudo rsync -a --exclude node_modules --exclude data --exclude .env \
  ./ /opt/deepseek-app-day12/
cd /opt/deepseek-app-day12 && sudo npm ci --omit=dev

# 2. Service user (once for all days)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin deepseek-app
sudo chown -R root:root /opt/deepseek-app-day12

# 3. The key, shared by every day's service
sudo install -m 0640 -o root -g deepseek-app /dev/null /etc/deepseek-app.env
echo 'DEEPSEEK_API_KEY=sk-your-real-key' | sudo tee /etc/deepseek-app.env

# 4. Start
sudo cp deploy/deepseek-app-day12.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-app-day12
journalctl -u deepseek-app-day12 -f
```

Memory lives in `/var/lib/deepseek-app-day12`, which systemd creates (mode 0700,
owned by the service user) before every start and which is the only writable
path under `ProtectSystem=strict`. The unit is hardened:
`NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, an empty `CapabilityBoundingSet`
and a `@system-service` syscall filter.

Serve it behind nginx on 127.0.0.1:3012 with TLS.

## 13. Notes and limitations

- **Token counts are estimates.** See §8. DeepSeek's exact count for each
  request is in the response as `usage.promptTokens`.
- **Memory extraction is rule-based**, by design: predictable and inspectable.
  Free-form facts are not detected — write `remember: …` to save one. The
  extractor is a single function, ready to be replaced by an LLM-based one.
- **One conversation.** There is no thread list; clearing short-term memory
  starts a new conversation while the log keeps the history. Multiple
  conversations would be a new layer entry and a `conversationId` on each record.
- **One user.** There is no authentication, and the profile and memory are
  global to the server. Do not expose it to the internet without putting
  authentication in front of it.
- The conversation log keeps the last 500 entries; older ones fall off.
