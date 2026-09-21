#!/bin/sh
# Install or update the DeepSeek Agent (day 15) on Debian as the systemd
# service "deepseek-app".
#
#   sudo sh scripts/install-service.sh [--no-start] [--skip-tokenizer]
#
# Run it from a checkout of this directory (or from /opt/deepseek-app-day15
# itself). It is idempotent: running it again updates code and dependencies
# and never touches data/ or an existing /etc/deepseek-app.env.
#
#   1. checks for root, systemd and Node.js >= 20 (and finds the node binary)
#   2. creates the system user "deepseek-app" if it is missing
#   3. copies the application into /opt/deepseek-app-day15
#   4. installs production dependencies (npm ci --omit=dev)
#   5. downloads the DeepSeek tokenizer for exact token counts (optional)
#   6. creates data/ with its JSON structure (missing files only), and
#      /etc/deepseek-app.env (root-only) if it does not exist
#   7. permissions: code root:deepseek-app read-only; data/ deepseek-app only
#   8. installs /etc/tmpfiles.d/deepseek-app-day15.conf (recreates data/ at boot)
#      and /etc/systemd/system/<service>.service (default deepseek-app, override
#      with SERVICE_NAME=) with the real node path, runs systemctl daemon-reload,
#      enables and (re)starts the service
set -eu

# The unit name. Override to follow another convention, e.g.
#   sudo SERVICE_NAME=deepseek-app-day15 sh scripts/install-service.sh
SERVICE=${SERVICE_NAME:-deepseek-app}
APP_USER=deepseek-app
TARGET=/opt/deepseek-app-day15
PORT=3015
UNIT=/etc/systemd/system/$SERVICE.service
TMPFILES=/etc/tmpfiles.d/deepseek-app-day15.conf
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
NODE=$(readlink -f "$NODE")
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $("$NODE" --version) found at $NODE; version 20 or newer is required."
command -v npm >/dev/null 2>&1 || die "npm is not installed (it ships with the NodeSource nodejs package)."
case $NODE in
  /root/*|/home/*) die "Node.js at $NODE is inside a home directory, which the service cannot read (ProtectHome). Install a system-wide Node.js." ;;
esac
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
(cd "$TARGET" && npm ci --omit=dev --no-audit --no-fund)

# --- 5. Tokenizer ----------------------------------------------------------------------
if [ "$TOKENIZER" = yes ]; then
  say "Installing the DeepSeek tokenizer (exact token counts)"
  sh "$TARGET/scripts/fetch-tokenizer.sh" "$TARGET/vendor/deepseek-tokenizer" \
    || warn "Tokenizer download failed; the app shows estimated token counts. Retry: sh $TARGET/scripts/fetch-tokenizer.sh"
fi

# --- 6. Data structure and configuration --------------------------------------------------
say "Preparing $TARGET/data"
for dir in memory profile invariants tasks history config; do
  mkdir -p "$TARGET/data/$dir"
done
create_json() { # file, content — only when missing; existing data is never overwritten
  [ -e "$TARGET/data/$1" ] || printf '%s\n' "$2" > "$TARGET/data/$1"
}
create_json memory/short-term.json '{}'
create_json memory/work-memory.json '{}'
create_json memory/long-term.json '{}'
create_json profile/profile.json '{ "profile": null }'
create_json invariants/invariants.json '{ "architecture": [], "technicalSolutions": [], "stackLimitations": [], "businessRules": [] }'
create_json tasks/active.json '{ "activeTaskId": null, "defaultMode": "manual" }'
create_json history/chat-history.json '{ "messages": [] }'
# data/config/memory-storage.json is written by the app on first start (from STORAGE_* variables).

# Shared configuration: created once, never overwritten. systemd reads it as
# root before dropping privileges, so root-only permissions are enough.
if [ -f "$ENV_FILE" ]; then
  say "Using existing $ENV_FILE"
  if [ -n "$(find "$ENV_FILE" -perm /o=rwx 2>/dev/null)" ]; then
    chmod o-rwx "$ENV_FILE"
    warn "$ENV_FILE was readable by other users; removed their access (it holds the API key)."
  fi
else
  say "Creating $ENV_FILE (root, 0600) — set DEEPSEEK_API_KEY in it"
  (umask 077 && cat > "$ENV_FILE" <<'ENV'
# Shared configuration of the deepseek-app services (systemd EnvironmentFile=).
# Do not set PORT, HOST or DATA_DIR here: each unit sets its own, and values
# from this file would override them.
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
LOG_LEVEL=info
ENV
  )
  chown root:root "$ENV_FILE"
fi
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(PORT|HOST|DATA_DIR)=' "$ENV_FILE"; then
  warn "$ENV_FILE sets PORT, HOST or DATA_DIR. Values there override the unit, so $SERVICE would not use port $PORT / $TARGET/data. Remove those lines."
fi
if [ -f "$TARGET/.env" ]; then
  warn "$TARGET/.env is ignored in production; the service reads $ENV_FILE. Move any settings you need there, then delete $TARGET/.env."
fi

# --- 7. Ownership and permissions -------------------------------------------------------
# The service user can read the code but not change it; it owns only data/.
say "Setting permissions (code: root:$APP_USER read-only; data/: $APP_USER only)"
chown -R root:"$APP_USER" "$TARGET"
chmod -R u=rwX,g=rX,o= "$TARGET"
chown -R "$APP_USER:$APP_USER" "$TARGET/data"
find "$TARGET/data" -type d -exec chmod 700 {} +
find "$TARGET/data" -type f -exec chmod 600 {} +

# --- 8. systemd ---------------------------------------------------------------------------
if [ -f "$UNIT" ] && ! grep -q "^WorkingDirectory=$TARGET\$" "$UNIT"; then
  BACKUP="$UNIT.bak-$(date +%Y%m%d%H%M%S)"
  cp -a "$UNIT" "$BACKUP"
  warn "$UNIT belonged to another installation ($(sed -n 's/^WorkingDirectory=//p' "$UNIT")). Saved it as $BACKUP."
fi
# systemd-tmpfiles recreates the data directory before the services start at
# every boot, so the unit's ReadWritePaths= can always be mounted.
say "Installing $TMPFILES"
cp "$TARGET/systemd/tmpfiles.conf" "$TMPFILES"
chmod 644 "$TMPFILES"
systemd-tmpfiles --create "$TMPFILES" || warn "systemd-tmpfiles could not apply $TMPFILES."

say "Installing $UNIT"
sed "s|^ExecStart=/usr/bin/node |ExecStart=$NODE |" "$TARGET/systemd/deepseek-app.service" > "$UNIT"
chmod 644 "$UNIT"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT" || warn "systemd-analyze reported problems with $UNIT (see above)."
fi
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
say "Enabled $SERVICE (starts at boot)"

if ! grep -Eq '^DEEPSEEK_API_KEY=.+' "$ENV_FILE" || grep -Eq '^DEEPSEEK_API_KEY=your_api_key_here' "$ENV_FILE"; then
  warn "DEEPSEEK_API_KEY is not set in $ENV_FILE. The UI loads, but questions fail until it is set (then: systemctl restart $SERVICE)."
fi

if [ "$START" = yes ]; then
  say "Starting $SERVICE"
  systemctl restart "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=5 status "$SERVICE" || true
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
      say "Healthy: http://$(hostname -f 2>/dev/null || hostname):$PORT/"
    else
      warn "Health check failed. See: journalctl -u $SERVICE -n 50"
    fi
  fi
else
  say "Not started (--no-start). Start with: systemctl start $SERVICE"
fi
