from django.db import migrations


def verify_superuser_emails(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    EmailAddress = apps.get_model("account", "EmailAddress")
    database_alias = schema_editor.connection.alias

    for user in User.objects.using(database_alias).filter(is_superuser=True):
        addresses = EmailAddress.objects.using(database_alias).filter(user=user)
        addresses.filter(primary=True).exclude(email__iexact=user.email).update(
            primary=False,
        )
        address = addresses.filter(email__iexact=user.email).first()

        if address is None:
            EmailAddress.objects.using(database_alias).create(
                user=user,
                email=user.email,
                verified=True,
                primary=True,
            )
            continue

        address.email = user.email
        address.verified = True
        address.primary = True
        address.save(
            using=database_alias,
            update_fields=["email", "verified", "primary"],
        )


class Migration(migrations.Migration):
    dependencies = [
        ("account", "0009_emailaddress_unique_primary_email"),
        ("accounts", "0002_user_accounts_user_email_ci_unique"),
    ]

    operations = [
        migrations.RunPython(verify_superuser_emails, migrations.RunPython.noop),
    ]
