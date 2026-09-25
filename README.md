# QA Helper

QA Helper is a Django application for personal QA notes, files, and saved tool results. The project is under active development.

## Requirements

- Python 3.13
- uv
- PostgreSQL 17

## Local setup

Create the virtual environment and install the locked dependencies:

```shell
uv sync
```

Create the local settings file:

```shell
cp .env.example .env
```

Replace the placeholder values in `.env`. Keep this file local; Git ignores it.

Start PostgreSQL, then open its interactive terminal:

```shell
psql -d postgres
```

Create a PostgreSQL role and database:

```sql
CREATE ROLE qa_helper_app WITH LOGIN;
\password qa_helper_app
CREATE DATABASE qa_helper OWNER qa_helper_app;
ALTER ROLE qa_helper_app CREATEDB;
```

The `CREATEDB` permission is used only to create the temporary database for automated tests. Exit `psql` with `\q`.

Apply the database migrations:

```shell
uv run python manage.py migrate
```

Create a local administrator for Django administration:

```shell
uv run python manage.py createsuperuser
```

## Run locally

Start the Django development server:

```shell
uv run python manage.py runserver
```

Open `http://127.0.0.1:8000/admin/`. Stop the server with `Control + C` in the terminal where it is running.

Account pages are available at:

- `http://127.0.0.1:8000/accounts/signup/`
- `http://127.0.0.1:8000/accounts/login/`
- `http://127.0.0.1:8000/accounts/email/`
- `http://127.0.0.1:8000/accounts/sessions/`

During local development, confirmation and password reset emails are printed in the terminal running the server. Production email delivery is configured separately.

## Demo deployment

The Docker Compose deployment for the demo VDS is documented in
[`DEPLOYMENT.md`](DEPLOYMENT.md). Public registration is disabled in the
production example; existing accounts can still sign in. Email continues to
use the console backend until SMTP is configured.

## Checks

Run the Django configuration checks and tests:

```shell
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
```
