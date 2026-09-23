from ipaddress import ip_address

from allauth.account.models import EmailAddress
from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import AuthenticationEvent, User


def _request_metadata(request):
    if request is None:
        return {"ip_address": None, "user_agent": ""}

    raw_ip = request.META.get("REMOTE_ADDR", "")
    try:
        normalized_ip = str(ip_address(raw_ip)) if raw_ip else None
    except ValueError:
        normalized_ip = None

    return {
        "ip_address": normalized_ip,
        "user_agent": request.META.get("HTTP_USER_AGENT", "")[:500],
    }


def _normalized_email(value):
    if not isinstance(value, str):
        return ""
    return User.objects.normalize_email(value)[:254]


@receiver(post_save, sender=User)
def verify_superuser_email(sender, instance, using, **kwargs):
    if not instance.is_superuser or not instance.email:
        return

    addresses = EmailAddress.objects.using(using).filter(user=instance)
    addresses.filter(primary=True).exclude(email__iexact=instance.email).update(
        primary=False,
    )
    address = addresses.filter(email__iexact=instance.email).first()

    if address is None:
        EmailAddress.objects.using(using).create(
            user=instance,
            email=instance.email,
            verified=True,
            primary=True,
        )
        return

    update_fields = []
    if address.email != instance.email:
        address.email = instance.email
        update_fields.append("email")
    if not address.verified:
        address.verified = True
        update_fields.append("verified")
    if not address.primary:
        address.primary = True
        update_fields.append("primary")
    if update_fields:
        address.save(using=using, update_fields=update_fields)


@receiver(user_logged_in)
def record_successful_login(sender, request, user, **kwargs):
    AuthenticationEvent.objects.create(
        event_type=AuthenticationEvent.Type.LOGIN_SUCCESS,
        user=user,
        email=user.email,
        **_request_metadata(request),
    )


@receiver(user_logged_out)
def record_logout(sender, request, user, **kwargs):
    AuthenticationEvent.objects.create(
        event_type=AuthenticationEvent.Type.LOGOUT,
        user=user,
        email=user.email if user else "",
        **_request_metadata(request),
    )


@receiver(user_login_failed)
def record_failed_login(sender, credentials, request, **kwargs):
    attempted_email = (
        credentials.get("email")
        or credentials.get("login")
        or credentials.get("username")
    )
    AuthenticationEvent.objects.create(
        event_type=AuthenticationEvent.Type.LOGIN_FAILED,
        email=_normalized_email(attempted_email),
        **_request_metadata(request),
    )
