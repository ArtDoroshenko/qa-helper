from allauth.account.models import EmailAddress
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import User


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
