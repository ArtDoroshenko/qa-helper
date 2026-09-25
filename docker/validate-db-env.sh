#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${APP_DB_NAME:?APP_DB_NAME is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

fail() {
    echo "Unsafe PostgreSQL role configuration: $1" >&2
    exit 1
}

is_placeholder() {
    normalized=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    case "$normalized" in
        replace-with-*|django-insecure-*|change-me*|changeme*|password*|example*)
            return 0
            ;;
    esac
    return 1
}

[ "$POSTGRES_USER" != "$APP_DB_USER" ] \
    || fail "admin and application usernames must differ"
[ "$POSTGRES_PASSWORD" != "$APP_DB_PASSWORD" ] \
    || fail "admin and application passwords must differ"
[ "${#POSTGRES_PASSWORD}" -ge 24 ] \
    || fail "admin password must be at least 24 characters"
[ "${#APP_DB_PASSWORD}" -ge 24 ] \
    || fail "application password must be at least 24 characters"
is_placeholder "$POSTGRES_PASSWORD" \
    && fail "admin password is a placeholder"
is_placeholder "$APP_DB_PASSWORD" \
    && fail "application password is a placeholder"

exit 0
