# Agent Chat App

A text field, an **Ask** button, and the answer underneath it. The page never
talks to DeepSeek: it asks an **Agent**, and the Agent does the rest.

```text
Web UI  ──ask(question)──▶  Agent  ──chat/completions──▶  DeepSeek API
   ▲                          │
   └──────── answer ──────────┘
```

No npm dependencies — Node's built-in `http`/`https` only. Bootstrap comes
from a CDN.

## The Agent abstraction

`agent/agent.js` defines the whole contract:

```js
class Agent {
  ask(prompt) { /* → Promise<string> */ }
}
```

Everything provider-specific lives behind it, in `agent/deepseek-agent.js`:
API URL, `Authorization` header, model, request body, the HTTPS call, response
parsing, error mapping and the timeout. Nothing outside that file mentions
DeepSeek.

| File | Knows about |
|---|---|
| `public/app.js` | The DOM, and `agent.ask(question)`. Nothing else. |
| `public/agent.js` | The browser half of the interface: `POST /api/ask`. No provider, no model, no key. |
| `server.js` | `createAgent()` and `agent.ask(question)`. No DeepSeek anywhere. |
| `agent/deepseek-agent.js` | DeepSeek. |
| `agent/index.js` | Which implementation to construct. |

### Swapping the provider

Add a class extending `Agent`, then add a branch to `createAgent()` in
`agent/index.js`. Nothing else changes — not the route, not the UI.

`agent/echo-agent.js` is exactly that: a second implementation, selected with
`AGENT_PROVIDER=echo`, which replies with the question and needs no API key.
It is there to keep the abstraction honest (and to work on the UI offline).

## Security

The API key is read from the environment on the server and is never sent to
the browser: the page only ever sees `POST /api/ask` on this app's own origin.
It is not in the source, and `.env` is git-ignored. Copy `.env.example`:

    cp .env.example .env
    $EDITOR .env

In production, prefer systemd's `EnvironmentFile` (below) over a `.env` file.
Values already in the environment win over `.env`, so the two never fight.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | *(required)* | Server-side only. Never reaches the browser. |
| `AGENT_PROVIDER` | `deepseek` | `deepseek` or `echo`. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | e.g. `deepseek-reasoner`. |
| `DEEPSEEK_API_URL` | `https://api.deepseek.com/chat/completions` | For a gateway or compatible endpoint. |
| `AGENT_TIMEOUT_MS` | `60000` | How long the agent waits before giving up. |
| `AGENT_SYSTEM_PROMPT` | *(none)* | Prepended as a system message. |
| `HOST` | `127.0.0.1` | Localhost-only, so nginx is the sole entry point. |
| `PORT` | `3000` | Upstream port nginx proxies to. |

## Local run

    cp .env.example .env      # then put a real key in it
    npm start                 # or: node server.js
    # http://127.0.0.1:3000

Without a key:

    AGENT_PROVIDER=echo npm start

## UI behaviour

* **Ask** is disabled while the field is empty and while a request is running.
* A spinner appears in the button; the label becomes "Asking…".
* Enter submits, Shift+Enter inserts a newline.
* The question is trimmed; an empty one is never sent.
* The form never reloads the page.
* Failures show as a red alert with the message the agent produced — bad key,
  rate limit, timeout and unreachable-server all read differently.

## `POST /api/ask`

```json
{ "question": "..." }
```

Success is HTTP 200 with `{ "answer": "..." }`. Failures return an `error`
string: 400 for an empty or malformed request, 429 when rate limited, 503 when
the agent is not configured, 504 on timeout, 502 for anything upstream.

## Tests

    npm test

`test/agent.test.js` runs `DeepSeekAgent` against a stub of the DeepSeek
endpoint — request shape, auth header, 401/429/5xx mapping, non-JSON bodies,
empty answers and the timeout — so the whole path is covered without a key.
`test/browser-agent.test.js` runs `public/agent.js` under Node with a stubbed
`fetch`.

## Deploying on Debian 13 (trixie) behind nginx

### 1. Node

    sudo apt update && sudo apt install -y nodejs nginx

### 2. Service user

systemd refuses to start the service with `status=217/USER` if this account is
missing, before it ever runs node — so create it first and verify.

    sudo cp deploy/agent-app.sysusers.conf /etc/sysusers.d/agent-app.conf
    sudo systemd-sysusers
    id agent-app      # must print a uid and gid

### 3. Files

    sudo mkdir -p /opt/agent-app
    sudo rsync -a --delete ./ /opt/agent-app/ --exclude .git --exclude deploy --exclude .env
    sudo chown -R root:agent-app /opt/agent-app
    sudo chmod -R o-rwx /opt/agent-app

### 4. API key

Kept out of the unit file so it stays off `systemctl cat` for non-privileged users:

    printf 'DEEPSEEK_API_KEY=sk-your-key-here\n' | sudo tee /etc/agent-app.env >/dev/null
    sudo chown root:agent-app /etc/agent-app.env
    sudo chmod 640 /etc/agent-app.env

### 5. systemd

    sudo cp deploy/agent-app.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now agent-app
    systemctl status agent-app
    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # expect 200

### 6. nginx

Edit `server_name` in `deploy/nginx.conf`, then:

    sudo cp deploy/nginx.conf /etc/nginx/sites-available/agent-app
    sudo ln -s /etc/nginx/sites-available/agent-app /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

### 7. TLS and firewall

    sudo apt install -y certbot python3-certbot-nginx
    sudo certbot --nginx -d example.com
    sudo ufw allow 'Nginx Full' && sudo ufw enable

## Operating

    sudo systemctl restart agent-app     # graceful: SIGTERM drains in-flight requests
    journalctl -u agent-app -f

The startup line names the live implementation (`Agent: DeepSeek (deepseek-chat)`),
which is the quickest way to confirm which provider a box is actually running.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The agent is not configured on the server` | `DEEPSEEK_API_KEY` unset or unreadable | `sudo chown root:agent-app /etc/agent-app.env && sudo chmod 640 /etc/agent-app.env` |
| `DeepSeek rejected the API key` | Wrong or revoked key | New key at platform.deepseek.com |
| `status=217/USER` | The `agent-app` user does not exist | Step 2; confirm with `id agent-app` |
| `code=killed, signal=SYS` | A syscall hit the seccomp filter | Covered by `SystemCallErrorNumber=EPERM` + `UV_USE_IO_URING=0`; if it persists, comment out both `SystemCallFilter` lines |
| `getaddrinfo EAI_AGAIN` | `RestrictAddressFamilies=` is missing `AF_NETLINK` | Use the unit as shipped |
| `EADDRINUSE` | Port 3000 already taken — the week0 apps default to it too | Set `PORT=` in the unit and in `nginx.conf` together |
| nginx 504 | The answer outran the proxy timeout | Raise `proxy_read_timeout` and `AGENT_TIMEOUT_MS` together |
