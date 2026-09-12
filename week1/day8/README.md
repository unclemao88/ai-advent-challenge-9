# DeepSeek Agent — persistent memory and token accounting

A small local web app: a dark chat UI in front of a Node/Express backend that
talks to the DeepSeek API. Every question and answer is written to a local JSON
file, and that file *is* the agent's memory — it is replayed as conversation
context on every new request, so the agent still knows what you told it after a
page reload, a browser restart, or a server restart.

Each message carries its own timestamp and token count, and the header shows the
running token total for the whole stored conversation.

## What it does

- Sends your question to DeepSeek through the backend; the browser never talks
  to DeepSeek and never sees the API key.
- Replays the stored conversation as context, so follow-up questions work:
  tell it *"My name is John."*, restart the server, ask *"What is my name?"*,
  and it answers *"Your name is John."*
- Persists every request and response to `data/history.json` and reloads them
  when the page opens.
- Shows chat bubbles with the tag, the text, a human-readable timestamp and a
  per-message token count.
- Counts the tokens of the question you are typing, live.
- Keeps the composer pinned at the bottom; only the message list scrolls.

## Architecture

```text
Browser (public/)
   │  POST /api/ask { question }
   ▼
Express server (src/server.js)          validates input, maps errors to statuses
   │
   ▼
DeepSeek agent (src/agent/deepseekAgent.js)
   │  buildConversationContext(history, question)
   │  → [system prompt, ...stored messages, new question]
   ▼
DeepSeek API  (chat/completions)
   │  answer + usage { prompt_tokens, completion_tokens, total_tokens }
   ▼
History storage (src/storage/historyStorage.js)
   │  queued, atomic append to data/history.json
   ▼
Browser          { request, response, historyTokenCount }
```

Responsibilities are split so each concern has exactly one home:

| Module | Owns |
| --- | --- |
| `src/server.js` | HTTP surface, input validation, error mapping, wiring |
| `src/agent/deepseekAgent.js` | *Everything* DeepSeek: endpoint, key, model, wire format, context building, timeouts, error translation |
| `src/storage/historyStorage.js` | The JSON file: schema, serialized writes, atomic replace, validation |
| `src/utils/tokenCounter.js` | Token estimation — shared by the server **and** the browser |
| `public/` | Rendering, live counters, scrolling, submit handling |

The frontend loads `src/utils/tokenCounter.js` from `/shared/tokenCounter.js`,
so the "Current request" figure you see while typing is produced by the exact
same code the server stores counts with. They cannot drift apart.

## Project structure

```text
day8/
├── package.json
├── .env                  # your key — git-ignored, never committed
├── .env.example
├── .gitignore
├── README.md
├── data/
│   └── history.json      # created automatically on first run
├── deploy/
│   └── deepseek-agent.service   # systemd unit for Debian
├── src/
│   ├── server.js
│   ├── agent/
│   │   └── deepseekAgent.js
│   ├── storage/
│   │   └── historyStorage.js
│   └── utils/
│       ├── tokenCounter.js
│       └── loadEnv.js
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Installation

Requires Node.js 10 or newer. Express is the only runtime dependency.

```bash
npm install
```

## Configuration

Copy the template and fill in your key:

```bash
cp .env.example .env
```

Then open `.env` and put your DeepSeek key on the `DEEPSEEK_API_KEY` line —
this is the only place the key belongs:

```text
DEEPSEEK_API_KEY=sk-your-real-key
DEEPSEEK_API_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
PORT=3000
```

Get a key at <https://platform.deepseek.com/api_keys>. `.env` is listed in
`.gitignore`; `.env.example` is the file that gets committed, and it contains no
secret. Environment variables that are already exported take precedence over the
file, so the same code runs unchanged where the environment is set another way.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Local-only by default. |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Hard limit on one API exchange. |
| `DEEPSEEK_HISTORY_LIMIT` | `0` (all) | Replay only the most recent N stored messages. |

`DEEPSEEK_API_URL` accepts either the base (`https://api.deepseek.com`) or the
full endpoint (`.../chat/completions`); both resolve to the same call.

## Running

```bash
npm start          # http://127.0.0.1:3000
npm run dev        # same, with nodemon reload
```

If the key is missing, the server still starts and still serves the stored
history — it just answers `POST /api/ask` with HTTP 503 and an explanation,
instead of failing obscurely on the first question.

## How persistence works

All messages live in `data/history.json`, created automatically on first start.

- **Loaded at startup.** A corrupt file is reported and the server exits rather
  than starting with a blank memory and overwriting your conversation.
- **Loaded by the browser** on every page load via `GET /api/history`, so a
  refresh restores the whole conversation.
- **Written atomically.** Each save writes a uniquely named `.tmp` file in the
  same directory and then renames it over `history.json`. Rename is atomic, so
  an interrupted write leaves the previous file intact — never a truncated one.
- **Written one at a time.** Every modification is queued behind the previous
  one, so simultaneous requests read-modify-write in sequence instead of racing.
  (Verified with eight concurrent requests: all sixteen messages stored, file
  still valid.)
- **Saved as a pair, after the call succeeds.** The question and the answer are
  appended in a single write once DeepSeek has replied. A failed call therefore
  never leaves a question stranded with no answer under it, and never fabricates
  a reply — the UI shows the error and keeps your text so you can retry.

The file holds personal conversation data, so `.gitignore` excludes it. Delete
it to start a fresh conversation; it will be recreated.

## History JSON format

```json
{
  "version": 1,
  "createdAt": "2026-09-12T12:00:00.000Z",
  "updatedAt": "2026-09-12T12:05:00.000Z",
  "messages": [
    {
      "id": "mtylukgu-dc06575f5ade",
      "type": "request",
      "tag": "you asked",
      "role": "user",
      "content": "What is Node.js?",
      "timestamp": "2026-09-12T12:00:00.000Z",
      "tokenCount": 6,
      "tokenSource": "estimate"
    },
    {
      "id": "mtylukgy-f74527a18386",
      "type": "response",
      "tag": "agent answered",
      "role": "assistant",
      "content": "Node.js is...",
      "timestamp": "2026-09-12T12:00:02.000Z",
      "tokenCount": 42,
      "tokenSource": "api"
    }
  ]
}
```

A user message is always `type: "request"` / `tag: "you asked"`; an agent message
is always `type: "response"` / `tag: "agent answered"`. Those fields, the id and
the timestamp are generated on the server — nothing from the request body is
trusted. `tokenSource` records where the count came from (see below).

Entries that are malformed (unknown role, missing content, hand-edited) are
skipped when reading rather than allowed to break the conversation; entries
missing optional fields are backfilled in memory.

## How history becomes AI context

`DeepSeekAgent.buildConversationContext(history, currentQuestion)` turns the
stored messages into the array DeepSeek expects:

```text
[ system prompt,
  { role: "user",      content: "My name is John." },
  { role: "assistant", content: "Nice to meet you, John." },
  ...
  { role: "user",      content: "What is my name?" } ]
```

This is the real request body, not a UI decoration — the model sees the whole
conversation on every call, which is why memory survives restarts. Messages with
an unusable role or empty content are filtered out before sending.

`selectHistory()` is the single point that decides how much of the past goes
out. Today it sends everything, or the last N messages if
`DEEPSEEK_HISTORY_LIMIT` is set. A maximum context size, a trimming rule, or a
summarise-the-old-turns step belongs there and nowhere else;
`estimateContextTokens()` already reports what the next request would cost, so a
budget has a number to work against.

## Token counting

Two numbers are shown, and they come from different places:

**Per message, in each bubble.**

- **Answers are exact.** DeepSeek returns a `usage` object with every reply; the
  server stores `completion_tokens` from it. These are marked `"api"` and shown
  plainly: `42 tokens`.
- **Questions are estimated.** Marked `"estimate"` and shown with a tilde:
  `~6 tokens`. Hover for the reason.

**In the header** — `History: 2,450 tokens` — the sum of every stored message's
count, recomputed by the backend after each exchange and returned with
`GET /api/history` and `POST /api/ask`. The backend is the authority; the
frontend only displays it.

**In the composer** — `Current request: 12 tokens` — the question you are
typing, counted locally as you type, using the same shared module.

### Are the counts exact?

**Partly, and the UI says which is which.** Counts from DeepSeek's `usage` field
are exact. Counts produced by `src/utils/tokenCounter.js` are an **estimate** —
DeepSeek does not publish a JavaScript tokenizer, and no npm package reproduces
its vocabulary, so nothing in this project can claim an exact local count.

The estimator approximates byte-pair encoding segment by segment: ~1 token per
CJK character, ~1 per 3 digits, ~1 per 5 characters of a Latin word (minimum
one), one per punctuation mark, with leading whitespace folded into the
following word. On ordinary prose it lands within roughly ±15% of a GPT-style
tokenizer. Good enough to budget context with; not a billing figure. Anything
estimated is prefixed with `~` in the interface.

## API endpoints

### `GET /api/history`

The full stored conversation, oldest first.

```json
{ "messages": [ ... ], "historyTokenCount": 0, "updatedAt": "2026-09-12T12:05:00.000Z" }
```

### `POST /api/ask`

```json
{ "question": "What is Node.js?" }
```

Validates the question, loads the history, calls the agent with it as context,
stores both messages, and returns them with the new total:

```json
{
  "request":  { "id": "abc", "type": "request",  "tag": "you asked",      "role": "user",      "content": "What is Node.js?", "timestamp": "...", "tokenCount": 6,  "tokenSource": "estimate" },
  "response": { "id": "def", "type": "response", "tag": "agent answered", "role": "assistant", "content": "Node.js is...",    "timestamp": "...", "tokenCount": 32, "tokenSource": "api" },
  "historyTokenCount": 38,
  "context": { "replayedMessages": 2, "promptTokens": 123, "totalTokens": 155, "model": "deepseek-chat" }
}
```

Status codes:

| Code | When |
| --- | --- |
| `200` | Answered and stored. |
| `400` | Empty question, or an unparseable JSON body. |
| `413` | Question longer than 8000 characters. |
| `429` | DeepSeek is rate limiting the key. |
| `500` | Unexpected server fault (details logged, not returned). |
| `502` | DeepSeek rejected the request, was unreachable, or replied with nonsense. |
| `503` | No `DEEPSEEK_API_KEY` configured. |
| `504` | DeepSeek did not answer within the timeout. |

Errors always come back as `{ "error": "one readable sentence" }`.

## Security considerations

- **The key stays on the server.** It is read from the environment into the
  agent at startup, used only as an `Authorization` header, and never logged,
  echoed in an error, or sent to the browser. The browser has no DeepSeek code
  in it at all.
- **No secrets in the repo.** `.env` and `.env.*` are git-ignored;
  `.env.example` holds placeholders only.
- **Input is validated.** Type-checked, trimmed, length-capped (8000 chars), and
  the JSON body is capped at 128 KB.
- **Stored fields are server-generated.** Role, type, tag, id and timestamp are
  never taken from the request body, so a client cannot forge an "agent
  answered" bubble.
- **No HTML injection.** All chat content is inserted with `textContent` and
  wrapped with `white-space: pre-wrap`; nothing in the UI uses `innerHTML`. A
  question containing `<script>` is displayed as text. (Verified.)
- **No stack traces in responses.** Unexpected failures are logged in full on
  the server and returned as one generic sentence.
- **Local by default.** The server binds `127.0.0.1`; override with `HOST` only
  if you understand the consequences — there is no authentication.

## Running as a systemd service (Debian)

`deploy/deepseek-agent.service` is a ready unit for Debian 11/12. It runs the app
as a dedicated system user, restarts it on failure, logs to the journal, and
confines it to a read-only filesystem apart from `data/`.

Install, as root:

```bash
# 1. A system user that owns nothing else and cannot log in
adduser --system --group --home /opt/deepseek-agent --no-create-home deepseek

# 2. The application
mkdir -p /opt/deepseek-agent
rsync -a --exclude node_modules --exclude .env --exclude data/history.json \
      ./ /opt/deepseek-agent/
cd /opt/deepseek-agent
npm ci --omit=dev            # or: npm install --production

# 3. The key, readable by the service user and nobody else
install -m 0640 -o root -g deepseek .env.example /opt/deepseek-agent/.env
editor /opt/deepseek-agent/.env      # set DEEPSEEK_API_KEY

# 4. The writable directory, and ownership
mkdir -p /opt/deepseek-agent/data
chown -R deepseek:deepseek /opt/deepseek-agent/data
chown -R root:root /opt/deepseek-agent/src /opt/deepseek-agent/public

# 5. The unit
cp deploy/deepseek-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deepseek-agent
```

Check it:

```bash
systemctl status deepseek-agent
journalctl -u deepseek-agent -f      # startup logs name the model and history file
curl -s localhost:3000/api/history
```

Before enabling, confirm the interpreter path matches your box — the unit uses
`/usr/bin/node`, which is correct for Debian's `nodejs` package on bullseye and
bookworm and for NodeSource builds, but Debian 10 and older may need
`/usr/bin/nodejs`:

```bash
command -v node
```

Notes on the unit:

- **The key is never in the unit file.** Files under `/etc/systemd` are
  world-readable; `EnvironmentFile=` points at `/opt/deepseek-agent/.env` with
  mode 0640 instead. Variables systemd sets take precedence over the `.env` the
  app reads itself, so there is one source of truth.
- **`ProtectSystem=strict`** makes everything read-only except the one
  `ReadWritePaths=/opt/deepseek-agent/data` entry, where `history.json` and its
  atomic temporary files live. `UMask=0077` keeps the conversation private.
- **`MemoryDenyWriteExecute` is deliberately absent** — V8's JIT needs W+X
  pages and Node will not start with it on. `ProcSubset=pid` is left off for a
  related reason, noted in the file.
- **Stopping is graceful.** The server closes connections on SIGTERM and the
  unit allows 20s for it, so a restart cannot interrupt a write to
  `history.json`.
- **Port and binding** come from `PORT` and `HOST` in the environment file. The
  app binds `127.0.0.1` by default; put nginx in front rather than binding the
  service to a public interface, since there is no authentication.
- On **Debian 10**, drop `ProtectHostname`, `ProtectClock` and `ProtectProc` —
  systemd 241 does not know them.

## Known limitations

- **Local token counts are estimates**, as described above. Only DeepSeek's
  reported answer counts are exact.
- **The whole conversation is replayed** on every request by default. A long
  history means a large prompt, and eventually the model's context limit. Set
  `DEEPSEEK_HISTORY_LIMIT` as a stop-gap; real trimming or summarising is the
  intended next step, and `selectHistory()` is where it goes.
- **One conversation, one file.** No sessions, no users, no per-thread history.
- **No authentication**, so do not expose the port beyond your machine.
- **No streaming.** The answer appears when it is complete; a "thinking"
  placeholder is shown meanwhile.
- **No editing or deleting** individual messages from the UI — clear the
  conversation by deleting `data/history.json`.
- **`prompt_tokens` is not attributed per message.** DeepSeek reports one prompt
  total for the whole replayed context, so it cannot be split across the stored
  questions; the per-question count stays an estimate.
- **Single process.** The write queue serializes writes within one server; two
  servers pointed at the same file would still be safe against corruption
  (atomic rename) but could overwrite each other's appends.
