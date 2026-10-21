#!/usr/bin/env bash
set -Eeuo pipefail

# Run on the production host after deploying the image that contains the
# read-only exporter. The resulting file remains on the host, never in a web
# directory or in the container's writable layer.
DIAGNOSTIC_PROJECT_DIR="${DIAGNOSTIC_PROJECT_DIR:-/srv/salesboost}"
DIAGNOSTIC_OUTPUT_DIR="${DIAGNOSTIC_OUTPUT_DIR:-/srv/backups/diagnostics}"
DIAGNOSTIC_COMPOSE_FILE="${DIAGNOSTIC_COMPOSE_FILE:-${DIAGNOSTIC_PROJECT_DIR}/compose.prod.yaml}"
DIAGNOSTIC_SERVICE="${DIAGNOSTIC_SERVICE:-app}"

usage() {
  echo "Использование: $0 <trainer|call> <ID> [--audio] [--turn N]" >&2
  echo "Пример: $0 trainer cmv123... --audio --turn 4" >&2
}

if (( $# < 2 )); then usage; exit 2; fi
diagnostic_kind="$1"
diagnostic_id="$2"
shift 2

if [[ "$diagnostic_kind" != trainer && "$diagnostic_kind" != call ]]; then usage; exit 2; fi
if [[ ! "$diagnostic_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  echo "Ошибка: передайте только ID, без URL или параметров запроса." >&2
  exit 2
fi
if [[ ! -f "$DIAGNOSTIC_COMPOSE_FILE" ]]; then
  echo "Ошибка: compose-файл не найден: $DIAGNOSTIC_COMPOSE_FILE" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "Ошибка: docker не найден." >&2; exit 1; }
command -v gzip >/dev/null || { echo "Ошибка: gzip не найден." >&2; exit 1; }

# Validate flags before creating a file. The Node exporter validates them too.
diagnostic_args=()
diagnostic_audio=false
diagnostic_turn=false
while (( $# > 0 )); do
  case "$1" in
    --audio)
      diagnostic_audio=true
      diagnostic_args+=("$1")
      shift
      ;;
    --turn)
      if (( $# < 2 )) || [[ ! "$2" =~ ^[1-9][0-9]*$ ]]; then usage; exit 2; fi
      diagnostic_turn=true
      diagnostic_args+=("$1" "$2")
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done
if [[ "$diagnostic_turn" == true ]] && { [[ "$diagnostic_kind" != trainer ]] || [[ "$diagnostic_audio" != true ]]; }; then
  echo "Ошибка: --turn используется только вместе с trainer --audio." >&2
  exit 2
fi

umask 077
mkdir -p -- "$DIAGNOSTIC_OUTPUT_DIR"
diagnostic_stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
diagnostic_name="${diagnostic_kind}-${diagnostic_id}-${diagnostic_stamp}.json.gz"
diagnostic_output="${DIAGNOSTIC_OUTPUT_DIR}/${diagnostic_name}"
if [[ -e "$diagnostic_output" ]]; then
  echo "Ошибка: файл уже существует: $diagnostic_output" >&2
  exit 1
fi
diagnostic_temp="$(mktemp "${DIAGNOSTIC_OUTPUT_DIR}/.${diagnostic_name}.XXXXXXXX.part")"
cleanup() { rm -f -- "$diagnostic_temp"; }
trap cleanup EXIT

docker compose \
  --project-directory "$DIAGNOSTIC_PROJECT_DIR" \
  -f "$DIAGNOSTIC_COMPOSE_FILE" \
  exec -T "$DIAGNOSTIC_SERVICE" \
  node dist/src/scripts/exportDiagnosticCase.js \
  "$diagnostic_kind" "$diagnostic_id" "${diagnostic_args[@]}" > "$diagnostic_temp"

gzip -t -- "$diagnostic_temp"
if [[ ! -s "$diagnostic_temp" ]]; then
  echo "Ошибка: пустой диагностический пакет." >&2
  exit 1
fi
mv -- "$diagnostic_temp" "$diagnostic_output"
trap - EXIT
echo "Готово: $diagnostic_output"
echo "Файл содержит данные разговора; передавайте его только по защищённому каналу."
