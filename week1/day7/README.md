# DeepSeek Agent

A chat page with one text field and an **ask** button. Every question and every
answer is appended to a local JSON file, and that file is the agent's memory:
it is replayed to DeepSeek as conversation context on every new question, so
the agent still knows what you told it after a page reload or a server restart.

```text
Browser  ──POST /api/ask──▶  server.js  ──▶  agent/deepseekAgent.js  ──▶  DeepSeek API
   ▲                             │                     ▲
   │                             ▼                     │
   └────── question + answer ── storage/chatStorage.js ─┘
                                (data/chat-history.json)
```

The browser only ever talks to this Node server. The API key stays on the
server and never reaches the page.

## Requirements

- Node.js 10 or newer (tested on Node 10.13; no ES-module or `fetch` features
  are used, so newer versions work too)
- A DeepSeek API key

## Installation

```bash
npm install
cp .env.example .env
npm start
```

Then open **http://localhost:3000**.

## Getting and configuring the API key

1. Sign in at <https://platform.deepseek.com/> and create a key under
   **API keys**. The account needs credit for the key to work.
2. Copy `.env.example` to `.env` and paste the key in:

   ```env
   DEEPSEEK_API_KEY=sk-your-key-here
   DEEPSEEK_MODEL=deepseek-chat
   PORT=3000
   ```

`.env` is git-ignored. `.env.example` is the committed template and holds no
secret. A value already set in the environment always wins over `.env`, so a
service manager can supply the key instead.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | yes | — | Your DeepSeek key. Never sent to the browser. |
| `DEEPSEEK_MODEL` | no | `deepseek-chat` | The model to call. |
| `PORT` | no | `3000` | Port to listen on. |
| `HOST` | no | `127.0.0.1` | Interface to bind. Loopback only by default. |
| `DEEPSEEK_API_URL` | no | `https://api.deepseek.com/chat/completions` | Override for a proxy or a compatible endpoint. |
| `DEEPSEEK_TIMEOUT_MS` | no | `60000` | Hard limit on one DeepSeek exchange. |
| `DEEPSEEK_HISTORY_LIMIT` | no | `0` (all) | Replay only the last N stored messages. |

Without a key the server still starts and still serves the stored
conversation; asking a question answers `503` with an explanation.

## Running it

```bash
npm start        # node server.js
npm run dev      # same, restarted on file changes (nodemon)
```

## Where the conversation is stored

`data/chat-history.json`, created automatically on first start:

```json
{
  "messages": [
    {
      "id": "mtyfmbi9-615574092ab0",
      "timestamp": "2026-09-12T13:39:41.637Z",
      "tag": "you asked",
      "role": "user",
      "content": "My name is John. Please remember it."
    },
    {
      "id": "mtyfmbi9-28a19d6d14a7",
      "timestamp": "2026-09-12T13:39:43.425Z",
      "tag": "agent answered",
      "role": "assistant",
      "content": "Hello, John! Nice to meet you."
    }
  ]
}
```

The id, the ISO 8601 timestamp, the `tag` and the `role` are all generated on
the server; nothing in the request body can set them. The file is git-ignored,
since a conversation is personal data. Delete it to start over — it is
recreated empty on the next request.

Writes go through a single queue and land via a temporary file plus an atomic
rename, so two questions answered at the same moment cannot interleave and a
crash mid-write cannot truncate the history.

## How the agent uses the history

On every question `POST /api/ask`:

1. reads the whole stored conversation,
2. hands it to the agent, which builds a DeepSeek `messages` array —
   the system prompt, then every stored user/assistant message in order, then
   the new question,
3. calls DeepSeek once,
4. appends the question and the answer together in a single write,
5. returns both to the browser.

DeepSeek is called *before* anything is stored, and both messages are written
in one operation, so a failed call cannot leave a question in the history with
no answer under it.

Because the context comes from the file rather than the browser, this works:

```text
you asked        My name is John.
agent answered   Nice to meet you, John.
# restart the server, reload the page
you asked        What is my name?
agent answered   Your name is John.
```

`selectHistory()` in `agent/deepseekAgent.js` is the single place that decides
how much of the past is sent. It currently sends everything; set
`DEEPSEEK_HISTORY_LIMIT` to cap it, or replace that method with a token budget
or a summarising step without touching anything else.

## Project structure

```text
deepseek-agent/
├── package.json
├── .env                     your key (git-ignored)
├── .env.example             committed template
├── .gitignore
├── server.js                HTTP server, routes, validation, error handling
├── agent/
│   └── deepseekAgent.js     everything DeepSeek: endpoint, key, model, wire format
├── storage/
│   └── chatStorage.js       loading, appending and shaping the JSON history
├── lib/
│   └── load-env.js          reads .env without a dependency
├── data/
│   └── chat-history.json    created on first start
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js               the UI and the calls to this server
└── README.md
```

| File | Knows about |
|---|---|
| `public/app.js` | The DOM and this server's two endpoints. No provider, no model, no key. |
| `server.js` | Routes, validation, and calling `agent.ask(question, history)`. |
| `agent/deepseekAgent.js` | DeepSeek. Nothing else mentions it. |
| `storage/chatStorage.js` | The JSON file and the shape of a message. |

## API

### `GET /api/history`

```json
{ "messages": [ { "id": "...", "timestamp": "...", "tag": "you asked", "role": "user", "content": "..." } ] }
```

### `POST /api/ask`

```json
{ "question": "What is Node.js?" }
```

```json
{
  "userMessage":      { "id": "...", "timestamp": "...", "tag": "you asked",      "role": "user",      "content": "..." },
  "assistantMessage": { "id": "...", "timestamp": "...", "tag": "agent answered", "role": "assistant", "content": "..." }
}
```

Errors come back as `{"error": "…"}` with a status: `400` empty or unparseable
question, `413` question too long, `429` rate limited, `502` DeepSeek refused
or is unreachable, `503` no key configured, `504` DeepSeek timed out.

## Changing the model

Edit `DEEPSEEK_MODEL` in `.env` and restart:

```env
DEEPSEEK_MODEL=deepseek-reasoner
```

The model name is read once, in `createAgent()`, and appears nowhere else.

## Security notes

- The key is read from the environment on the server and is never logged, never
  put in an error message, and never sent to the browser.
- The request body contributes only `question`; ids, timestamps, tags and roles
  are server-generated, so a client cannot forge an `assistant` message into the
  agent's memory.
- Questions and answers are rendered with `textContent` and `createElement`
  only — no `innerHTML` anywhere — so HTML in a question or an answer is shown
  as text rather than executed.
- Unexpected server errors are logged in full and reported to the browser as
  one plain sentence, with no stack trace or configuration.
- The server binds to `127.0.0.1` by default, so it is not exposed to the
  network until you set `HOST`.
