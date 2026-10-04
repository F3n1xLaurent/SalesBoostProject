#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/srv/salesboost}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/compose.prod.yaml}"
SERVICE_NAME="${SERVICE_NAME:-app}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Ошибка: директория проекта не найдена: $PROJECT_DIR" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Ошибка: compose-файл не найден: $COMPOSE_FILE" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "Ошибка: команда docker не найдена." >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"

timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_name="salesboost-${timestamp}.db"
host_backup="${BACKUP_DIR}/${backup_name}"
host_tmp="${host_backup}.part"
container_dir="/data/.backup-tmp"
container_backup="${container_dir}/${backup_name}"

compose=(
  docker compose
  --project-directory "$PROJECT_DIR"
  -f "$COMPOSE_FILE"
)

cleanup() {
  "${compose[@]}" exec -T "$SERVICE_NAME" \
    rm -f -- "$container_backup" >/dev/null 2>&1 || true
  rm -f -- "$host_tmp"
}
trap cleanup EXIT INT TERM

running_services="$("${compose[@]}" ps --status running --services)"
if [[ $'\n'"$running_services"$'\n' != *$'\n'"$SERVICE_NAME"$'\n'* ]]; then
  echo "Ошибка: сервис '$SERVICE_NAME' не запущен." >&2
  exit 1
fi

if [[ -e "$host_backup" || -e "${host_backup}.sha256" ]]; then
  echo "Ошибка: файл резервной копии уже существует: $host_backup" >&2
  exit 1
fi

echo "Создаю согласованную копию SQLite..."
"${compose[@]}" exec -T "$SERVICE_NAME" mkdir -p -- "$container_dir"
"${compose[@]}" exec -T \
  -e SQLITE_BACKUP_PATH="$container_backup" \
  "$SERVICE_NAME" \
  node -e '
const { PrismaClient } = require("@prisma/client");

const backupPath = process.env.SQLITE_BACKUP_PATH;
if (!backupPath || !backupPath.startsWith("/data/.backup-tmp/")) {
  throw new Error("Invalid SQLITE_BACKUP_PATH");
}

const escapedPath = backupPath.replace(/\x27/g, "\x27\x27");
const prisma = new PrismaClient();

(async () => {
  await prisma.$executeRawUnsafe(`VACUUM INTO \x27${escapedPath}\x27`);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
'

echo "Проверяю целостность резервной копии..."
"${compose[@]}" exec -T \
  -e DATABASE_URL="file:${container_backup}" \
  "$SERVICE_NAME" \
  node -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRawUnsafe("PRAGMA integrity_check");
  const values = rows.flatMap((row) => Object.values(row)).map(String);
  if (values.length !== 1 || values[0].toLowerCase() !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(rows)}`);
  }
  console.log("SQLite integrity_check: ok");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
'

echo "Копирую backup в $BACKUP_DIR..."
"${compose[@]}" cp "${SERVICE_NAME}:${container_backup}" "$host_tmp"

if [[ ! -s "$host_tmp" ]]; then
  echo "Ошибка: получен пустой файл резервной копии." >&2
  exit 1
fi

mv -- "$host_tmp" "$host_backup"
chmod 600 "$host_backup"

(
  cd "$BACKUP_DIR"
  sha256sum "$backup_name" > "${backup_name}.sha256"
  chmod 600 "${backup_name}.sha256"
)

backup_size="$(stat -c '%s' "$host_backup")"

echo "Готово."
echo "Backup: $host_backup"
echo "Размер: $backup_size байт"
echo "SHA-256: ${host_backup}.sha256"
