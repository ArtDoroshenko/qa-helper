import tempfile

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from config.upload_validation import MAX_UPLOAD_SIZE

from .models import Attachment, Note


class AttachmentFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user_a = get_user_model().objects.create_user(
            email="files-a@example.com",
            password="test-password",
        )
        cls.user_b = get_user_model().objects.create_user(
            email="files-b@example.com",
            password="test-password",
        )
        cls.note_a = Note.objects.create(owner=cls.user_a, title="Note A")
        cls.note_b = Note.objects.create(owner=cls.user_b, title="Note B")

    def setUp(self):
        self.media_directory = tempfile.TemporaryDirectory()
        self.media_override = override_settings(MEDIA_ROOT=self.media_directory.name)
        self.media_override.enable()
        self.addCleanup(self.media_override.disable)
        self.addCleanup(self.media_directory.cleanup)

    def _create_attachment(self, owner=None, note=None, name="report.txt", data=b"hello"):
        attachment = Attachment(
            owner=owner or self.user_a,
            note=note or self.note_a,
            original_name=name,
            content_type="text/plain",
            size=len(data),
        )
        attachment.file.save(name, ContentFile(data), save=True)
        return attachment

    def test_anonymous_user_is_redirected_to_login(self):
        attachment = self._create_attachment()
        requests = (
            (self.client.post, reverse("attachment_upload", args=(self.note_a.pk,))),
            (self.client.get, reverse("attachment_download", args=(attachment.pk,))),
            (self.client.post, reverse("attachment_delete", args=(attachment.pk,))),
        )
        for method, url in requests:
            with self.subTest(url=url):
                response = method(url)
                self.assertRedirects(
                    response,
                    f"{reverse('account_login')}?next={url}",
                    fetch_redirect_response=False,
                )

    def test_upload_download_and_delete_use_private_storage(self):
        self.client.force_login(self.user_a)
        upload = SimpleUploadedFile(
            "../unsafe report.txt",
            b"private contents",
            content_type="text/plain",
        )
        response = self.client.post(
            reverse("attachment_upload", args=(self.note_a.pk,)),
            {
                "file": upload,
                "owner": self.user_b.pk,
                "note": self.note_b.pk,
            },
        )
        self.assertRedirects(
            response,
            reverse("note_detail", args=(self.note_a.pk,)),
            fetch_redirect_response=False,
        )
        attachment = Attachment.objects.get()
        self.assertEqual(attachment.owner, self.user_a)
        self.assertEqual(attachment.note, self.note_a)
        self.assertNotIn("/", attachment.original_name)
        self.assertTrue(attachment.file.storage.exists(attachment.file.name))

        response = self.client.get(reverse("attachment_download", args=(attachment.pk,)))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), b"private contents")
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")

        stored_name = attachment.file.name
        response = self.client.post(reverse("attachment_delete", args=(attachment.pk,)))
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Attachment.objects.filter(pk=attachment.pk).exists())
        self.assertFalse(attachment.file.storage.exists(stored_name))

    def test_owner_isolation_and_missing_ids_have_same_404(self):
        foreign = self._create_attachment(owner=self.user_b, note=self.note_b)
        self.client.force_login(self.user_a)
        missing_pk = foreign.pk + 1000
        for route_name, method in (
            ("attachment_download", self.client.get),
            ("attachment_delete", self.client.post),
        ):
            statuses = []
            for pk in (foreign.pk, missing_pk):
                statuses.append(method(reverse(route_name, args=(pk,))).status_code)
            self.assertEqual(statuses, [404, 404])
        self.assertTrue(Attachment.objects.filter(pk=foreign.pk).exists())

    def test_upload_to_foreign_and_missing_note_has_same_404(self):
        self.client.force_login(self.user_a)
        missing_pk = self.note_b.pk + 1000
        statuses = []
        for note_pk in (self.note_b.pk, missing_pk):
            uploaded_file = SimpleUploadedFile(
                "private.txt",
                b"private",
                content_type="text/plain",
            )
            statuses.append(
                self.client.post(
                    reverse("attachment_upload", args=(note_pk,)),
                    {"file": uploaded_file, "owner": self.user_a.pk},
                ).status_code,
            )
        self.assertEqual(statuses, [404, 404])
        self.assertFalse(Attachment.objects.exists())

    def test_upload_rejects_large_unsupported_and_fake_image_files(self):
        self.client.force_login(self.user_a)
        files = (
            SimpleUploadedFile(
                "large.txt",
                b"x" * (MAX_UPLOAD_SIZE + 1),
                content_type="text/plain",
            ),
            SimpleUploadedFile("payload.exe", b"run", content_type="application/octet-stream"),
            SimpleUploadedFile("fake.png", b"not a png", content_type="image/png"),
        )
        for uploaded_file in files:
            with self.subTest(name=uploaded_file.name):
                response = self.client.post(
                    reverse("attachment_upload", args=(self.note_a.pk,)),
                    {"file": uploaded_file},
                )
                self.assertEqual(response.status_code, 302)
                self.assertFalse(Attachment.objects.exists())

    def test_upload_and_delete_require_csrf(self):
        attachment = self._create_attachment()
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user_a)
        upload = SimpleUploadedFile("safe.txt", b"safe", content_type="text/plain")
        self.assertEqual(
            client.post(
                reverse("attachment_upload", args=(self.note_a.pk,)),
                {"file": upload},
            ).status_code,
            403,
        )
        self.assertEqual(
            client.post(reverse("attachment_delete", args=(attachment.pk,))).status_code,
            403,
        )
        self.assertTrue(Attachment.objects.filter(pk=attachment.pk).exists())

    def test_note_delete_removes_file_from_storage(self):
        attachment = self._create_attachment()
        stored_name = attachment.file.name
        self.note_a.delete()
        self.assertFalse(attachment.file.storage.exists(stored_name))
