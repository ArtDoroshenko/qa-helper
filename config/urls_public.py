"""Only stateless public endpoints are resolvable in the public profile."""

from django.urls import path

from . import public_views
from .feedback import feedback


urlpatterns = [
    path("", public_views.dashboard, name="home"),
    path("healthz/", public_views.health, name="healthcheck"),
    path("tools/json/", public_views.json_tool, name="json_tool"),
    path("tools/json/process/", public_views.json_process, name="json_process"),
    path("tools/base64/", public_views.base64_tool, name="base64_tool"),
    path("tools/test-data/", public_views.test_data_tool, name="test_data_tool"),
    path("tools/test-data/generate/", public_views.test_data_generate, name="test_data_generate"),
    path("tools/test-data/checks/", public_views.test_data_checks, name="test_data_checks"),
    path("tools/text/", public_views.text_tool, name="text_tool"),
    path("tools/screenshots/", public_views.screenshots_tool, name="screenshots_tool"),
    path("tools/bug-report/", public_views.bug_report_tool, name="bug_report_tool"),
    path("feedback/", feedback, name="feedback"),
]
