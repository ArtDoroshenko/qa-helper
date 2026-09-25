import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase
from django.urls import reverse


class ProductionSettingsTests(SimpleTestCase):
    def _production_environment(self):
        environment = os.environ.copy()
        environment.update(
            {
                "DJANGO_PRODUCTION": "True",
                "SITE_DOMAIN": "qa-helper-artem.duckdns.org",
                "DJANGO_SECRET_KEY": "deploy-check-secret-with-more-than-fifty-unique-characters-1234567890",
                "DJANGO_DEBUG": "False",
                "DJANGO_ALLOWED_HOSTS": "qa-helper-artem.duckdns.org",
                "DJANGO_CSRF_TRUSTED_ORIGINS": "https://qa-helper-artem.duckdns.org",
                "DJANGO_ACCOUNT_ALLOW_SIGNUPS": "False",
                "DJANGO_SECURE_SSL_REDIRECT": "True",
                "DJANGO_SESSION_COOKIE_SECURE": "True",
                "DJANGO_CSRF_COOKIE_SECURE": "True",
                "DJANGO_SECURE_HSTS_SECONDS": "3600",
                "DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS": "False",
                "DJANGO_SECURE_HSTS_PRELOAD": "False",
                "DJANGO_TRUST_X_FORWARDED_PROTO": "True",
                "DB_NAME": "qa_helper",
                "DB_USER": "qa_helper_app",
                "DB_PASSWORD": "not-a-real-password",
                "DB_HOST": "db",
                "DB_PORT": "5432",
            }
        )
        return environment

    def _load_production_settings(self, environment):
        script = """
import json
from config import settings
print(json.dumps({
    "debug": settings.DEBUG,
    "hosts": settings.ALLOWED_HOSTS,
    "csrf_origins": settings.CSRF_TRUSTED_ORIGINS,
    "signups": settings.ACCOUNT_ALLOW_SIGNUPS,
    "ssl_redirect": settings.SECURE_SSL_REDIRECT,
    "session_secure": settings.SESSION_COOKIE_SECURE,
    "csrf_secure": settings.CSRF_COOKIE_SECURE,
    "hsts": settings.SECURE_HSTS_SECONDS,
    "hsts_subdomains": settings.SECURE_HSTS_INCLUDE_SUBDOMAINS,
    "hsts_preload": settings.SECURE_HSTS_PRELOAD,
    "proxy": settings.SECURE_PROXY_SSL_HEADER,
    "static_root": str(settings.STATIC_ROOT),
}))
"""
        return subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_production_environment_enables_proxy_and_cookie_security(self):
        completed = self._load_production_settings(self._production_environment())
        self.assertEqual(completed.returncode, 0, completed.stderr)
        values = json.loads(completed.stdout)

        self.assertFalse(values["debug"])
        self.assertEqual(values["hosts"], ["qa-helper-artem.duckdns.org"])
        self.assertEqual(
            values["csrf_origins"],
            ["https://qa-helper-artem.duckdns.org"],
        )
        self.assertFalse(values["signups"])
        self.assertTrue(values["ssl_redirect"])
        self.assertTrue(values["session_secure"])
        self.assertTrue(values["csrf_secure"])
        self.assertEqual(values["hsts"], 3600)
        self.assertFalse(values["hsts_subdomains"])
        self.assertFalse(values["hsts_preload"])
        self.assertEqual(values["proxy"], ["HTTP_X_FORWARDED_PROTO", "https"])
        self.assertTrue(values["static_root"].endswith("staticfiles"))

    def test_unsafe_production_environment_stops_settings_import(self):
        example_values = dict(
            line.split("=", 1)
            for line in Path(".env.production.example").read_text().splitlines()
            if line and not line.startswith("#")
        )
        unsafe_values = (
            ("DJANGO_SECRET_KEY", example_values["DJANGO_SECRET_KEY"]),
            ("DJANGO_SECRET_KEY", "a" * 64),
            ("DJANGO_SECRET_KEY", "django-insecure-" + "varied-value-1234567890" * 3),
            ("SITE_DOMAIN", ""),
            ("DJANGO_DEBUG", "True"),
            ("DJANGO_ACCOUNT_ALLOW_SIGNUPS", "True"),
            ("DJANGO_ALLOWED_HOSTS", "qa-helper-artem.duckdns.org,example.com"),
            ("DJANGO_CSRF_TRUSTED_ORIGINS", "http://qa-helper-artem.duckdns.org"),
            ("DJANGO_SECURE_SSL_REDIRECT", "False"),
            ("DJANGO_SESSION_COOKIE_SECURE", "False"),
            ("DJANGO_CSRF_COOKIE_SECURE", "False"),
            ("DJANGO_TRUST_X_FORWARDED_PROTO", "False"),
            ("DJANGO_SECURE_HSTS_SECONDS", "0"),
        )
        for variable, value in unsafe_values:
            with self.subTest(variable=variable):
                environment = self._production_environment()
                environment[variable] = value
                completed = self._load_production_settings(environment)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("Unsafe production configuration", completed.stderr)

    def test_production_entrypoint_requires_explicit_marker(self):
        environment = os.environ.copy()
        environment.pop("DJANGO_PRODUCTION", None)

        missing = subprocess.run(
            ["sh", "docker/entrypoint.sh", "true"],
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("DJANGO_PRODUCTION=True is required", missing.stderr)

        environment["DJANGO_PRODUCTION"] = "True"
        enabled = subprocess.run(
            ["sh", "docker/entrypoint.sh", "true"],
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertEqual(enabled.returncode, 0, enabled.stderr)

    def _database_environment(self):
        environment = os.environ.copy()
        environment.update(
            {
                "POSTGRES_USER": "qa_helper_admin",
                "POSTGRES_PASSWORD": "admin-secret-29Aq7mL4xP8vK2sR",
                "APP_DB_NAME": "qa_helper",
                "APP_DB_USER": "qa_helper_app",
                "APP_DB_PASSWORD": "application-secret-83Mx4pQ9vT2k",
            }
        )
        return environment

    def _validate_database_environment(self, environment):
        return subprocess.run(
            ["sh", "docker/validate-db-env.sh"],
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_database_role_guard_accepts_separate_strong_credentials(self):
        completed = self._validate_database_environment(
            self._database_environment()
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_database_role_guard_rejects_unsafe_runtime_credentials(self):
        example_values = dict(
            line.split("=", 1)
            for line in Path(".env.production.example").read_text().splitlines()
            if line and not line.startswith("#")
        )
        cases = (
            ("same username", {"APP_DB_USER": "qa_helper_admin"}),
            (
                "same password",
                {"APP_DB_PASSWORD": "admin-secret-29Aq7mL4xP8vK2sR"},
            ),
            (
                "admin placeholder",
                {"POSTGRES_PASSWORD": example_values["POSTGRES_ADMIN_PASSWORD"]},
            ),
            (
                "app placeholder",
                {"APP_DB_PASSWORD": example_values["DB_PASSWORD"]},
            ),
            ("short admin password", {"POSTGRES_PASSWORD": "too-short"}),
            ("short app password", {"APP_DB_PASSWORD": "too-short"}),
        )
        for label, overrides in cases:
            with self.subTest(label=label):
                environment = self._database_environment()
                environment.update(overrides)
                completed = self._validate_database_environment(environment)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("Unsafe PostgreSQL role configuration", completed.stderr)
                for secret in (
                    environment["POSTGRES_PASSWORD"],
                    environment["APP_DB_PASSWORD"],
                ):
                    self.assertNotIn(secret, completed.stderr)

    def test_database_role_guard_runs_on_init_and_existing_volume_paths(self):
        for filename in (
            "docker/postgres-init.sh",
            "docker/postgres-recreate-db.sh",
            "docker/backup.sh",
            "docker/restore.sh",
        ):
            with self.subTest(filename=filename):
                self.assertIn(
                    "/usr/local/bin/validate-db-env",
                    Path(filename).read_text(),
                )

        compose = Path("compose.yaml").read_text()
        db_section = compose.split("  db:", 1)[1].split("  web:", 1)[0]
        self.assertIn(
            "/usr/local/bin/validate-db-env && PGPASSWORD=",
            db_section,
        )

    def test_compose_keeps_admin_credentials_out_of_web_and_media_out_of_caddy(self):
        compose = Path("compose.yaml").read_text()
        web_section = compose.split("  web:", 1)[1].split("  caddy:", 1)[0]
        caddy_section = compose.split("  caddy:", 1)[1].split("networks:", 1)[0]

        self.assertNotIn("POSTGRES_ADMIN_USER", web_section)
        self.assertNotIn("POSTGRES_ADMIN_PASSWORD", web_section)
        self.assertIn("DB_USER:", web_section)
        self.assertIn("DB_PASSWORD:", web_section)
        self.assertNotIn("media_data", caddy_section)

        values = dict(
            line.split("=", 1)
            for line in Path(".env.production.example").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertNotEqual(values["POSTGRES_ADMIN_USER"], values["DB_USER"])


class HealthcheckTests(TestCase):
    def test_healthcheck_reports_ready_database(self):
        response = self.client.get(reverse("healthcheck"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"ok")

    @patch("config.views.connection.cursor", side_effect=DatabaseError)
    def test_healthcheck_reports_database_failure(self, cursor):
        response = self.client.get(reverse("healthcheck"))

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.content, b"unavailable")
