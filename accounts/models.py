from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.db.models.functions import Lower


class UserManager(BaseUserManager):
    use_in_migrations = True

    @classmethod
    def normalize_email(cls, email):
        normalized_email = super().normalize_email(email)
        return normalized_email.lower() if normalized_email else normalized_email

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Email is required")

        normalized_email = self.normalize_email(email)
        user = self.model(email=normalized_email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)

        if extra_fields.get("is_staff") is not True:
            raise ValueError("A superuser must have is_staff=True")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("A superuser must have is_superuser=True")

        return self._create_user(email, password, **extra_fields)


class User(AbstractUser):
    username = None
    email = models.EmailField(unique=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    class Meta(AbstractUser.Meta):
        constraints = [
            models.UniqueConstraint(
                Lower("email"),
                name="accounts_user_email_ci_unique",
            ),
        ]

    def save(self, *args, **kwargs):
        self.email = type(self).objects.normalize_email(self.email)
        return super().save(*args, **kwargs)

    def __str__(self):
        return self.email


class AuthenticationEvent(models.Model):
    class Type(models.TextChoices):
        LOGIN_SUCCESS = "login_success", "Успешный вход"
        LOGIN_FAILED = "login_failed", "Неудачный вход"
        LOGOUT = "logout", "Выход"

    event_type = models.CharField(max_length=20, choices=Type.choices)
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="authentication_events",
    )
    email = models.EmailField(blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("event_type", "-created_at")),
            models.Index(fields=("user", "-created_at")),
        ]

    def __str__(self):
        return f"{self.get_event_type_display()} · {self.email or 'неизвестный пользователь'}"
