#!/bin/sh
set -eu

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "Usage: docker/restore.sh ENV_FILE DB_DUMP MEDIA_ARCHIVE [SAFETY_DIR]" >&2
    exit 1
fi

env_file=$1
db_archive=$2
media_archive=$3
safety_dir=${4:-backups}

for required_file in "$env_file" "$db_archive" "$media_archive"; do
    if [ ! -r "$required_file" ]; then
        echo "Required file is not readable: $required_file" >&2
        exit 1
    fi
done

db_archive_path=$(cd "$(dirname "$db_archive")" && pwd)/$(basename "$db_archive")
media_archive_dir=$(cd "$(dirname "$media_archive")" && pwd)
media_archive_name=$(basename "$media_archive")
mkdir -p "$safety_dir"
chmod 700 "$safety_dir"
safety_path=$(cd "$safety_dir" && pwd)
restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage_volume="qa-helper_media_restore_${restore_stamp}"
services_stopped=0

compose() {
    docker compose --env-file "$env_file" "$@"
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    docker volume rm -f "$stage_volume" >/dev/null 2>&1 || true
    if [ "$status" -ne 0 ] && [ "$services_stopped" -eq 1 ]; then
        echo "Restore failed; web and caddy remain stopped. Use the pre-restore safety set before restarting." >&2
    fi
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

compose exec -T db /usr/local/bin/validate-db-env
compose exec -T db pg_restore --list < "$db_archive_path" > /dev/null
python3 - "$media_archive" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath

with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe archive path: {member.name}")
        if member.issym() or member.islnk() or member.isdev():
            raise SystemExit(f"Unsupported archive entry: {member.name}")
PY

docker volume create "$stage_volume" > /dev/null
docker run --rm \
    --entrypoint sh \
    -e ARCHIVE_NAME="$media_archive_name" \
    -v "$stage_volume":/target \
    -v "$media_archive_dir":/backup:ro \
    caddy:2.10-alpine \
    -ec 'tar -xzf "/backup/$ARCHIVE_NAME" -C /target; tar -czf /tmp/staged.tar.gz -C /target .; tar -tzf /tmp/staged.tar.gz > /dev/null'

services_stopped=1
compose stop caddy web

safety_db="${safety_path}/pre-restore-db-${restore_stamp}.dump"
safety_media="pre-restore-media-${restore_stamp}.tar.gz"
compose exec -T db sh -ec \
    'PGPASSWORD="$APP_DB_PASSWORD" pg_dump --host 127.0.0.1 --username "$APP_DB_USER" --dbname "$APP_DB_NAME" --format=custom' \
    > "$safety_db"
docker run --rm \
    --entrypoint sh \
    -e BACKUP_NAME="$safety_media" \
    -v qa-helper_media_data:/source:ro \
    -v "$safety_path":/backup \
    caddy:2.10-alpine \
    -ec 'tar -czf "/backup/$BACKUP_NAME" -C /source .'
compose exec -T db pg_restore --list < "$safety_db" > /dev/null
tar -tzf "${safety_path}/${safety_media}" > /dev/null

compose exec -T db sh /usr/local/bin/recreate-app-db
compose exec -T db sh -ec \
    'PGPASSWORD="$APP_DB_PASSWORD" pg_restore --host 127.0.0.1 --username "$APP_DB_USER" --dbname "$APP_DB_NAME" --no-owner --no-privileges' \
    < "$db_archive_path"

docker run --rm \
    --entrypoint sh \
    -v "$stage_volume":/source:ro \
    -v qa-helper_media_data:/target \
    caddy:2.10-alpine \
    -ec 'rm -rf /target/* /target/.[!.]* /target/..?*; cp -a /source/. /target/'

compose up -d web caddy
services_stopped=0
trap - EXIT HUP INT TERM
docker volume rm -f "$stage_volume" > /dev/null

printf 'Restore completed. Safety database: %s\nSafety media: %s\n' \
    "$safety_db" \
    "${safety_path}/${safety_media}"
