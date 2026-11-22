#!/bin/sh
set -eu

umask 027

export DJANGO_SETTINGS_MODULE=config.settings DJANGO_PUBLIC_PRODUCTION=1

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

python manage.py collectstatic --noinput

exec gunicorn config.wsgi:application \
    --bind 0.0.0.0:8000 \
    --worker-class sync \
    --workers 1 \
    --threads 1 \
    --timeout 60 \
    --error-logfile -
