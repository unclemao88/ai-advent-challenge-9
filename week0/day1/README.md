# DeepSeek Query App

Textarea + submit button. The submit posts to the app's own `/api/ask`, which
forwards the prompt to the DeepSeek chat-completions API and renders the answer
underneath the button.

No npm dependencies — it uses only Node's built-in `http`/`https` modules.
Bootstrap comes from a CDN.

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

| Symptom | Cause | Fix |
|---|---|---|
| `status=217/USER` | The `deepseek-app` user does not exist | Step 2; confirm with `id deepseek-app` |
| `status=216/GROUP` | User exists but the group does not | `sudo groupadd deepseek-app && sudo usermod -g deepseek-app deepseek-app` |
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
