# DeepSeek Query App

Textarea + submit button. The submit posts to the app's own `/api/ask`, which
forwards the prompt to the DeepSeek chat-completions API and renders the answer
underneath the button.

No npm dependencies — it uses only Node's built-in `http`/`https` modules.
Bootstrap comes from a CDN.

## Request options

Four controls sit under the query box; all four are optional.

**Prompt technique.** How the query is put to the model. Everything else on the
page (format, limit, stop sequences) applies to each answer the technique
produces.

| Option | Calls | What happens |
|---|---|---|
| Simple prompting | 1 | The query is sent as typed. |
| Chain of thought | 1 | A system instruction tells the model to number its steps and finish with the conclusion, so the reasoning is part of the answer. |
| Meta prompting | 2 | The model is first asked to *write* a prompt for the task instead of solving it. That prompt is shown as its own card, then sent back with the original task to get the answer. |
| Deliberate reasoning | 1 per role | Checkboxes appear: engineer, analytic, critic, teacher, lawyer, financier. Each ticked role answers the same query behind its own persona instruction, in a card of its own. |

The role calls run in parallel. If one of them fails the others are still
returned, with the failure shown in place of that role's answer; only when every
role fails does the request itself return 502.

In the meta-prompting flow the response format and stop sequences apply to the
answer, not to the prompt-writing step — a stop sequence would otherwise cut the
generated prompt in half. The response limit applies to both.

**Response format.** DeepSeek's API only enforces two `response_format` types, so
the options split into two groups:

| Option | How it works |
|---|---|
| Plain text | `response_format: text`. No formatting imposed. |
| JSON | `response_format: json_object` — **enforced by the API**, the reply always parses. A system message carrying the word `json` is added, which that mode requires. |
| Markdown / XML / CSV | `response_format: text` plus a system instruction. A strong request, not a guarantee — check the output if you parse it. |

Pretty-printing of JSON happens in the browser; the raw reply is minified.

The format instruction is sent *after* the technique or role instruction, so it
wins where the two conflict — a strict format and chain-of-thought pull in
opposite directions, and the format takes the reasoning with it into the
structure rather than dropping it.

**Response limit.** Maps to `max_tokens`, 1–8192. Left empty, the model's own
default applies. It counts *tokens, not characters*, and it truncates rather than
summarises — the response card says `Truncated: hit the response limit.` when
that happens, alongside the tokens actually spent. It is per call, so a technique
making several calls can spend several times over.

**Stop sequences.** Maps to `stop`. One sequence per line, up to 16. Generation
halts as soon as one appears and the sequence itself is not included in the
answer, so a stop sequence matching at position 0 legitimately yields an empty
response. `\n`, `\t`, `\r` and `\\` are decoded; surrounding spaces on each
line are trimmed, so use an escape when whitespace is what you want to match on.

### `POST /api/ask`

```json
{
  "prompt": "...",
  "technique": "roles",
  "roles": ["engineer", "critic"],
  "format": "json",
  "maxTokens": 512,
  "stop": ["END"]
}
```

`technique` is one of `simple` (default), `cot`, `meta`, `roles`; `roles` is
required and non-empty only for `technique: "roles"` and ignored otherwise.
`format` defaults to `text`; `maxTokens` and `stop` may be `null`/omitted. A
rejected option returns HTTP 400 with an `error` string; an upstream failure
returns 502. Success is HTTP 200 with one entry in `results` per answer, in
display order:

```json
{
  "technique": "meta",
  "format": "text",
  "results": [
    { "id": "meta-prompt", "label": "Generated prompt", "kind": "prompt",
      "format": "text", "answer": "...", "finishReason": "stop", "usage": {} },
    { "id": "answer", "label": "Answer", "kind": "answer",
      "format": "text", "answer": "...", "finishReason": "stop", "usage": {} }
  ]
}
```

`kind` is `prompt` for the intermediate meta-prompting step and `answer`
otherwise. A role that failed carries `"answer": null` and an `error` string
instead.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | *(required)* | Read from the environment; never sent to the browser. |
| `HOST` | `127.0.0.1` | Localhost-only, so nginx is the sole entry point. Set `0.0.0.0` only if you really want to expose it. |
| `PORT` | `3000` | Upstream port nginx proxies to. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | e.g. `deepseek-reasoner`. |

## Local run

    DEEPSEEK_API_KEY=sk-... node server.js
    # http://127.0.0.1:3000

## Deploying on Debian 13 (trixie) behind nginx

### 1. Node

Trixie ships Node 20 in the main repo:

    sudo apt update && sudo apt install -y nodejs nginx

### 2. Service user

The unit runs as a dedicated, unprivileged account. If this account is missing,
systemd refuses to start the service with `status=217/USER` before it ever runs
node — so create it first and verify it exists.

    sudo cp deploy/deepseek-app.sysusers.conf /etc/sysusers.d/deepseek-app.conf
    sudo systemd-sysusers

Or equivalently, by hand — note `--user-group`, which also creates the matching
group the unit's `Group=` line needs:

    sudo useradd --system --user-group --no-create-home \
         --home-dir /opt/deepseek-app --shell /usr/sbin/nologin deepseek-app

Verify before moving on; this must print a uid and gid:

    id deepseek-app

### 3. Files

    sudo mkdir -p /opt/deepseek-app
    sudo rsync -a --delete ./ /opt/deepseek-app/ --exclude .git --exclude deploy
    sudo chown -R root:deepseek-app /opt/deepseek-app
    sudo chmod -R o-rwx /opt/deepseek-app

### 4. API key

Keep the key out of the unit file so it stays off `systemctl cat` output for
non-privileged users:

    printf 'DEEPSEEK_API_KEY=sk-your-key-here\n' | sudo tee /etc/deepseek-app.env >/dev/null
    sudo chown root:deepseek-app /etc/deepseek-app.env
    sudo chmod 640 /etc/deepseek-app.env

### 5. systemd

    sudo cp deploy/deepseek-app.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now deepseek-app
    systemctl status deepseek-app
    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # expect 200

### 6. nginx

Edit `server_name` in `deploy/nginx.conf`, then:

    sudo cp deploy/nginx.conf /etc/nginx/sites-available/deepseek-app
    sudo ln -s /etc/nginx/sites-available/deepseek-app /etc/nginx/sites-enabled/
    sudo rm -f /etc/nginx/sites-enabled/default     # if the welcome page is still enabled
    sudo nginx -t && sudo systemctl reload nginx

### 7. TLS

    sudo apt install -y certbot python3-certbot-nginx
    sudo certbot --nginx -d example.com

### 8. Firewall

The app binds to `127.0.0.1`, so only nginx needs to be reachable:

    sudo ufw allow 'Nginx Full'
    sudo ufw enable

## Operating

    sudo systemctl restart deepseek-app     # graceful: SIGTERM drains in-flight requests
    journalctl -u deepseek-app -f           # logs

### Updating

    sudo rsync -a --delete ./ /opt/deepseek-app/ --exclude .git --exclude deploy
    sudo chown -R root:deepseek-app /opt/deepseek-app
    sudo systemctl restart deepseek-app

## Troubleshooting

Check what systemd actually reported:

    systemctl status deepseek-app
    journalctl -u deepseek-app -n 50 --no-pager

For a seccomp kill (`signal=SYS`), the offending syscall is only in the kernel
log, not the unit's journal:

    sudo journalctl -k -g seccomp -n 20 --no-pager   # look for syscall=<N>
    ausyscall <N>                                    # from the auditd package

| Symptom | Cause | Fix |
|---|---|---|
| `status=217/USER` | The `deepseek-app` user does not exist | Step 2; confirm with `id deepseek-app` |
| `status=216/GROUP` | User exists but the group does not | `sudo groupadd deepseek-app && sudo usermod -g deepseek-app deepseek-app` |
| `code=killed, signal=SYS` | A syscall hit the seccomp filter | Covered by `SystemCallErrorNumber=EPERM` + `UV_USE_IO_URING=0` in the unit; if it persists, comment out both `SystemCallFilter` lines |
| `getaddrinfo EAI_AGAIN` | `RestrictAddressFamilies=` is missing `AF_NETLINK` | Use the unit as shipped — it lists `AF_UNIX AF_INET AF_INET6 AF_NETLINK` |
| `status=203/EXEC` | `/usr/bin/node` is not there | `command -v node`, then correct `ExecStart=` |
| `status=200/CHDIR` | `/opt/deepseek-app` missing | Step 3 |
| `DEEPSEEK_API_KEY is not set` warning | Env file unreadable by the service user | `sudo chown root:deepseek-app /etc/deepseek-app.env && sudo chmod 640 /etc/deepseek-app.env` |
| `EADDRINUSE` | Port 3000 already taken | `sudo ss -lntp | grep :3000`, or set `PORT=` in the unit and in nginx.conf together |
| nginx 502 | App not running or on another port | `curl 127.0.0.1:3000` on the server |
| nginx 504 | Completion outstripped the proxy timeout | Raise `proxy_read_timeout` and the app's 120s timeout together |

After editing the unit file, always:

    sudo systemctl daemon-reload && sudo systemctl restart deepseek-app

## Notes on timeouts

The app aborts a DeepSeek request after 120s. nginx is set to 130s so the app's
own error message reaches the browser instead of an nginx 504. If you switch to
`deepseek-reasoner` and see truncated requests, raise both together.

That 120s is per upstream call, not per browser request. Deliberate reasoning
fires its role calls in parallel, so it stays inside one call's worth of time no
matter how many roles are ticked — but meta prompting is two calls back to back
and can reach 240s, past nginx's 130s. If meta prompting 504s on a slow model,
raise `proxy_read_timeout`/`proxy_send_timeout` to cover both calls.
