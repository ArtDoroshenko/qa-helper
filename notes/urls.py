from django.urls import path

from . import views


urlpatterns = [
    path("", views.note_list, name="note_list"),
    path("new/", views.note_create, name="note_create"),
    path("<int:pk>/", views.note_detail, name="note_detail"),
    path("<int:pk>/delete/", views.note_delete, name="note_delete"),
    path("<int:note_pk>/attachments/upload/", views.attachment_upload, name="attachment_upload"),
    path("attachments/<int:pk>/download/", views.attachment_download, name="attachment_download"),
    path("attachments/<int:pk>/delete/", views.attachment_delete, name="attachment_delete"),
]
