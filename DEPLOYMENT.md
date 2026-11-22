# QA Kit public deployment

`compose.yaml` runs Caddy in front of Gunicorn, which loads Django through `config.wsgi:application`. The application does not connect to PostgreSQL, run migrations, or mount a media volume.

## Before switching the VDS

Before switching to QA Kit, inventory the running containers and named volumes on the VDS. Identify which PostgreSQL and media volumes belong only to the previous QA Helper deployment and which resources belong to other services, including Amnezia. Preserve the old data until a separate, explicit cleanup step. Verify the approved code revision and the intended DNS/HTTPS configuration.

## Configuration

Copy `.env.production.example` to `.env.production` on the server. Set the domain, ACME email, long random Django secret key, allowed host, and HTTPS CSRF origin. The host and HTTPS origin must match `SITE_DOMAIN`. Leave `DJANGO_TRUST_X_FORWARDED_PROTO=1` so Django accepts the HTTPS scheme from Caddy on the internal connection. Compose fixes `DJANGO_PUBLIC_DEBUG=0`. The production entrypoint rejects invalid settings before Gunicorn starts.

## Request handling

Caddy limits backend request bodies to 16 MiB and gives the client 30 seconds to send the body. Django checks the declared size before form parsing. Multipart forms can use the full 16 MiB. URL-encoded forms are limited to 64 KiB, and the generator and field checks accept at most 8 KiB of JSON. Django uses only the in-memory upload handler. Caddy streams requests to a single synchronous Gunicorn worker and can return 503 while it is busy. The worker timeout is a separate backstop from Caddy's HTTP timeouts.

Base64 accepts up to 10 MiB before encoding or after decoding. The larger Base64 text file may be uploaded for decoding as long as the entire multipart request fits within 16 MiB. Base64 returns one attachment response. The browser retains it as a Blob on the page, shows at most the first 8 KiB of text, and previews static PNG and single-image JPEG up to 1 MiB after checking their metadata in the browser. The preview is limited to 4096 pixels per side and 8,388,608 pixels total. Conversion and downloads use the original bytes for all supported formats. JSON also has a bounded preview, with full copy and download in the browser. The application does not write request contents or results to persistent storage, and its responses use `Cache-Control: no-store`. These bounds describe application buffering and do not measure peak container memory.

## Feedback mailbox

Feedback is off by default. After the separate Security review, provision a dedicated SMTP mailbox with STARTTLS and an app password. In the private `.env.production`, set `QA_FEEDBACK_FROM` to the approved sender address, `QA_FEEDBACK_TO` to the owner's mailbox, and fill `QA_FEEDBACK_SMTP_HOST`, `QA_FEEDBACK_SMTP_PORT`, `QA_FEEDBACK_SMTP_USER` and `QA_FEEDBACK_SMTP_PASSWORD`. Set `QA_FEEDBACK_ENABLED=1` and recreate the web service during the approved deployment. The form stays hidden when required settings are missing or invalid.

The dialog accepts up to 3000 characters in a request body of up to 40 KiB. The plain text email includes the canonical path of the tool page and the submitted message. The site does not append the browser's URL parameters or the tool's inputs. The single web worker allows five send attempts per 15 minutes across all visitors, including failed attempts. The counter resets when the worker restarts. The SMTP socket timeout is five seconds. Feedback remains subject to the mailbox provider's retention settings. After activation, verify delivery with a non-sensitive test message.

## Start and verify

After approval and the VDS inventory, build and start the two public services with Docker Compose. If the previous deployment leaves the old `db` container running, locate it by the verified Compose project and service labels before stopping it. For a project confirmed as `qa-helper`, these read-only filters show the candidates:

```shell
docker ps --filter label=com.docker.compose.project=qa-helper --filter label=com.docker.compose.service=db
```

Inspect the candidate and confirm its mounts against the inventory. After the public web service is healthy, stop only the verified old database container with `docker stop <verified-container-id>`. Leave the container and its volumes available for rollback. Amnezia stays outside this operation.

Verify `/healthz/`, `/`, static files, HTTPS, CSRF and each tool. Include a Base64 download close to 10 MiB. Confirm old account, notes, materials, and save URLs return 404. Check that app logs contain neither request bodies nor user input. Visual and browser acceptance belongs to the user.
