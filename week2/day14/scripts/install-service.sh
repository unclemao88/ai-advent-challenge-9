#!/bin/sh
# Install or update the DeepSeek Agent (day 14) on Debian.
#
#   sudo sh scripts/install-service.sh [--no-start] [--skip-tokenizer]
#
# Run it from a checkout of this directory (or from /opt/deepseek-app-day14
# itself). It is idempotent: running it again updates code and dependencies
# and never touches data/ or an existing /etc/deepseek-app.env.
#
#   1. checks for root and Node.js >= 20.12
#   2. creates the system user "deepseek-app" if it is missing
#   3. creates /opt/deepseek-app-day14 and copies the application into it
#   4. installs production dependencies (npm ci --omit=dev)
#   5. downloads the DeepSeek tokenizer for exact token counts (optional)
#   6. creates data/ with every data file (valid empty JSON), and
#      /etc/deepseek-app.env (shared by all deepseek-app-dayNN services) if missing
#   7. gives the application to deepseek-app (data/: owner only)
#   8. installs /etc/systemd/system/deepseek-app-day14.service,
#      runs systemctl daemon-reload, enables and (re)starts the service
set -eu

APP=deepseek-app-day14
APP_USER=deepseek-app
TARGET=/opt/$APP
UNIT=/etc/systemd/system/$APP.service
ENV_FILE=/etc/deepseek-app.env
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
START=yes
TOKENIZER=yes

for arg in "$@"; do
  case $arg in
    --no-start) START=no ;;
    --skip-tokenizer) TOKENIZER=no ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Preconditions ------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo sh scripts/install-service.sh"
[ -f /etc/debian_version ] || warn "This does not look like Debian; continuing anyway."
[ -f "$SOURCE/package.json" ] && [ -f "$SOURCE/src/server.js" ] || die "Run this from the application checkout."
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required."

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  die "Node.js is not installed. Install Node.js 22 LTS, e.g.:
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs"
fi
# 20.12 is the first release with process.loadEnvFile(), which the app uses.
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
  || die "Node.js $("$NODE" --version) found at $NODE; version 20.12 or newer is required."
command -v npm >/dev/null 2>&1 || die "npm is not installed (it ships with the NodeSource nodejs package)."
say "Using Node.js $("$NODE" --version) at $NODE"

# --- 2. Service user ---------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  say "User $APP_USER exists"
else
  say "Creating system user $APP_USER"
  useradd --system --create-home --user-group --shell /usr/sbin/nologin "$APP_USER"
fi

# --- 3. Code -------------------------------------------------------------------------
say "Installing application into $TARGET"
mkdir -p "$TARGET"
if [ "$SOURCE" != "$TARGET" ]; then
  # Replace code only; never data/ or node_modules.
  for item in src public scripts systemd test package.json package-lock.json README.md .env.example .gitignore; do
    rm -rf "${TARGET:?}/$item"
    [ -e "$SOURCE/$item" ] && cp -a "$SOURCE/$item" "$TARGET/$item"
  done
  mkdir -p "$TARGET/vendor/deepseek-tokenizer"
  cp -a "$SOURCE/vendor/deepseek-tokenizer/." "$TARGET/vendor/deepseek-tokenizer/" 2>/dev/null || true
fi

# --- 4. Dependencies -----------------------------------------------------------------
say "Installing production dependencies"
(cd "$TARGET" && npm ci --omit=dev --no-audit --no-fund) \
  || die "npm ci failed in $TARGET. Fix the cause (usually no network or a proxy) and re-run this script; the service cannot start without node_modules."
# npm can exit 0 and still leave an unusable tree (an interrupted install, a
# half-copied directory). The service would then fail with ERR_MODULE_NOT_FOUND.
(cd "$TARGET" && "$NODE" -e "import('express')" >/dev/null 2>&1) \
  || die "Dependencies are missing in $TARGET/node_modules after npm ci. Run 'cd $TARGET && npm ci --omit=dev' by hand and check its output."
say "Dependencies OK"

# --- 5. Tokenizer ----------------------------------------------------------------------
if [ "$TOKENIZER" = yes ]; then
  say "Installing the DeepSeek tokenizer (exact token counts)"
  sh "$TARGET/scripts/fetch-tokenizer.sh" "$TARGET/vendor/deepseek-tokenizer" \
    || warn "Tokenizer download failed; the app shows estimated token counts. Retry: sh $TARGET/scripts/fetch-tokenizer.sh"
fi

# --- 6. Data files and configuration -----------------------------------------------------
say "Preparing $TARGET/data"
mkdir -p "$TARGET/data"
create_json() { # file, content — only when missing; existing data is never overwritten
  [ -e "$TARGET/data/$1" ] || printf '%s\n' "$2" > "$TARGET/data/$1"
}
create_json conversation.json '{ "messages": [] }'
create_json short-term-memory.json '{}'
create_json work-memory.json '{}'
create_json long-term-memory.json '{}'
create_json profile.json '{ "profile": null }'
create_json invariants.json '{ "invariants": [] }'
create_json tasks.json '{ "activeTaskId": null, "defaultMode": "manual", "tasks": [] }'

# Shared configuration: created once, never overwritten. systemd reads it as
# root before dropping privileges, so root-only permissions are enough.
if [ -f "$ENV_FILE" ]; then
  say "Using existing $ENV_FILE"
else
  say "Creating $ENV_FILE — set DEEPSEEK_API_KEY in it"
  (umask 077 && cat > "$ENV_FILE" <<'ENV'
# Shared configuration of the deepseek-app-dayNN services (EnvironmentFile=).
# Do not set PORT, HOST or DATA_DIR here: each service unit sets its own, and
# values from this file would override them for every service.
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
LOG_LEVEL=info
ENV
  )
fi
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(PORT|HOST|DATA_DIR)=' "$ENV_FILE"; then
  warn "$ENV_FILE sets PORT, HOST or DATA_DIR. It overrides the unit for every deepseek-app service, so $APP would not use port 3014 / its own data directory. Remove those lines."
fi
if [ -f "$TARGET/.env" ]; then
  warn "$TARGET/.env is ignored in production; the service reads $ENV_FILE. Move any settings you need there, then delete $TARGET/.env."
fi

# --- 7. Ownership and permissions -------------------------------------------------------
say "Setting ownership to $APP_USER"
chown -R "$APP_USER:$APP_USER" "$TARGET"
chmod 750 "$TARGET"
chmod 700 "$TARGET/data"
chmod 600 "$TARGET"/data/*.json

# --- 8. systemd ---------------------------------------------------------------------------
say "Installing $UNIT"
sed "s|^ExecStart=/usr/bin/node |ExecStart=$NODE |" "$TARGET/systemd/$APP.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable "$APP" >/dev/null
say "Enabled $APP (starts at boot)"

if ! grep -Eq '^DEEPSEEK_API_KEY=.+' "$ENV_FILE" || grep -Eq '^DEEPSEEK_API_KEY=your_api_key_here' "$ENV_FILE"; then
  warn "DEEPSEEK_API_KEY is not set in $ENV_FILE. The UI loads, but questions fail until it is set (then: systemctl restart $APP)."
fi

if [ "$START" = yes ]; then
  say "Starting $APP"
  systemctl restart "$APP"
  sleep 2
  systemctl --no-pager --lines=5 status "$APP" || true
  PORT=$(sed -n 's/^Environment=PORT=//p' "$UNIT" | tail -1)
  PORT=${PORT:-3014}
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
      say "Healthy: http://$(hostname -f 2>/dev/null || hostname):$PORT/"
    else
      warn "Health check failed. See: journalctl -u $APP -n 50"
    fi
  fi
else
  say "Not started (--no-start). Start with: systemctl start $APP"
fi
