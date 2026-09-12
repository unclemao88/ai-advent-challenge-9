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
| `DATA_DIR` | no | `./data` | Where `chat-history.json` lives. A packaged install points this at a writable state directory. |
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
│   └── chat-history.json    created on first start (DATA_DIR elsewhere in production)
├── deploy/
│   ├── deepseek-agent.service        systemd unit
│   ├── deepseek-agent.sysusers.conf  service account
│   └── nginx.conf                    reverse proxy site
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

## Deploying on Debian behind nginx

Everything below assumes Debian 12 (bookworm) or 13 (trixie) with systemd.
The unit, the service account and the nginx site are in `deploy/`.

### 1. Node and nginx

    sudo apt update && sudo apt install -y nodejs npm nginx
    node --version        # 18 or newer on bookworm/trixie; the app needs >= 10

### 2. Service user

systemd refuses to start the service with `status=217/USER` if this account is
missing, before it ever runs node — so create it first and verify.

    sudo cp deploy/deepseek-agent.sysusers.conf /etc/sysusers.d/deepseek-agent.conf
    sudo systemd-sysusers
    id deepseek-agent     # must print a uid and gid

### 3. Files

Unlike the earlier apps in this repo, this one has a dependency (Express), so
`node_modules` has to exist on the box. Install it, then deploy the tree
read-only:

    npm ci --omit=dev                 # older npm: npm ci --production
    sudo mkdir -p /opt/deepseek-agent
    sudo rsync -a --delete ./ /opt/deepseek-agent/ \
        --exclude .git --exclude deploy --exclude .env --exclude data
    sudo chown -R root:deepseek-agent /opt/deepseek-agent
    sudo chmod -R o-rwx /opt/deepseek-agent

`--exclude data` matters: the deployed code is read-only, and the conversation
lives outside it (next step).

### 4. Where the memory lives

The history is the agent's memory, so it must survive a redeploy. The unit sets
`StateDirectory=deepseek-agent`, which makes systemd create
`/var/lib/deepseek-agent` owned by the service account — writable even under
`ProtectSystem=strict`, while `/opt/deepseek-agent` stays read-only. The app
writes `$DATA_DIR/chat-history.json` and nothing else.

Nothing to do by hand here, but if you are moving an existing conversation over:

    sudo install -o deepseek-agent -g deepseek-agent -m 600 \
        data/chat-history.json /var/lib/deepseek-agent/chat-history.json

### 5. API key

Kept out of the unit file so it stays off `systemctl cat` for non-privileged users:

    printf 'DEEPSEEK_API_KEY=sk-your-key-here\n' | sudo tee /etc/deepseek-agent.env >/dev/null
    sudo chown root:deepseek-agent /etc/deepseek-agent.env
    sudo chmod 640 /etc/deepseek-agent.env

### 6. systemd

    sudo cp deploy/deepseek-agent.service /etc/systemd/system/
    sudo systemd-analyze verify /etc/systemd/system/deepseek-agent.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now deepseek-agent
    systemctl status deepseek-agent
    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/     # expect 200
    sudo ls -l /var/lib/deepseek-agent/                                 # chat-history.json

### 7. nginx

Edit `server_name` in `deploy/nginx.conf`, then:

    sudo cp deploy/nginx.conf /etc/nginx/sites-available/deepseek-agent
    sudo ln -s /etc/nginx/sites-available/deepseek-agent /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

### 8. TLS and firewall

    sudo apt install -y certbot python3-certbot-nginx
    sudo certbot --nginx -d example.com
    sudo ufw allow 'Nginx Full' && sudo ufw enable

## Operating

    sudo systemctl restart deepseek-agent    # graceful: SIGTERM drains in-flight requests
    journalctl -u deepseek-agent -f

The startup lines name the model and the history file, which is the quickest way
to confirm what a box is actually running and where its memory is:

    Agent: DeepSeek (deepseek-chat)
    History: /var/lib/deepseek-agent/chat-history.json
    Listening on http://127.0.0.1:3000

Redeploying replaces `/opt/deepseek-agent` and leaves `/var/lib/deepseek-agent`
alone, so the agent keeps its memory across upgrades. To wipe the conversation:

    sudo systemctl stop deepseek-agent
    sudo rm /var/lib/deepseek-agent/chat-history.json
    sudo systemctl start deepseek-agent

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The agent is not configured on the server` | `DEEPSEEK_API_KEY` unset or unreadable | `sudo chown root:deepseek-agent /etc/deepseek-agent.env && sudo chmod 640 /etc/deepseek-agent.env` |
| `DeepSeek rejected the API key` | Wrong or revoked key | New key at platform.deepseek.com |
| `status=217/USER` | The `deepseek-agent` user does not exist | Step 2; confirm with `id deepseek-agent` |
| `Cannot find module 'express'` | `node_modules` was not deployed | Run `npm ci --omit=dev` before the rsync in step 3 |
| `Could not open the history file: EROFS/EACCES` | `DATA_DIR` points inside the read-only tree | Keep `StateDirectory=` and `DATA_DIR=/var/lib/deepseek-agent` as shipped |
| History empty after a redeploy | The rsync overwrote a `data/` directory in `/opt` | The memory belongs in `/var/lib/deepseek-agent`; keep `--exclude data` |
| `code=killed, signal=SYS` | A syscall hit the seccomp filter | Covered by `SystemCallErrorNumber=EPERM` + `UV_USE_IO_URING=0`; if it persists, comment out both `SystemCallFilter` lines |
| `getaddrinfo EAI_AGAIN` | `RestrictAddressFamilies=` is missing `AF_NETLINK` | Use the unit as shipped |
| `EADDRINUSE` | Port 3000 already taken — the other apps in this repo default to it too | Set `PORT=` in the unit and in `nginx.conf` together |
| nginx 504 | The answer outran the proxy timeout | Raise `proxy_read_timeout` and `DEEPSEEK_TIMEOUT_MS` together |

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
