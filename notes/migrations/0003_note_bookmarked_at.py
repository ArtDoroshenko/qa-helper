from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("notes", "0002_attachment")]

    operations = [
        migrations.AddField(
            model_name="note",
            name="bookmarked_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
    ]
