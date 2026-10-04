import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from threading import Barrier

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import reverse

from .forms import MAX_ATTACHMENT_BYTES, MAX_NOTE_BYTES, MAX_NOTE_CHARACTERS, MAX_NOTES
from .models import Attachment, Note


class NoteQuotaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = get_user_model().objects.create_user(email="note-quota@example.com", password="password")
        cls.other = get_user_model().objects.create_user(email="other-note-quota@example.com", password="password")

    def setUp(self):
        self.client.force_login(self.owner)

    def test_character_and_utf8_byte_boundaries_and_autosave_error(self):
        url = reverse("note_create")
        self.assertEqual(self.client.post(url, {"title": "Boundary", "content": "a" * MAX_NOTE_CHARACTERS}).status_code, 302)
        response = self.client.post(url, {"title": "Too large", "content": "a" * (MAX_NOTE_CHARACTERS + 1)})
        self.assertContains(response, "50 000")
        self.assertContains(response, "a" * 20)
        note = Note.objects.get(title="Boundary")
        edit_url = reverse("note_detail", args=(note.pk,))
        self.assertEqual(self.client.post(edit_url, {"title": "Boundary", "content": "😀" * MAX_NOTE_CHARACTERS},
                                          HTTP_X_REQUESTED_WITH="XMLHttpRequest").status_code, 200)
        legacy = Note.objects.create(owner=self.owner, title="Legacy bytes", content="a" * 60_000)
        edit_url = reverse("note_detail", args=(legacy.pk,))
        response = self.client.post(edit_url, {"title": "Boundary", "content": "😀" * (MAX_NOTE_BYTES // 4 + 1)},
                                    HTTP_X_REQUESTED_WITH="XMLHttpRequest")
        self.assertEqual(response.status_code, 400)
        self.assertIn("200 КиБ", response.json()["errors"]["content"][0]["message"])
        legacy.refresh_from_db()
        self.assertEqual(legacy.content, "a" * 60_000)
        self.assertEqual(self.client.post(edit_url, {"title": "Boundary", "content": "😀" * (MAX_NOTE_BYTES // 4)},
                                          HTTP_X_REQUESTED_WITH="XMLHttpRequest").status_code, 200)

    def test_count_is_per_owner_and_delete_frees_slot(self):
        Note.objects.bulk_create(Note(owner=self.owner, title=f"Note {index}") for index in range(MAX_NOTES + 1))
        Note.objects.create(owner=self.other, title="Other")
        response = self.client.post(reverse("note_create"), {"title": "Overflow", "content": "draft"})
        self.assertContains(response, "лимит 50 заметок")
        self.assertContains(response, "draft")
        self.assertEqual(Note.objects.filter(owner=self.owner).count(), MAX_NOTES + 1)
        note = Note.objects.filter(owner=self.owner).first()
        self.client.post(reverse("note_delete", args=(note.pk,)))
        self.assertEqual(self.client.post(reverse("note_create"), {"title": "Still full", "content": ""}).status_code, 200)
        note = Note.objects.filter(owner=self.owner).first()
        self.client.post(reverse("note_delete", args=(note.pk,)))
        self.assertEqual(self.client.post(reverse("note_create"), {"title": "Freed", "content": ""}).status_code, 302)
        self.assertEqual(Note.objects.filter(owner=self.other).count(), 1)

    def test_legacy_oversized_note_can_be_read_reduced_and_deleted(self):
        note = Note.objects.create(owner=self.owner, title="Legacy", content="😀" * (MAX_NOTE_BYTES // 4 + 10))
        url = reverse("note_detail", args=(note.pk,))
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.post(url, {"title": "Renamed", "content": note.content}).status_code, 302)
        self.assertEqual(self.client.post(url, {"title": "Too big", "content": note.content + "😀"}).status_code, 200)
        self.assertEqual(self.client.post(url, {"title": "Reduced", "content": note.content[:-1]}).status_code, 302)
        self.client.post(reverse("note_delete", args=(note.pk,)))
        self.assertFalse(Note.objects.filter(pk=note.pk).exists())


class AttachmentQuotaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = get_user_model().objects.create_user(email="file-quota@example.com", password="password")
        cls.other = get_user_model().objects.create_user(email="other-file-quota@example.com", password="password")
        cls.note = Note.objects.create(owner=cls.owner, title="Files")
        cls.second = Note.objects.create(owner=cls.owner, title="More files")

    def setUp(self):
        self.media_directory = tempfile.TemporaryDirectory()
        self.media_override = override_settings(MEDIA_ROOT=self.media_directory.name)
        self.media_override.enable()
        self.addCleanup(self.media_override.disable)
        self.addCleanup(self.media_directory.cleanup)
        self.client.force_login(self.owner)

    def _upload(self, note, size):
        return self.client.post(reverse("attachment_upload", args=(note.pk,)), {
            "file": SimpleUploadedFile("report.txt", b"x" * size, content_type="text/plain"),
        })

    def test_file_limit_and_rejected_upload_has_no_storage_artifact(self):
        self._upload(self.note, MAX_ATTACHMENT_BYTES)
        self.assertEqual(Attachment.objects.count(), 1)
        before = set(Attachment.objects.values_list("file", flat=True))
        response = self._upload(self.note, MAX_ATTACHMENT_BYTES + 1)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(set(Attachment.objects.values_list("file", flat=True)), before)
        self.assertEqual(len(list(Path(self.media_directory.name).rglob("*.txt"))), 1)

    def test_failed_database_write_rolls_back_file_and_record(self):
        real_save = Attachment.save

        def fail_after_save(attachment, *args, **kwargs):
            real_save(attachment, *args, **kwargs)
            raise RuntimeError("Database failure after file write")

        with patch.object(Attachment, "save", fail_after_save), self.assertRaises(RuntimeError):
            self._upload(self.note, 1)
        self.assertFalse(Attachment.objects.exists())
        self.assertFalse(list(Path(self.media_directory.name).rglob("*.txt")))

    def test_per_note_and_owner_total_limits_with_manual_delete(self):
        for index in range(5):
            self._upload(self.note, 1)
        self.assertEqual(Attachment.objects.filter(note=self.note).count(), 5)
        self._upload(self.note, 1)
        self.assertEqual(Attachment.objects.filter(note=self.note).count(), 5)
        self._upload(self.second, 1)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 6)
        Attachment.objects.filter(owner=self.owner).delete()
        for index in range(10):
            note = Note.objects.create(owner=self.owner, title=f"Storage {index}")
            self._upload(note, MAX_ATTACHMENT_BYTES)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 10)
        other_note = Note.objects.create(owner=self.other, title="Other owner")
        Attachment.objects.create(owner=self.other, note=other_note, file="other.txt", original_name="other.txt",
                                  content_type="text/plain", size=MAX_ATTACHMENT_BYTES)
        extra = Note.objects.create(owner=self.owner, title="Overflow")
        self._upload(extra, 1)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 10)
        first = Attachment.objects.filter(owner=self.owner).first()
        self.client.post(reverse("attachment_delete", args=(first.pk,)))
        self._upload(extra, 1)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 10)

    def test_legacy_oversized_storage_and_file_count_can_only_decrease(self):
        for index in range(6):
            Attachment.objects.create(owner=self.owner, note=self.note, file=f"legacy-{index}.txt",
                                      original_name=f"legacy-{index}.txt", content_type="text/plain",
                                      size=MAX_ATTACHMENT_BYTES * 2)
        extra = Note.objects.create(owner=self.owner, title="Extra")
        self.assertEqual(self.client.get(reverse("note_detail", args=(self.note.pk,))).status_code, 200)
        self._upload(self.note, 1)
        self._upload(extra, 1)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 6)
        self.client.post(reverse("attachment_delete", args=(Attachment.objects.filter(note=self.note).first().pk,)))
        self._upload(self.note, 1)
        self.assertEqual(Attachment.objects.filter(owner=self.owner).count(), 5)
        self.client.post(reverse("attachment_delete", args=(Attachment.objects.filter(note=self.note).first().pk,)))
        self._upload(self.note, 1)
        self.assertEqual(Attachment.objects.filter(note=self.note).count(), 5)


class ConcurrentNoteQuotaTests(TransactionTestCase):
    def test_two_creations_share_one_remaining_slot(self):
        owner = get_user_model().objects.create_user(email="concurrent-note@example.com", password="password")
        Note.objects.bulk_create(Note(owner=owner, title=f"N{index}") for index in range(MAX_NOTES - 1))
        barrier = Barrier(2)

        def create(index):
            connections.close_all()
            client = Client()
            client.force_login(owner)
            barrier.wait()
            try:
                return client.post(reverse("note_create"), {"title": f"New {index}", "content": ""}).status_code
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(create, (1, 2)))
        self.assertEqual(sorted(statuses), [200, 302])
        self.assertEqual(Note.objects.filter(owner=owner).count(), MAX_NOTES)


class ConcurrentAttachmentQuotaTests(TransactionTestCase):
    def test_two_uploads_share_one_remaining_note_slot(self):
        owner = get_user_model().objects.create_user(email="concurrent-file@example.com", password="password")
        note = Note.objects.create(owner=owner, title="Concurrent")
        for index in range(4):
            Attachment.objects.create(owner=owner, note=note, file=f"existing-{index}.txt",
                                      original_name=f"existing-{index}.txt", content_type="text/plain", size=1)
        barrier = Barrier(2)
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            def upload(index):
                connections.close_all()
                client = Client()
                client.force_login(owner)
                barrier.wait()
                try:
                    return client.post(reverse("attachment_upload", args=(note.pk,)), {
                        "file": SimpleUploadedFile(f"new-{index}.txt", b"x", content_type="text/plain"),
                    }).status_code
                finally:
                    connections.close_all()

            with ThreadPoolExecutor(max_workers=2) as executor:
                statuses = list(executor.map(upload, (1, 2)))
            self.assertEqual(statuses, [302, 302])
            self.assertEqual(Attachment.objects.filter(owner=owner, note=note).count(), 5)
            self.assertEqual(len(list(Path(media_root).rglob("*.txt"))), 1)
