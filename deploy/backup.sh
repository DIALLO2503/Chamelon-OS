#!/bin/bash
# One backup run: database dump and photo archive into /backups, then removal of files older than KEEP_DAYS.
# Connection settings come from the standard PG* variables. A failed dump leaves no file behind.
set -euo pipefail
out=${BACKUP_DIR:-/backups}
uploads=${UPLOADS_DIR:-/uploads}
day=$(date +%F)
mkdir -p "$out"

pg_dump --no-owner | gzip > "$out/db-$day.sql.gz.tmp"
mv "$out/db-$day.sql.gz.tmp" "$out/db-$day.sql.gz"

if [ -d "$uploads" ]; then
  tar -czf "$out/uploads-$day.tar.gz.tmp" -C "$uploads" .
  mv "$out/uploads-$day.tar.gz.tmp" "$out/uploads-$day.tar.gz"
fi

find "$out" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.tmp' \) -mtime +"${KEEP_DAYS:-14}" -delete
echo "backup $day done: $(du -sh "$out" | cut -f1) in $out"
