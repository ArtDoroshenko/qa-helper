import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("materials", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="DatasetMaterial",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("title", models.CharField(max_length=120)),
                ("format_version", models.PositiveSmallIntegerField(default=1)),
                ("settings", models.JSONField(default=dict)),
                ("rows", models.JSONField(default=list)),
                ("row_count", models.PositiveSmallIntegerField()),
                ("size_bytes", models.PositiveIntegerField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("owner", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="datasets", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ("-updated_at", "-pk"),
                "indexes": [models.Index(fields=["owner", "-updated_at"], name="materials_d_owner_i_e85bd9_idx")],
            },
        ),
    ]
