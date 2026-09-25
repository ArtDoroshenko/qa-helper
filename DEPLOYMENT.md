# Demo deployment

This configuration runs QA Helper on one Ubuntu 24.04 VDS with Docker Compose:

- Caddy terminates HTTPS and publishes only TCP ports 80 and 443.
- Gunicorn runs Django with one worker and two threads.
- PostgreSQL is reachable only from the internal Docker network. Its bootstrap
  administrator is separate from the restricted application role, and Django
  receives only the application credentials.
- Static files use a read-only volume in Caddy.
- Private uploads use a separate volume mounted only in Django. Caddy returns
  `404` for every `/media/*` request; authenticated downloads continue through
  Django views.

The Compose project does not refer to, stop, restart, or reconfigure Amnezia.
Its UDP port remains outside this stack.

## Server prerequisites

Point the domain to the VDS before starting Caddy. Confirm that inbound TCP 80
and 443 are allowed and free. Keep SSH access open. Do not change the existing
UDP firewall rule used by Amnezia.

For a 1 GiB server, create 1 GiB of swap before deployment. This is a separate
host operation and must be performed once by the server administrator:

```shell
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
swapon --show
free -h
```

Docker 29 with the Compose plugin must already be installed. Check the current
listeners without changing them:

```shell
docker --version
docker compose version
sudo ss -ltnp
```

## First start

Clone the public repository and switch to the approved revision:

```shell
git clone https://github.com/OWNER/qa-helper.git
cd qa-helper
git checkout APPROVED_COMMIT
```

Create the private production environment file:

```shell
cp .env.production.example .env.production
chmod 600 .env.production
python3 -c 'import secrets; print(secrets.token_urlsafe(64))'
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Put the first value in `DJANGO_SECRET_KEY`, the second in
`POSTGRES_ADMIN_PASSWORD`, and the third in
`DB_PASSWORD`. The admin and application passwords must differ. Replace
`ACME_EMAIL` with the certificate contact email. Keep
`DJANGO_PRODUCTION=True`, `DJANGO_DEBUG=False`, and
`DJANGO_ACCOUNT_ALLOW_SIGNUPS=False` for the demo. The production settings
reject startup when `DJANGO_SECRET_KEY` is a known placeholder, shorter than 50
characters, insufficiently varied, or uses Django's insecure prefix. They also
reject unsafe domain, HTTPS origin, proxy, cookies, redirect, HSTS, debug, or
signup values. Do not commit or paste `.env.production` into logs, issues, or
chat.

Validate the resolved Compose configuration without printing its secrets:

```shell
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build web
docker compose --env-file .env.production run --rm --no-deps web python manage.py check --deploy
```

With the supplied cautious HSTS settings, Django reports `security.W005` and
`security.W021`: subdomains and browser preload are deliberately disabled.
These are accepted for the first demo deployment. Other deployment warnings
must be resolved before starting the stack.

Build and start the stack:

```shell
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

On the first start of an empty PostgreSQL volume, the init script creates a
restricted `NOSUPERUSER` application role and an application-owned database.
The bootstrap administrator remains only in the database container. The web
entrypoint waits for an app-role database query to succeed, applies migrations,
collects static files, and then starts Gunicorn.

The role bootstrap runs only for an empty PostgreSQL volume. This demo has no
existing production volume. Do not expect changed environment values to rotate
roles or passwords in an already initialized volume.

Every database healthcheck validates that admin and app usernames differ,
passwords differ, both passwords are at least 24 characters, and neither uses
a known placeholder. The same guard runs during empty-volume initialization,
backup, restore, and database recreation. An invalid configuration keeps the
database unhealthy, so web and Caddy cannot start. Validation errors never
print credential values.

On a new database, create the first Django administrator interactively:

```shell
docker compose --env-file .env.production exec web python manage.py createsuperuser
```

Disabling public registration does not disable login for existing accounts.

## Health and logs

Check the public endpoint, service health, recent logs, and memory use:

```shell
curl --fail --silent --show-error https://qa-helper-artem.duckdns.org/healthz/
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 web caddy db
docker stats --no-stream
```

After ten minutes and again after exercising file upload and Base64 near their
limits, confirm that the VDS and Amnezia retain headroom without modifying the
VPN containers:

```shell
free -h
docker stats --no-stream
docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}' $(docker compose --env-file .env.production ps -q)
amnezia_ids=$(docker ps --filter name=amnezia -q)
if [ -n "$amnezia_ids" ]; then docker inspect --format '{{.Name}} Status={{.State.Status}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}' $amnezia_ids; fi
sudo journalctl -k --since '-15 minutes' | grep -Ei 'out of memory|oom-killer|killed process' || true
```

The configured memory ceilings are 256 MiB for PostgreSQL, 256 MiB for web,
and 96 MiB for Caddy. PostgreSQL uses 64 MiB shared buffers. The remaining RAM
and the separately configured swap are reserved for Ubuntu, Docker, and
Amnezia.

The health endpoint returns `200 ok` only while Django can query PostgreSQL.
Container JSON logs rotate at 10 MiB with three files per service.

The demo intentionally uses Django's console email backend. Confirmation and
password-reset messages appear only in `web` logs and are not delivered. This
is acceptable for a private demo account, but SMTP must be configured before
opening registration or relying on password recovery.

HSTS starts at one hour without `includeSubDomains` or preload. Increase it
only after HTTPS has remained stable and every relevant subdomain is ready.

## Backup

Create a backup before every update. Database and media backups form one set;
keep them together and copy them off the VDS. Back up `.env.production`
separately in a password manager or encrypted store. The backup script stops
Caddy and web before both snapshots and uses a trap to restart them on success,
failure, or interruption.

```shell
./docker/backup.sh .env.production backups
```

The script validates both archives before publishing their final names. A
successful archive listing checks readability; it does not replace a periodic
restore rehearsal.

## Restore

Choose matching database and media files:

```shell
./docker/restore.sh \
    .env.production \
    backups/SELECTED_DB.dump \
    backups/SELECTED_MEDIA.tar.gz \
    backups
```

Before stopping traffic, the restore script validates the database archive,
rejects unsafe media archive paths and links, and extracts media into a staging
volume. After stopping Caddy and web, it creates and validates a pre-restore
database/media safety set. It then drops and recreates the application database
with the restricted app owner, restores with the app role, and replaces live
media from the staged volume. On failure after services stop, they remain
stopped so mismatched data is not published; recover with the printed safety
set before restarting.

Verify `/healthz/`, login, one note, and one private attachment after restore.
Run restore rehearsal on a disposable copy before treating the backup process
as proven.

## Update

Create a backup, fetch the approved revision, rebuild the web image, and
reconcile the stack:

```shell
git fetch --tags
git checkout APPROVED_COMMIT
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build web
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

The entrypoint applies migrations automatically. Watch the first startup:

```shell
docker compose --env-file .env.production logs --tail=100 web
```

## Rollback

For a code-only rollback, check out the previous approved revision and rebuild:

```shell
git checkout PREVIOUS_APPROVED_COMMIT
docker compose --env-file .env.production build web
docker compose --env-file .env.production up -d
```

If the update changed the schema or stored data incompatibly, restore the
matching pre-update database and media backup instead of running old code on a
new schema. Keep `.env.production` unchanged unless the rollback instructions
explicitly require an environment change.

## Stop and start

These commands preserve all named volumes:

```shell
docker compose --env-file .env.production stop
docker compose --env-file .env.production start
docker compose --env-file .env.production down
```

Do not use `down -v` during routine operations because it deletes persistent
database, media, static, and certificate volumes.

## Residual hardening limits

The uv builder is pinned to an exact version and Caddy to the 2.10 line.
PostgreSQL and Python remain pinned to supported major/minor image lines rather
than unverified digests. Resolve and record tested image digests before a
higher-assurance release. Caddy has `no-new-privileges`, limited processes,
memory and CPU, and only TCP 80/443 published. Further capability or read-only
root-filesystem changes require an actual container start test because Caddy
must write certificates and runtime configuration to its data volumes.

Backup pairs currently share a timestamp in their filenames but do not have a
signed manifest, cryptographic set identifier, or checksum file. The scripts
also do not impose archive-size limits or preflight free disk space. Check
`df -h` before backup and restore, keep matching files together, copy them off
the VDS, and add manifests, checksums, and space gates before a higher-assurance
release.
