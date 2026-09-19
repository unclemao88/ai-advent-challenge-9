#!/bin/sh
# Back up the agent's local JSON data (memory, profile, invariants, tasks,
# chat history, storage configuration) into a timestamped archive.
#
#   sudo sh scripts/backup-data.sh [backup-directory]      # default: /var/backups/deepseek-app
#
# Every data file is written atomically, so a backup of a running service is
# consistent per file. For a snapshot that is consistent across files, stop
# the service first (systemctl stop deepseek-app) or pass --stop.
set -eu

DATA=${DATA_DIR:-/opt/deepseek-app-day15/data}
SERVICE=deepseek-app
STOP=no
DEST=/var/backups/deepseek-app
for arg in "$@"; do
  case $arg in
    --stop) STOP=yes ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) DEST=$arg ;;
  esac
done

[ -d "$DATA" ] || { echo "No data directory at $DATA (set DATA_DIR)." >&2; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"
ARCHIVE="$DEST/deepseek-app-day15-data-$(date +%Y%m%d-%H%M%S).tar.gz"

if [ "$STOP" = yes ]; then systemctl stop "$SERVICE"; fi
# Leftover temporary files of an interrupted write are not data.
(umask 077 && tar -czf "$ARCHIVE" -C "$(dirname "$DATA")" --exclude='*.tmp' "$(basename "$DATA")")
if [ "$STOP" = yes ]; then systemctl start "$SERVICE"; fi

echo "Backup written: $ARCHIVE"
tar -tzf "$ARCHIVE" | grep -c '\.json$' | xargs echo "JSON files:"
