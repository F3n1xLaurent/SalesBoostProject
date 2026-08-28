#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[startup] DATABASE_URL is required" >&2
  exit 1
fi

echo "[startup] Checking Prisma migrations..."
# On a brand-new SQLite volume, create the database file before invoking the
# schema engine. Existing files are left untouched by `touch`.
case "$DATABASE_URL" in
  file:/data/*)
    sqlite_path=${DATABASE_URL#file:}
    sqlite_path=${sqlite_path%%\?*}
    touch "$sqlite_path"
    ;;
  file:*)
    echo "[startup] Production SQLite DATABASE_URL must point inside /data" >&2
    echo "[startup] Example: DATABASE_URL=file:/data/salesboost.db" >&2
    exit 1
    ;;
  *)
    echo "[startup] Unsupported DATABASE_URL for the SQLite Prisma schema" >&2
    exit 1
    ;;
esac

# `migrate deploy` is idempotent: Prisma reads `_prisma_migrations`, skips
# migrations already recorded there and applies only pending migrations.
./node_modules/.bin/prisma migrate deploy
echo "[startup] Database schema is up to date."

echo "[startup] Starting application..."
exec "$@"
