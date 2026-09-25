from django.urls import path

from . import views


urlpatterns = [
    path("tools/base64/", views.base64_tool, name="base64_tool"),
    path("tools/base64/download/", views.base64_download, name="base64_download"),
]
