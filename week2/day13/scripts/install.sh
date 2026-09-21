#!/bin/sh
# Install or update the DeepSeek Agent (day 13) on Debian.
#
#   sudo sh scripts/install.sh [--no-start] [--skip-tokenizer]
#
# Run it from a checkout of this directory. It is idempotent: running it again
# updates the code and dependencies and keeps data/, logs/ and .env untouched.
#
# What it does:
#   1. checks for root, Debian and Node.js >= 22
#   2. creates the system user and group "deepseek-app" (no login, no home)
#   3. copies the application to /opt/deepseek-app-day13
#   4. installs production dependencies (npm ci --omit=dev)
#   5. downloads the DeepSeek tokenizer for exact token counts
#   6. creates data/ and logs/, and .env from .env.example if missing
#   7. gives everything to deepseek-app (data, logs, .env: owner-only)
#   8. installs, enables and (re)starts the systemd service
set -eu

APP=deepseek-app-day13
APP_USER=deepseek-app
TARGET=/opt/$APP
UNIT=/etc/systemd/system/$APP.service
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
START=yes
TOKENIZER=yes

for arg in "$@"; do
  case $arg in
    --no-start) START=no ;;
    --skip-tokenizer) TOKENIZER=no ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Preconditions ----------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo sh scripts/install.sh)."
[ -f /etc/debian_version ] || warn "This does not look like Debian; continuing anyway."
[ -f "$SOURCE/package.json" ] && [ -f "$SOURCE/src/server/index.js" ] || die "Run this from the application checkout."

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  die "Node.js is not installed. Debian's own package is too old; install Node.js 22 LTS, e.g.:
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs"
fi
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $("$NODE" --version) found at $NODE; version 22 or newer is required."
command -v npm >/dev/null 2>&1 || die "npm is not installed (it ships with the NodeSource nodejs package)."
say "Using Node.js $("$NODE" --version) at $NODE"

# --- 2. Service user -------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  say "User $APP_USER exists"
else
  say "Creating system user $APP_USER"
  useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# --- 3. Code ---------------------------------------------------------------------
say "Copying application to $TARGET"
mkdir -p "$TARGET"
if [ "$SOURCE" != "$TARGET" ]; then
  # Replace code only; never touch data/, logs/, .env or node_modules.
  for item in src public scripts systemd package.json package-lock.json README.md .env.example; do
    if [ -e "$SOURCE/$item" ]; then
      rm -rf "${TARGET:?}/$item"
      cp -a "$SOURCE/$item" "$TARGET/$item"
    fi
  done
  [ -f "$TARGET/package-lock.json" ] || die "package-lock.json is missing. npm ci needs it; copy the complete checkout."
  mkdir -p "$TARGET/vendor/deepseek-tokenizer"
  if [ -f "$SOURCE/vendor/deepseek-tokenizer/tokenizer.json" ]; then
    cp -a "$SOURCE/vendor/deepseek-tokenizer/." "$TARGET/vendor/deepseek-tokenizer/"
  fi
fi

# --- 4. Dependencies ---------------------------------------------------------------
say "Installing production dependencies"
if ! (cd "$TARGET" && npm ci --omit=dev --no-audit --no-fund); then
  die "npm ci failed in $TARGET. It must reach the npm registry (behind a proxy, set https_proxy).
Without node_modules the service cannot start: Cannot find package 'express'."
fi
# npm can exit 0 and still leave nothing usable (an interrupted run, a stale
# cache, a wrong directory). The service would then fail with
# ERR_MODULE_NOT_FOUND at startup, so verify before installing the unit.
for pkg in express @huggingface/tokenizers; do
  [ -d "$TARGET/node_modules/$pkg" ] || die "node_modules/$pkg is missing after npm ci. Run 'npm ci --omit=dev' in $TARGET."
done

# --- 5. Tokenizer ------------------------------------------------------------------
if [ "$TOKENIZER" = yes ]; then
  say "Installing the DeepSeek tokenizer"
  sh "$TARGET/scripts/fetch-tokenizer.sh" "$TARGET/vendor/deepseek-tokenizer" \
    || warn "Tokenizer download failed; the app will show estimated token counts. Re-run: sh $TARGET/scripts/fetch-tokenizer.sh"
fi

# --- 6. Data, logs, configuration ----------------------------------------------------
say "Preparing data and log directories"
for dir in data data/short-term data/work-memory data/long-term data/profiles data/tasks data/config logs; do
  mkdir -p "$TARGET/$dir"
done
if [ ! -f "$TARGET/.env" ]; then
  say "Creating $TARGET/.env from .env.example (add DEEPSEEK_API_KEY)"
  cp "$TARGET/.env.example" "$TARGET/.env"
fi

# --- 7. Ownership and permissions ----------------------------------------------------
say "Setting ownership to $APP_USER"
chown -R "$APP_USER:$APP_USER" "$TARGET"
chmod 750 "$TARGET"
chmod 700 "$TARGET/data" "$TARGET/logs"
chmod 600 "$TARGET/.env"

# --- 8. systemd ------------------------------------------------------------------------
say "Installing $UNIT"
sed "s|^ExecStart=/usr/bin/node |ExecStart=$NODE |" "$TARGET/systemd/$APP.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable "$APP" >/dev/null

KEY_SET=no
grep -Eq '^DEEPSEEK_API_KEY=.+' "$TARGET/.env" 2>/dev/null && KEY_SET=yes
grep -Eq '^DEEPSEEK_API_KEY=.+' /etc/deepseek-app.env 2>/dev/null && KEY_SET=yes
[ "$KEY_SET" = yes ] || warn "DEEPSEEK_API_KEY is not set in $TARGET/.env or /etc/deepseek-app.env. The UI will load, but questions fail until it is."

if [ "$START" = yes ]; then
  say "Restarting $APP"
  systemctl restart "$APP"
  sleep 2
  systemctl --no-pager --lines=5 status "$APP" || true
  PORT=$(sed -n 's/^Environment=PORT=//p' "$UNIT" | tail -1)
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT:-3013}/api/health" >/dev/null; then
      say "Healthy: http://$(hostname -f 2>/dev/null || hostname):${PORT:-3013}/"
    else
      warn "Health check failed. See: journalctl -u $APP -n 50"
    fi
  fi
else
  say "Not started (--no-start). Start with: systemctl start $APP"
fi
