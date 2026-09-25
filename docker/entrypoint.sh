#!/bin/sh
set -eu

umask 027

if [ "${DJANGO_PRODUCTION:-}" != "True" ]; then
    echo "DJANGO_PRODUCTION=True is required for the production image." >&2
    exit 1
fi

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec gunicorn config.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers "${GUNICORN_WORKERS:-1}" \
    --threads "${GUNICORN_THREADS:-2}" \
    --timeout "${GUNICORN_TIMEOUT:-30}" \
    --access-logfile - \
    --error-logfile -
