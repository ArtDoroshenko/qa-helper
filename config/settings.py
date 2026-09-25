from pathlib import Path

import environ
from django.core.exceptions import ImproperlyConfigured


BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(DJANGO_DEBUG=(bool, False))
environ.Env.read_env(BASE_DIR / ".env")

PRODUCTION = env.bool("DJANGO_PRODUCTION", default=False)
SITE_DOMAIN = env("SITE_DOMAIN", default="")
SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env("DJANGO_DEBUG")
ALLOWED_HOSTS = env.list(
    "DJANGO_ALLOWED_HOSTS",
    default=["localhost", "127.0.0.1"],
)
CSRF_TRUSTED_ORIGINS = env.list("DJANGO_CSRF_TRUSTED_ORIGINS", default=[])

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.humanize",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "allauth",
    "allauth.account",
    "allauth.usersessions",
    "accounts.apps.AccountsConfig",
    "notes.apps.NotesConfig",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "allauth.usersessions.middleware.UserSessionsMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": env("DB_NAME"),
        "USER": env("DB_USER"),
        "PASSWORD": env("DB_PASSWORD"),
        "HOST": env("DB_HOST"),
        "PORT": env.int("DB_PORT"),
        "CONN_MAX_AGE": 60,
    }
}

AUTH_USER_MODEL = "accounts.User"

AUTHENTICATION_BACKENDS = [
    "allauth.account.auth_backends.AuthenticationBackend",
]

ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
ACCOUNT_SIGNUP_FORM_CLASS = "accounts.forms.SignupForm"
ACCOUNT_ADAPTER = "accounts.adapters.AccountAdapter"
ACCOUNT_ALLOW_SIGNUPS = env.bool("DJANGO_ACCOUNT_ALLOW_SIGNUPS", default=True)
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_CHANGE_EMAIL = True
USERSESSIONS_TRACK_ACTIVITY = True

LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/accounts/login/"

EMAIL_BACKEND = env(
    "DJANGO_EMAIL_BACKEND",
    default="django.core.mail.backends.console.EmailBackend",
)
DEFAULT_FROM_EMAIL = env("DJANGO_DEFAULT_FROM_EMAIL", default="webmaster@localhost")

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

LANGUAGE_CODE = "ru"
TIME_ZONE = "Europe/Moscow"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_ROOT = BASE_DIR / "media"

SECURE_SSL_REDIRECT = env.bool("DJANGO_SECURE_SSL_REDIRECT", default=False)
SESSION_COOKIE_SECURE = env.bool("DJANGO_SESSION_COOKIE_SECURE", default=False)
CSRF_COOKIE_SECURE = env.bool("DJANGO_CSRF_COOKIE_SECURE", default=False)
SECURE_HSTS_SECONDS = env.int("DJANGO_SECURE_HSTS_SECONDS", default=0)
SECURE_HSTS_INCLUDE_SUBDOMAINS = env.bool(
    "DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS",
    default=False,
)
SECURE_HSTS_PRELOAD = env.bool("DJANGO_SECURE_HSTS_PRELOAD", default=False)
if env.bool("DJANGO_TRUST_X_FORWARDED_PROTO", default=False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Base64 download posts an encoded 10 MB result back to the server. Keep the
# request limit finite while allowing for Base64 and form-encoding overhead.
DATA_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024 * 1024

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


def _validate_production_settings():
    expected_hosts = [SITE_DOMAIN] if SITE_DOMAIN else []
    expected_csrf_origins = [f"https://{SITE_DOMAIN}"] if SITE_DOMAIN else []
    secret_is_safe = (
        len(SECRET_KEY) >= 50
        and len(set(SECRET_KEY)) >= 5
        and not SECRET_KEY.lower().startswith(("replace-with-", "django-insecure-"))
    )
    requirements = {
        "SITE_DOMAIN must be set": bool(SITE_DOMAIN),
        "DJANGO_SECRET_KEY must be non-placeholder, at least 50 characters, and sufficiently varied": secret_is_safe,
        "DJANGO_DEBUG must be False": DEBUG is False,
        "DJANGO_ACCOUNT_ALLOW_SIGNUPS must be False": ACCOUNT_ALLOW_SIGNUPS is False,
        "DJANGO_ALLOWED_HOSTS must contain only SITE_DOMAIN": ALLOWED_HOSTS
        == expected_hosts,
        "DJANGO_CSRF_TRUSTED_ORIGINS must contain only the HTTPS SITE_DOMAIN origin": (
            CSRF_TRUSTED_ORIGINS == expected_csrf_origins
        ),
        "DJANGO_SECURE_SSL_REDIRECT must be True": SECURE_SSL_REDIRECT is True,
        "DJANGO_SESSION_COOKIE_SECURE must be True": SESSION_COOKIE_SECURE is True,
        "DJANGO_CSRF_COOKIE_SECURE must be True": CSRF_COOKIE_SECURE is True,
        "DJANGO_TRUST_X_FORWARDED_PROTO must be True": (
            globals().get("SECURE_PROXY_SSL_HEADER")
            == ("HTTP_X_FORWARDED_PROTO", "https")
        ),
        "DJANGO_SECURE_HSTS_SECONDS must be greater than zero": (
            SECURE_HSTS_SECONDS > 0
        ),
    }
    errors = [message for message, valid in requirements.items() if not valid]
    if errors:
        raise ImproperlyConfigured(
            "Unsafe production configuration: " + "; ".join(errors)
        )


if PRODUCTION:
    _validate_production_settings()
