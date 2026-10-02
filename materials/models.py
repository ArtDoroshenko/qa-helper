from django.conf import settings
from django.db import models


class JsonMaterial(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="json_materials",
    )
    title = models.CharField(max_length=120)
    format_version = models.PositiveSmallIntegerField(default=1)
    source_text = models.TextField()
    result_text = models.TextField()
    options = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at", "-pk")
        indexes = [models.Index(fields=("owner", "-updated_at"))]

    def __str__(self):
        return self.title
