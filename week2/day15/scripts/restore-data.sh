#!/bin/sh
# Restore the agent's JSON data from an archive made by backup-data.sh.
#
#   sudo sh scripts/restore-data.sh /var/backups/deepseek-app/deepseek-app-day15-data-YYYYMMDD-HHMMSS.tar.gz
#
# Stops the service, moves the current data/ aside (data.before-restore-<time>,
# never deleted), unpacks the archive, restores ownership and permissions,
# and starts the service again.
set -eu

ARCHIVE=${1:-}
DATA=${DATA_DIR:-/opt/deepseek-app-day15/data}
SERVICE=deepseek-app
APP_USER=deepseek-app

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "Usage: sh scripts/restore-data.sh <archive.tar.gz>" >&2; exit 2; }
tar -tzf "$ARCHIVE" | grep -q '^data/' || { echo "$ARCHIVE does not contain a data/ directory." >&2; exit 1; }
if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "$ARCHIVE contains unsafe paths; refusing to unpack it." >&2
  exit 1
fi

systemctl stop "$SERVICE" 2>/dev/null || true
if [ -d "$DATA" ]; then
  ASIDE="$DATA.before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$DATA" "$ASIDE"
  echo "Current data moved to $ASIDE"
fi
tar -xzf "$ARCHIVE" -C "$(dirname "$DATA")"
chown -R "$APP_USER:$APP_USER" "$DATA"
find "$DATA" -type d -exec chmod 700 {} +
find "$DATA" -type f -exec chmod 600 {} +
systemctl start "$SERVICE"
echo "Restored $DATA from $ARCHIVE; $SERVICE started."
