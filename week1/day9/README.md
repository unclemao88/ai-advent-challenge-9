# DeepSeek Agent — day 9: summary + last-10 memory

A small local web app: a chat UI in front of a Node.js/Express backend that talks
to the DeepSeek API. The agent has a **two-level persistent memory**:

1. **Recent full history** — the last 10 individual messages, always sent to
   DeepSeek complete and verbatim.
2. **Historical summary** — everything older, compressed by DeepSeek into a
   memory record that is updated incrementally as messages leave the window.

Both live in local JSON files, so the conversation — and what the agent
remembers of it — survives a page reload, a browser restart and a server
restart. Token counts are shown for every message, for the memory, for the
current request and for the last API call, with estimates clearly labelled.

## Requirements

- Node.js 10 or newer (developed on 10, runs on Debian's 18/20)
- A DeepSeek API key — <https://platform.deepseek.com/api_keys>
- No database, no Docker

## Installation and start

```bash
npm install
cp .env.example .env      # then put your key on the DEEPSEEK_API_KEY line
npm start
```

Open <http://localhost:3000>.

```bash
npm test                  # 32 tests, no network, no extra dependencies
```

## Configuration

All configuration comes from environment variables. `.env` in the project root
is read for local development; variables already set in the real environment
(e.g. systemd's `EnvironmentFile`) take precedence. `.env` is git-ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Required for answers. Without it the UI and history still load; questions get HTTP 503. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model that answers questions. |
| `DEEPSEEK_SUMMARY_MODEL` | `DEEPSEEK_MODEL` | Model that writes the memory summary. |
| `DEEPSEEK_API_URL` | `https://api.deepseek.com` | Base URL or full `/chat/completions` endpoint. |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | Hard limit per DeepSeek call. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Local only by default — there is no authentication. |
| `DATA_DIR` | `./data` | Where `history.json` and `summary.json` live. |
| `MAX_QUESTION_CHARS` | `8000` | Longest accepted question. |

The API key is used only inside the backend as an `Authorization` header. It is
never sent to the browser, logged, or included in an error.

## How conversation memory works

```text
history.json   [ m1  m2  m3  m4  m5  m6  m7  m8  m9 m10 m11 m12 m13 m14 ]   every message, forever
                 └──── summary.json ────┘ └────────── last 10 ───────────┘
                   messagesCovered: 4       sent verbatim
```

**Invariant:** after every completed turn, `summary + last 10 messages` covers
the whole conversation. Nothing falls between the two.

A turn (`POST /api/ask`) runs in `DeepSeekAgent.ask()`:

1. **Validate and store the question** in `history.json` before anything else,
   so a failure later cannot lose it.
2. **Catch up the summary** if an earlier summary update failed (normally a
   no-op).
3. **Build the context:**

   ```text
   system:    SYSTEM INSTRUCTIONS
              [Historical Summary]   compressed memory of the N oldest messages
              [Last 10 Messages]     (explanation)
              [Current User Question]
   user:      message  ┐
   assistant: message  │ the last 10 messages before the question,
   ...                 │ as real chat turns, complete
   assistant: message  ┘
   user:      the current question — exactly once
   ```

4. **Call DeepSeek.**
5. **Store the answer** with DeepSeek's exact token count.
6. **Fold the messages that just left the window** into the summary.
7. **Return** the answer, the updated memory and token statistics.

"10 messages" means 10 individual messages (user or assistant), not 10 pairs.

Whole turns run one at a time (an in-process lock). Two browser tabs asking at
once get their question/answer pairs in order instead of interleaved. With more
than 4 turns waiting, new questions get HTTP 429.

The browser never builds prompts. It sends `{ "question": "..." }` and renders
the state the backend returns.

## How summarization works

Summarization is **incremental**:

```text
existing summary  +  messages leaving the 10-message window  =  new summary
```

`planSummary(total, messagesCovered, 10)` works out which messages to fold. With
one question and one answer per turn, that is the two oldest messages in the
window, once the history passes 10 messages. The summary replaces the previous
one in `summary.json`. The original messages stay in `history.json`: the summary
is a compressed view, not a deletion mechanism.

The summary prompt (`src/services/summaryService.js`) asks for **memory
optimized for an AI**, not a synopsis. It keeps the user's facts, requirements,
preferences, decisions, technical specifics (names, versions, ports, paths),
questions and their answers, and open questions, under fixed Markdown headings.
It merges with the existing record instead of appending. Transcript content is
treated as data, not as instructions.

Failure handling:

- **A summary update fails** (network error, output cut off at the length
  limit): the answer is still delivered and stored, and the old summary stays.
  The UI shows a warning and "N older messages not yet in the summary". On the
  next question the summary catches up first. If it fails again, the
  unsummarized messages are sent **verbatim** in an extra context section, so
  nothing is ever forgotten.
- **A large backlog** (for example after `summary.json` was deleted) is folded in
  bounded batches of at most 40 messages or about 16k tokens, each building on
  the previous one.
- **`summary.json` doesn't match `history.json`** (it records the id of the last
  message it covers): the summary is ignored and rebuilt from the original
  messages.

## How token counting works

All counting lives in `src/services/tokenService.js`. The browser loads the same
file from `/shared/tokenService.js`, so the live count under the input and the
stored count use identical code.

| Number | Source | Exact? |
| --- | --- | --- |
| Assistant message tokens | `usage.completion_tokens` from the answer call (minus `reasoning_tokens` for reasoning models) | **exact** |
| User message tokens | local estimator | estimated |
| Summary tokens | `usage.completion_tokens` from the call that wrote it | **exact** |
| Full history tokens | sum of the last 10 messages' stored counts | estimated if any question is among them |
| Total history tokens | summary + full history (the current request is not included) | estimated if either part is |
| Current request | the question text, local estimator | estimated |
| Last API call input / output / total | `usage.prompt_tokens` / `completion_tokens` / `total_tokens` | **exact** |
| Last summary update input / output / total | summed `usage` of the summarization call(s) | **exact** |

DeepSeek does not publish a JavaScript tokenizer, so local counts are an
**approximation of byte-pair encoding**, segment by segment:

- about 1 token per CJK character
- about 1 per 3 digits
- about 1 per 5 letters of a word (minimum 1)
- 1 per punctuation mark or symbol

On ordinary English prose this lands within roughly ±15% of DeepSeek's counts.
Estimated values are stored with `"tokensSource": "estimate"` and shown as
`~38 tokens (estimated)`; exact ones are shown plainly. If DeepSeek ever omits
`usage`, the backend falls back to the estimator and labels the numbers as
estimated.

"Last API call" input is the whole context: instructions, summary, recent
messages and the question. It is not the same as "current request", which is the
question alone.

## Where the data is stored

`DATA_DIR` (default `./data`), created automatically on first start:

`history.json`, every message, append-only:

```json
{
  "version": 1,
  "createdAt": "2026-09-13T16:00:00.000Z",
  "updatedAt": "2026-09-13T16:00:02.000Z",
  "messages": [
    { "id": "mtz1…", "timestamp": "2026-09-13T16:00:00.000Z", "role": "user",
      "tag": "you asked", "content": "What is Docker?", "tokens": 4, "tokensSource": "estimate" },
    { "id": "mtz2…", "timestamp": "2026-09-13T16:00:02.000Z", "role": "assistant",
      "tag": "agent answered", "content": "Docker is…", "tokens": 42, "tokensSource": "api",
      "usage": { "input": 1308, "output": 42, "total": 1350, "estimated": false, "model": "deepseek-chat" } }
  ]
}
```

`summary.json`:

```json
{
  "summary": "## User & preferences\n- User's project uses Node.js …",
  "tokens": 150,
  "tokensSource": "api",
  "updatedAt": "2026-09-13T16:00:00.000Z",
  "messagesCovered": 20,
  "coveredThroughId": "mtz…",
  "model": "deepseek-chat"
}
```

How the files are kept safe:

- **Atomic writes.** Each write goes to a unique temp file in the same
  directory, is `fsync`ed, then renamed over the target. An interrupted write
  leaves the old file, never a truncated one.
- **Serialized writes.** Every read-modify-write goes through one in-process
  lock, and the test suite checks 100 concurrent appends.
- **Corruption handling.** A file that is not valid JSON is renamed to
  `history.corrupt-<timestamp>.json` so nothing is destroyed, a new file is
  started, and the UI shows a notice. Empty files count as a new conversation.
  Entries the app cannot use are skipped but left untouched in the file.
- **Stored verbatim.** Messages are never rewritten.

The JSON files are git-ignored because they are personal data.

## Clearing history

Click **clear history** in the top bar, then **yes, clear**. This calls:

```bash
curl -X POST localhost:3000/api/history/clear -H 'Content-Type: application/json' -d '{"confirm": true}'
```

Without `"confirm": true` the endpoint refuses with 400. You can also stop the
server and delete `data/history.json` and `data/summary.json`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/history` | Summary, last 10 messages, token counts, last API call |
| `POST` | `/api/ask` | `{ "question": "..." }` → one conversation turn |
| `POST` | `/api/history/clear` | `{ "confirm": true }` → new empty conversation |
| `GET` | `/api/health` | `{ ok, agentConfigured, model, windowSize }` |

`POST /api/ask` response (abridged):

```json
{
  "answer": "Docker is…",
  "userMessage": { "id": "…", "role": "user", "tag": "you asked", "content": "What is Docker?", "tokens": 4, "tokensSource": "estimate" },
  "message": { "id": "…", "role": "assistant", "tag": "agent answered", "content": "Docker is…", "tokens": 42, "tokensSource": "api" },
  "summary": { "summary": "…", "tokens": 850, "tokensEstimated": false, "updatedAt": "…", "messagesCovered": 24 },
  "tokens": {
    "currentRequest": 4, "currentRequestEstimated": true,
    "input": 1308, "output": 42, "total": 1350, "apiEstimated": false,
    "summary": 850, "fullHistory": 420, "historyTotal": 1270,
    "summaryEstimated": false, "fullHistoryEstimated": true, "historyTotalEstimated": true,
    "summarization": { "input": 1500, "output": 850, "total": 2350, "calls": 1, "estimated": false }
  },
  "memory": { "summary": {}, "messages": [], "totalMessages": 26, "pendingSummary": 0, "tokens": {} },
  "context": { "model": "deepseek-chat", "summaryMessagesCovered": 22, "unsummarizedMessages": 0, "recentMessages": 10 },
  "warnings": []
}
```

Errors are `{ "error": "one readable sentence", "userMessage": …, "memory": … }`.
`userMessage` and `memory` are present when the question had already been
stored. Unexpected faults are logged in full on the server and returned as a
generic sentence.

| Status | When |
| --- | --- |
| 200 | Answered and stored |
| 400 | Empty question, missing field, invalid JSON, clear without confirmation |
| 413 | Question over `MAX_QUESTION_CHARS`, or body over 64 KB |
| 429 | DeepSeek rate limit, or too many questions queued |
| 500 | Unexpected server fault |
| 502 | DeepSeek rejected the request, was unreachable, or sent a malformed response |
| 503 | No `DEEPSEEK_API_KEY` configured |
| 504 | DeepSeek timed out |

**When DeepSeek fails**, the question stays in history and no assistant message
is created. The response carries the error status and the stored state, and the
UI marks the bubble "no answer — the request failed". On the next question,
DeepSeek receives both user messages merged into one turn (the chat API expects
alternating roles), with a note that the first got no answer. The stored files
are not changed by this.

## Web interface

- **Top bar:** model name and **clear history** (two-step confirmation).
- **Chat area:** the only part that scrolls, besides the token panel.
  - **Historical summary card** (dashed, amber): the summary rendered as
    Markdown, its token count and "Messages summarized: N". It is never mixed
    with chat bubbles.
  - **Recent full history:** chat bubbles with tag, date and time, text and
    token count. Your questions are on the right; agent answers are on the left
    and render as Markdown.
- **Token panel:** Memory (summary / recent / total), current request, last API
  call, last summary update. On screens under 900px it slides over from the
  **tokens** button.
- **Input form:** pinned to the bottom. Enter asks, Shift+Enter adds a new line.
  The button reads "asking..." and is disabled while a request runs. The page
  itself never scrolls.
- Light and dark themes follow the OS setting.

**XSS safety.**

- User text is inserted with `textContent` only.
- Answers and the summary are parsed by `marked` and sanitized by `DOMPurify`
  into a DOM fragment. Style attributes and form elements are removed, and links
  get `rel="noopener noreferrer"`.
- A strict Content-Security-Policy (`script-src 'self'`, no inline code,
  same-origin images only) is a second layer.

## Project architecture

```text
day9/
├── package.json           express, marked, dompurify
├── .env.example
├── src/
│   ├── config.js                  reads the environment (and .env), once
│   ├── server/server.js           HTTP routes, validation, error → status, security headers
│   ├── agent/
│   │   ├── deepseekAgent.js       the turn: store → context → DeepSeek → store → summarize
│   │   └── deepseekClient.js      DeepSeek HTTP transport, timeout, error mapping, usage parsing
│   ├── services/
│   │   ├── summaryService.js      summary prompt, incremental folding, planSummary()
│   │   └── tokenService.js        all token counting (shared with the browser)
│   ├── storage/
│   │   ├── historyStore.js        history.json + summary.json, lock, validation, corruption handling
│   │   └── jsonFile.js            atomic write, safe read, quarantine
│   ├── utils/                     mutex.js, loadEnv.js
│   └── public/                    index.html, app.js, styles.css
├── data/                          history.json, summary.json (created at runtime, git-ignored)
├── deploy/                        systemd unit, sysusers, nginx
└── test/                          dependency-free test suite (npm test)
```

| Module | Knows about | Does not know about |
| --- | --- | --- |
| `server.js` | HTTP, status codes | prompts, files, DeepSeek |
| `deepseekAgent.js` | turn order, context layout, memory invariant | HTTP, file format |
| `deepseekClient.js` | DeepSeek wire format, key, timeout | memory |
| `summaryService.js` | how to compress memory | storage, HTTP |
| `historyStore.js` | JSON files, locking, atomicity | DeepSeek |
| `tokenService.js` | counting | everything else |
| `public/app.js` | rendering the backend's state | prompts, DeepSeek, the key |

## Running on Debian with systemd

Files in `deploy/`:

- `deepseek-app-day9.service`: runs as `deepseek-app:deepseek-app` from
  `/opt/deepseek-app-day9`, on port 3008, with its environment in
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
sudo mkdir -p /opt/deepseek-app-day9
sudo rsync -a --delete ./ /opt/deepseek-app-day9/ \
     --exclude .git --exclude node_modules --exclude .env --exclude 'data/*.json'
cd /opt/deepseek-app-day9 && sudo npm ci --omit=dev     # older npm: npm ci --production
sudo chown -R root:deepseek-app /opt/deepseek-app-day9
sudo chmod -R o-rwx /opt/deepseek-app-day9
```

### 4. API key

```bash
printf 'DEEPSEEK_API_KEY=sk-your-key\n' | sudo tee /etc/deepseek-app.env >/dev/null
sudo chown root:deepseek-app /etc/deepseek-app.env
sudo chmod 640 /etc/deepseek-app.env
```

Variables in this file override the unit's `Environment=` lines, so leave
`PORT` and `DATA_DIR` out of it unless you mean to change them. Add
`HOST=0.0.0.0` only if you want port 3008 reachable without nginx, and note
there is no authentication.

### 5. Enable

```bash
sudo cp deploy/deepseek-app-day9.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/deepseek-app-day9.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-app-day9
systemctl status deepseek-app-day9
curl -s http://127.0.0.1:3008/api/health
journalctl -u deepseek-app-day9 -f
```

The startup log names the model and the memory files:

```text
Agent: DeepSeek deepseek-chat (summaries: deepseek-chat)
Memory: /var/lib/deepseek-app-day9/history.json, /var/lib/deepseek-app-day9/summary.json
Listening on http://127.0.0.1:3008
```

### Notes on the unit

- **Memory lives outside `/opt`.** `StateDirectory=deepseek-app-day9` makes
  systemd create `/var/lib/deepseek-app-day9`, owned by the service account with
  mode 0700. It stays writable under `ProtectSystem=strict`, and a redeploy of
  `/opt/deepseek-app-day9` leaves the conversation alone. `UMask=0077` keeps the
  files private.
- **`AF_NETLINK`** is in `RestrictAddressFamilies` because glibc's
  `getaddrinfo()` needs it to resolve `api.deepseek.com`.
- **`SystemCallErrorNumber=EPERM`** turns a syscall outside `@system-service`
  into an error instead of a SIGSYS kill.
- **`UV_USE_IO_URING=0`** stops libuv from using io_uring, whose syscalls that
  filter excludes.
- **`MemoryDenyWriteExecute`** is deliberately absent: V8's JIT needs W+X
  memory.
- **nginx:** edit `server_name` in `deploy/nginx.conf`, then link it into
  `sites-enabled`. Its read timeout (200s) allows for a turn that makes three
  DeepSeek calls.

To wipe the conversation on the server:

```bash
sudo systemctl stop deepseek-app-day9
sudo rm /var/lib/deepseek-app-day9/{history,summary}.json
sudo systemctl start deepseek-app-day9
```

## Known limitations

- Local token counts are estimates (see above); DeepSeek's `usage` numbers are
  exact.
- Summarizing costs an extra DeepSeek call on each turn once the history passes
  10 messages, and adds its latency before the response returns.
- The summary is lossy by nature. The prompt aims to keep specifics, but a
  detail DeepSeek judges unimportant can be dropped. The originals remain in
  `history.json`.
- One conversation, one process, no authentication, no streaming.
