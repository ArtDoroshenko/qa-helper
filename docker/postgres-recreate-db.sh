#!/bin/sh
set -eu

/usr/local/bin/validate-db-env

export PGPASSWORD="$POSTGRES_PASSWORD"

psql \
    --host 127.0.0.1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=app_db="$APP_DB_NAME" \
    --set=app_user="$APP_DB_USER" \
    --set=ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'app_db' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'app_db') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user') \gexec
SQL

psql \
    --host 127.0.0.1 \
    --username "$POSTGRES_USER" \
    --dbname "$APP_DB_NAME" \
    --set=app_user="$APP_DB_USER" \
    --set=ON_ERROR_STOP=1 <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user') \gexec
SQL
