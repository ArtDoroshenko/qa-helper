#!/bin/sh
set -eu

env_file=${1:-.env.production}
backup_dir=${2:-backups}

if [ ! -f "$env_file" ]; then
    echo "Environment file not found: $env_file" >&2
    exit 1
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_path=$(cd "$backup_dir" && pwd)
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
db_name="db-${backup_stamp}.dump"
media_name="media-${backup_stamp}.tar.gz"
db_temp="${backup_path}/.${db_name}.tmp"
media_temp=".${media_name}.tmp"
restart_required=0

compose() {
    docker compose --env-file "$env_file" "$@"
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    rm -f "$db_temp" "${backup_path}/${media_temp}"
    if [ "$restart_required" -eq 1 ]; then
        compose up -d web caddy >/dev/null 2>&1 || true
    fi
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

restart_required=1
compose stop caddy web
compose exec -T db /usr/local/bin/validate-db-env

compose exec -T db sh -ec \
    'PGPASSWORD="$APP_DB_PASSWORD" pg_dump --host 127.0.0.1 --username "$APP_DB_USER" --dbname "$APP_DB_NAME" --format=custom' \
    > "$db_temp"

docker run --rm \
    --entrypoint sh \
    -e BACKUP_NAME="$media_temp" \
    -v qa-helper_media_data:/source:ro \
    -v "$backup_path":/backup \
    caddy:2.10-alpine \
    -ec 'tar -czf "/backup/$BACKUP_NAME" -C /source .'

compose exec -T db pg_restore --list < "$db_temp" > /dev/null
docker run --rm \
    --entrypoint sh \
    -e BACKUP_NAME="$media_temp" \
    -v "$backup_path":/backup:ro \
    caddy:2.10-alpine \
    -ec 'tar -tzf "/backup/$BACKUP_NAME" > /dev/null'

mv "$db_temp" "${backup_path}/${db_name}"
mv "${backup_path}/${media_temp}" "${backup_path}/${media_name}"

compose up -d web caddy
restart_required=0
trap - EXIT HUP INT TERM

printf 'Database: %s\nMedia: %s\n' \
    "${backup_path}/${db_name}" \
    "${backup_path}/${media_name}"
