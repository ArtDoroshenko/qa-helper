from django.urls import path

from . import views


urlpatterns = [
    path("materials/", views.material_list, name="material_list"),
    path("tools/json/", views.json_tool, name="json_tool"),
    path("tools/json/process/", views.json_process, name="json_process"),
    path("tools/json/download/", views.json_download, name="json_download"),
    path("tools/json/save/", views.json_save, name="json_save"),
    path("materials/json/<int:pk>/rename/", views.json_rename, name="json_rename"),
    path("materials/json/<int:pk>/delete/", views.json_delete, name="json_delete"),
    path("tools/base64/", views.base64_tool, name="base64_tool"),
    path("tools/base64/download/", views.base64_download, name="base64_download"),
    path("tools/test-data/", views.test_data_tool, name="test_data_tool"),
    path("tools/test-data/generate/", views.test_data_generate, name="test_data_generate"),
    path("tools/test-data/checks/", views.test_data_checks, name="test_data_checks"),
    path("tools/test-data/save/", views.test_data_save, name="test_data_save"),
    path("materials/test-data/<int:pk>/delete/", views.test_data_delete, name="test_data_delete"),
]
