# Model Query App

Textarea + submit button. The submit posts to the app's own `/api/ask`, which
forwards the prompt to the chat-completions API of the selected model — DeepSeek
or OpenAI — and renders the answer underneath the button.

No npm dependencies — it uses only Node's built-in `http`/`https` modules.
Bootstrap comes from a CDN.

## Models

The **Model** dropdown picks which API the query goes to: DeepSeek's two V4 tiers
and the three tiers of OpenAI's GPT-5.6. Each dropdown entry maps to a model id
through an environment variable, so a rename at the provider costs a restart
rather than a commit.

| Option | Provider | Model id | Override |
|---|---|---|---|
| DeepSeek Flash | `api.deepseek.com` | `deepseek-v4-flash` | `DEEPSEEK_MODEL_FLASH` |
| DeepSeek Pro | `api.deepseek.com` | `deepseek-v4-pro` | `DEEPSEEK_MODEL_PRO` |
| OpenAI Luna | `api.openai.com` | `gpt-5.6-luna` | `OPENAI_MODEL_LUNA` |
| OpenAI Terra | `api.openai.com` | `gpt-5.6-terra` | `OPENAI_MODEL_TERRA` |
| OpenAI Sol | `api.openai.com` | `gpt-5.6-sol` | `OPENAI_MODEL_SOL` |

Each provider has its own key — `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` — and the
two are independent: with only one set the app still runs, and the models of the
other provider appear in the dropdown greyed out and labelled with the variable
that is missing. The key is picked per request from the selected model's provider
and never reaches the browser.

### Not every model takes every option

The controls below predate the switcher, and the newer models do not accept all of
them. Rather than let a request come back as a 400, each model declares what it
supports; the page greys out the rest and the server drops anything unsupported
before the request goes out — so a stale tab or a hand-made API call cannot
produce a rejection either.

| | Flash / Pro | Luna / Terra / Sol |
|---|---|---|
| Response limit | `max_tokens` | `max_completion_tokens` |
| Temperature | yes | fixed at the default |
| Stop sequences | yes | not accepted |
| Enforced JSON | yes | yes |

One consequence worth knowing: on the OpenAI models the response limit also covers
the hidden reasoning tokens, so a limit small enough to be spent on thinking alone
returns an empty answer with `Truncated: hit the response limit.`

The temperature and stop entries for GPT-5.6 are deliberately conservative. The
published reference documents both restrictions for the earlier reasoning models
without saying either way for 5.6, so the app assumes the restriction still holds:
being wrong here costs a control, whereas guessing the other way costs a rejected
request. If you confirm otherwise, flip `supports` in `server.js` — that one table
drives both the greying-out and the dropping.

## Compare

The **Compare** button next to Submit asks the same question of every model whose
provider key is configured, always as simple prompting, and lays the answers out
with their metrics. Nothing but the model may vary between the calls, so the
prompt technique and the role checkboxes do not apply to it — the response format
and response limit do, and temperature and stop sequences are sent to whichever
models accept them.

The calls run in parallel, so a comparison takes about as long as its slowest
model rather than the sum. A model that fails shows its error in place of an
answer and drops out of the ranking; the request only fails outright when every
model does. Models whose key is unset are skipped entirely rather than reported
as failures.

Six badges are awarded across the results:

| Badge | Measured by |
|---|---|
| Fastest / Slowest | Round-trip time of the call |
| Cheapest / Most expensive | Cost in dollars, per the pricing below |
| Fewest tokens / Most tokens | Total tokens, prompt and completion together |

Ties go to whichever model comes first in the dropdown, and an axis is dropped
entirely when every model ties on it — naming one of them both best and worst
would say nothing true. With only one model configured there are no badges at all.

Note that cheapest and fewest-tokens usually agree but need not: a model can be
more verbose and still cost less, which is the comparison worth seeing.

## Metrics

Every answer carries a line above it with what the call spent:

    1.84 s elapsed   1,500 tokens (1,000 in · 500 out, 300 of it reasoning, 200 cached)   $0.000507 off-peak rate, half price

Time is the round trip as the app sees it — connect, generate, read the body back
— so it includes network latency, not just generation. Tokens and the cost note
come from the provider's own `usage` block; if a response arrives without one, the
figures read `—` rather than a confident zero.

A technique that makes several calls gets a metric line per card plus a total
above them. The total's elapsed time is the wall time of the whole request, not
the sum of the calls: deliberate reasoning runs its roles in parallel, so three
calls of 1.2 s each total roughly 1.2 s, not 3.6 s.

### How the cost is worked out

Prices are USD per 1M tokens, taken from the providers' published tables on
2026-09-06 and hardcoded in `MODELS`:

| Model | Input | Cached input | Output |
|---|---|---|---|
| DeepSeek Flash | $0.44 | $0.014 | $1.32 |
| DeepSeek Pro | $1.32 | $0.044 | $3.96 |
| OpenAI Luna | $0.20 | $0.02 | $1.20 |
| OpenAI Terra | $2.00 | $0.20 | $12.00 |
| OpenAI Sol | $4.00 | $0.40 | $20.00 |

Cached input is priced separately, from `prompt_cache_hit_tokens` on DeepSeek and
`prompt_tokens_details.cached_tokens` on OpenAI. Reasoning tokens are not a
separate line — providers bill them as output — but they are broken out in the
display, since on the OpenAI tiers they are usually most of what you pay for.

Two adjustments are applied on top:

* **DeepSeek off-peak.** Everything is half price outside 01:00–04:00 and
  06:00–10:00 UTC, Monday to Friday. The DeepSeek figures above are the peak rate;
  the app decides which applies from the clock when the call returns, and the
  metric line says which one it used.
* **OpenAI long context.** A prompt over 272,000 tokens reprices the whole request
  at 2× input and 1.5× output. The 1 MB cap on the request body makes that close to
  unreachable here, but it is implemented rather than silently wrong.

Two caveats. The prices follow the *default* model ids: override one and the old
model's rates keep being applied until the table is updated to match. And Sol's
$4/$20 is a promotional rate published as running at least to 2026-11-21 — when it
lapses, the figure here needs updating by hand.

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

**Response format.** The chat-completions APIs only enforce two `response_format`
types, so the options split into two groups:

| Option | How it works |
|---|---|
| Plain text | `response_format: text`. No formatting imposed. |
| JSON | `response_format: json_object` — **enforced by the API**, the reply always parses. A system message carrying the word `json` is added, which that mode requires. All five models support it; one that did not would degrade to the instruction-only treatment below. |
| Markdown / XML / CSV | `response_format: text` plus a system instruction. A strong request, not a guarantee — check the output if you parse it. |

Pretty-printing of JSON happens in the browser; the raw reply is minified.

The format instruction is sent *after* the technique or role instruction, so it
wins where the two conflict — a strict format and chain-of-thought pull in
opposite directions, and the format takes the reasoning with it into the
structure rather than dropping it.

**Response limit.** Maps to `max_tokens` (`max_completion_tokens` on the OpenAI
models), 1–8192. Left empty, the model's own
default applies. It counts *tokens, not characters*, and it truncates rather than
summarises — the response card says `Truncated: hit the response limit.` when
that happens, alongside the tokens actually spent. It is per call, so a technique
making several calls can spend several times over.

**Temperature.** A slider from 0.0 to 2.0 in steps of 0.1, sent as `temperature`.
It sets how much randomness goes into picking each next token: 0.0 is
deterministic — the same query comes back near-identical every time — while the
top of the range wanders and will break a strict response format sooner or later.
The slider starts at 1.0, DeepSeek's own default. The three OpenAI models accept
no other value, so the slider is disabled for them and nothing is sent. Like the response limit it applies per call, so every role of a deliberate-reasoning run and both steps of
meta prompting are generated at the same temperature.

**Stop sequences.** Maps to `stop`; the OpenAI models do not accept it, so the box
is disabled for them. One sequence per line, up to 16. Generation
halts as soon as one appears and the sequence itself is not included in the
answer, so a stop sequence matching at position 0 legitimately yields an empty
response. `\n`, `\t`, `\r` and `\\` are decoded; surrounding spaces on each
line are trimmed, so use an escape when whitespace is what you want to match on.

### `POST /api/ask`

```json
{
  "prompt": "...",
  "model": "terra",
  "technique": "roles",
  "roles": ["engineer", "critic"],
  "format": "json",
  "maxTokens": 512,
  "temperature": 1.2,
  "stop": ["END"]
}
```

`model` is one of `flash` (default), `pro`, `luna`, `terra`, `sol`; an unknown one
is a 400, and a known one whose provider key is unset is a 500.
`technique` is one of `simple` (default), `cot`, `meta`, `roles`; `roles` is
required and non-empty only for `technique: "roles"` and ignored otherwise.
`format` defaults to `text`; `maxTokens`, `temperature` and `stop` may be
`null`/omitted, and `temperature` must be between 0.0 and 2.0 when given (`0` is
a value, not an omission). A
rejected option returns HTTP 400 with an `error` string; an upstream failure
returns 502. Success is HTTP 200 with one entry in `results` per answer, in
display order:

```json
{
  "technique": "meta",
  "format": "text",
  "model": "flash",
  "modelLabel": "DeepSeek Flash",
  "modelId": "deepseek-v4-flash",
  "metrics": {
    "ms": 3412, "calls": 2,
    "tokens": { "prompt": 2000, "completion": 1000, "total": 3000, "cached": 400, "reasoning": 0 },
    "cost": { "currency": "USD", "input": 0.00035, "output": 0.00066,
              "total": 0.00101, "note": "off-peak rate, half price" }
  },
  "results": [
    { "id": "meta-prompt", "label": "Generated prompt", "kind": "prompt",
      "format": "text", "answer": "...", "finishReason": "stop", "usage": {},
      "metrics": { "ms": 1600, "tokens": {}, "cost": {} } },
    { "id": "answer", "label": "Answer", "kind": "answer",
      "format": "text", "answer": "...", "finishReason": "stop", "usage": {},
      "metrics": { "ms": 1812, "tokens": {}, "cost": {} } }
  ]
}
```

`kind` is `prompt` for the intermediate meta-prompting step and `answer`
otherwise. A role that failed carries `"answer": null` and an `error` string
instead, and no `metrics`.

`metrics` appears per result and once for the request as a whole; the top-level
`ms` is wall time and `calls` the number of upstream requests, while the per-result
`ms` times one call. `usage` is the provider's block passed through untouched —
`metrics.tokens` is the normalised view of it, and both are `null` when the
provider returns no usage at all.

### `GET /api/models`

What the page builds the switcher from, so the two cannot drift on what a model
supports or whether its key is configured:

```json
{
  "default": "flash",
  "models": [
    { "key": "flash", "label": "DeepSeek Flash", "provider": "DeepSeek",
      "id": "deepseek-v4-flash", "note": "...", "configured": true,
      "keyVar": "DEEPSEEK_API_KEY",
      "pricing": { "cacheHit": 0.014, "cacheMiss": 0.44, "output": 1.32 },
      "supports": { "jsonMode": true, "temperature": true, "stop": true } }
  ]
}
```

`configured` reports only whether the key variable is set, not whether it is
valid. Keys themselves are never included. `pricing` is USD per 1M tokens and its
shape follows the provider — DeepSeek splits input by cache hit and miss, OpenAI
by cached and uncached plus a `longContext` tier.

### `POST /api/compare`

Same body as `/api/ask` minus `model`, `technique` and `roles`, which it sets
itself:

```json
{ "prompt": "...", "format": "text", "maxTokens": 500, "temperature": 1, "stop": [] }
```

The response is the `/api/ask` shape with two additions — `comparison: true` and
a `highlights` object — and one result per compared model, each carrying `model`
and `modelId` alongside its `metrics`:

```json
{
  "comparison": true,
  "technique": "simple",
  "format": "text",
  "metrics": { "ms": 2820, "calls": 2, "tokens": {}, "cost": {} },
  "highlights": {
    "fastest": "flash", "slowest": "pro",
    "cheapest": "flash", "dearest": "pro",
    "leanest": "flash", "heaviest": "pro"
  },
  "results": [
    { "id": "flash", "model": "flash", "modelId": "deepseek-v4-flash",
      "label": "DeepSeek Flash", "answer": "...", "metrics": {} }
  ]
}
```

Each value in `highlights` is a model key, and an axis is absent when it could not
be decided. The top-level `ms` is the wall time of the whole comparison, so it is
close to the slowest single call rather than the sum of them. HTTP 500 when no key
is configured at all, 502 when every model failed.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | *(none)* | Needed for the two DeepSeek models; never sent to the browser. |
| `OPENAI_API_KEY` | *(none)* | Needed for the three OpenAI models. |
| `HOST` | `127.0.0.1` | Localhost-only, so nginx is the sole entry point. Set `0.0.0.0` only if you really want to expose it. |
| `PORT` | `3000` | Upstream port nginx proxies to. |
| `DEFAULT_MODEL` | `flash` | Which entry the page opens on. Ignored if it is not a known key. |
| `DEEPSEEK_MODEL_FLASH` | `deepseek-v4-flash` | Falls back to `DEEPSEEK_MODEL` for compatibility with earlier days. |
| `DEEPSEEK_MODEL_PRO` | `deepseek-v4-pro` | |
| `OPENAI_MODEL_LUNA` | `gpt-5.6-luna` | |
| `OPENAI_MODEL_TERRA` | `gpt-5.6-terra` | |
| `OPENAI_MODEL_SOL` | `gpt-5.6-sol` | |

Overriding a model id does **not** move its prices; those are hardcoded per entry in
`MODELS`, so update them together or the cost figures will describe the old model.

Neither key is required to boot: the app starts, warns on stdout about whichever
is missing, and disables that provider's models in the UI.

### `.env`

For local runs the app reads a `.env` file sitting next to `server.js` before
anything else. Lines are `KEY=value`, `#` comments and blank lines are skipped, a
leading `export` and surrounding quotes are stripped, and **a variable already
present in the environment is never overwritten** — so systemd's `EnvironmentFile`
stays authoritative in production and the file may simply be absent there. It is
covered by `.gitignore`; do not commit it.

    # week0/day5/.env
    DEEPSEEK_API_KEY=sk-...
    OPENAI_API_KEY=sk-proj-...

## Local run

    node server.js          # keys from .env
    # or
    DEEPSEEK_API_KEY=sk-... OPENAI_API_KEY=sk-proj-... node server.js
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
    sudo rsync -a --delete ./ /opt/deepseek-app/ --exclude .git --exclude deploy --exclude .env
    sudo chown -R root:deepseek-app /opt/deepseek-app
    sudo chmod -R o-rwx /opt/deepseek-app

### 4. API keys

Keep the keys out of the unit file so they stay off `systemctl cat` output for
non-privileged users. Set both, or only the one whose models you intend to use:

    sudo tee /etc/deepseek-app.env >/dev/null <<'EOF'
    DEEPSEEK_API_KEY=sk-your-deepseek-key
    OPENAI_API_KEY=sk-proj-your-openai-key
    EOF
    sudo chown root:deepseek-app /etc/deepseek-app.env
    sudo chmod 640 /etc/deepseek-app.env

`ProtectSystem=strict` and `ReadOnlyPaths=` leave `/opt/deepseek-app` read-only,
so a `.env` deployed there would be read but never written; the `EnvironmentFile`
above is the supported route and wins over it either way.

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

    sudo rsync -a --delete ./ /opt/deepseek-app/ --exclude .git --exclude deploy --exclude .env
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
| `DEEPSEEK_API_KEY is not set` / `OPENAI_API_KEY is not set` warning | Env file unreadable by the service user, or the key simply absent | `sudo chown root:deepseek-app /etc/deepseek-app.env && sudo chmod 640 /etc/deepseek-app.env` |
| A model is greyed out in the dropdown | Its provider's key is not set on the server | Add it to `/etc/deepseek-app.env` and restart |
| `OpenAI API error (gpt-5.6-sol): ... unsupported value` | An option the model does not take reached it | Should not happen — the server drops those. Check the model's `supports` in `server.js` against the provider's current docs |
| `EADDRINUSE` | Port 3000 already taken | `sudo ss -lntp | grep :3000`, or set `PORT=` in the unit and in nginx.conf together |
| nginx 502 | App not running or on another port | `curl 127.0.0.1:3000` on the server |
| nginx 504 | Completion outstripped the proxy timeout | Raise `proxy_read_timeout` and the app's 120s timeout together |

After editing the unit file, always:

    sudo systemctl daemon-reload && sudo systemctl restart deepseek-app

## Notes on timeouts

The app aborts an upstream request after 120s. nginx is set to 130s so the app's
own error message reaches the browser instead of an nginx 504. The reasoning
models — DeepSeek Pro and all three OpenAI ones — think before they answer and are
the ones that will reach that ceiling first; if they time out, raise both together.

That 120s is per upstream call, not per browser request. Deliberate reasoning
fires its role calls in parallel, so it stays inside one call's worth of time no
matter how many roles are ticked — but meta prompting is two calls back to back
and can reach 240s, past nginx's 130s. If meta prompting 504s on a slow model,
raise `proxy_read_timeout`/`proxy_send_timeout` to cover both calls.
