"""Default stateless settings for the public site."""

import os
import secrets
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import DomainNameValidator, validate_email


BASE_DIR = Path(__file__).resolve().parent.parent
debug_value = os.environ.get("DJANGO_PUBLIC_DEBUG", os.environ.get("DJANGO_DEBUG", "0")).lower()
if os.environ.get("DJANGO_PUBLIC_PRODUCTION") == "1" and debug_value not in {"0", "false"}:
    raise ImproperlyConfigured("Production requires DJANGO_PUBLIC_DEBUG=0.")
DEBUG = debug_value in {"1", "true"}
SECRET_KEY = os.environ.get("DJANGO_PUBLIC_SECRET_KEY") or os.environ.get("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("DJANGO_PUBLIC_SECRET_KEY is required outside local debug mode.")
    SECRET_KEY = secrets.token_urlsafe(48)
if not DEBUG and (len(SECRET_KEY) < 50 or SECRET_KEY.startswith("replace-") or SECRET_KEY.startswith("django-insecure-")):
    raise ImproperlyConfigured("Set a long random Django secret key for the public site.")

ALLOWED_HOSTS = [host.strip() for host in os.environ.get("DJANGO_PUBLIC_ALLOWED_HOSTS", os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")).split(",") if host.strip()]
CSRF_TRUSTED_ORIGINS = [origin.strip() for origin in os.environ.get("DJANGO_PUBLIC_CSRF_TRUSTED_ORIGINS", os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "")).split(",") if origin.strip()]
if os.environ.get("DJANGO_PUBLIC_PRODUCTION") == "1":
    site_domain = os.environ.get("SITE_DOMAIN", "")
    try:
        DomainNameValidator(accept_idna=False)(site_domain)
    except ValidationError as error:
        raise ImproperlyConfigured("Set SITE_DOMAIN to a DNS hostname.") from error
    if ALLOWED_HOSTS != [site_domain] or CSRF_TRUSTED_ORIGINS != [f"https://{site_domain}"]:
        raise ImproperlyConfigured("Production host and HTTPS CSRF origin must match SITE_DOMAIN.")
    if os.environ.get("DJANGO_TRUST_X_FORWARDED_PROTO") != "1":
        raise ImproperlyConfigured("Production requires the Caddy HTTPS proxy setting.")
ROOT_URLCONF = "config.urls_public"
INSTALLED_APPS = ["django.contrib.staticfiles"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "config.public_limits.PublicLimitsMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [BASE_DIR / "templates"],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "config.feedback.feedback_context",
    ]},
}]
DATABASES = {"default": {"ENGINE": "django.db.backends.dummy"}}
FILE_UPLOAD_HANDLERS = ["django.core.files.uploadhandler.MemoryFileUploadHandler"]
FILE_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 100
DATA_UPLOAD_MAX_NUMBER_FILES = 1
LANGUAGE_CODE = "ru"
TIME_ZONE = "Europe/Moscow"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_HTTPONLY = True
CSRF_FAILURE_VIEW = "config.feedback.csrf_failure"
SECURE_SSL_REDIRECT = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "0")) if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = os.environ.get("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS") == "True"
SECURE_HSTS_PRELOAD = os.environ.get("DJANGO_SECURE_HSTS_PRELOAD") == "True"
if os.environ.get("DJANGO_TRUST_X_FORWARDED_PROTO") == "1":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

QA_FEEDBACK_FROM = os.environ.get("QA_FEEDBACK_FROM", "").strip()
QA_FEEDBACK_TO = os.environ.get("QA_FEEDBACK_TO", "").strip()
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = os.environ.get("QA_FEEDBACK_SMTP_HOST", "").strip()
EMAIL_HOST_USER = os.environ.get("QA_FEEDBACK_SMTP_USER", "").strip()
EMAIL_HOST_PASSWORD = os.environ.get("QA_FEEDBACK_SMTP_PASSWORD", "")
EMAIL_USE_TLS = True
EMAIL_USE_SSL = False
EMAIL_TIMEOUT = 5
try:
    EMAIL_PORT = int(os.environ.get("QA_FEEDBACK_SMTP_PORT", "587"))
except ValueError:
    EMAIL_PORT = 0


def _feedback_mail_ready():
    if os.environ.get("QA_FEEDBACK_ENABLED") != "1" or not 1 <= EMAIL_PORT <= 65535:
        return False
    if not EMAIL_HOST_USER or not EMAIL_HOST_PASSWORD.strip():
        return False
    if not EMAIL_HOST_USER.isascii() or not EMAIL_HOST_PASSWORD.isascii():
        return False
    try:
        DomainNameValidator(accept_idna=False)(EMAIL_HOST)
        validate_email(QA_FEEDBACK_FROM)
        validate_email(QA_FEEDBACK_TO)
    except ValidationError:
        return False
    return True


QA_FEEDBACK_ENABLED = _feedback_mail_ready()
