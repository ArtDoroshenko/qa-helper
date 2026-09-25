import base64

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase
from django.urls import reverse

from config.upload_validation import MAX_UPLOAD_SIZE

from .base64_tools import Base64ToolError, decode_value, encode_text


class Base64ToolTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user_a = get_user_model().objects.create_user(
            email="base64-a@example.com",
            password="test-password",
        )

    def test_anonymous_user_is_redirected_to_login(self):
        requests = (
            (self.client.get, reverse("base64_tool"), None),
            (
                self.client.post,
                reverse("base64_download"),
                {"mode": "decoded", "payload": "eA==", "filename": "x.txt"},
            ),
        )
        for method, url, data in requests:
            with self.subTest(method=method.__name__, url=url):
                response = method(url, data) if data is not None else method(url)
                self.assertRedirects(
                    response,
                    f"{reverse('account_login')}?next={url}",
                    fetch_redirect_response=False,
                )

    def test_text_base64_round_trip_and_invalid_data(self):
        encoded = encode_text("Привет, QA")
        decoded, mime_type, is_data_url = decode_value(encoded)
        self.assertEqual(decoded.decode("utf-8"), "Привет, QA")
        self.assertEqual(mime_type, "application/octet-stream")
        self.assertFalse(is_data_url)
        with self.assertRaisesRegex(Base64ToolError, "Некорректные данные"):
            decode_value("not base64!")
        oversized = base64.b64encode(b"x" * (MAX_UPLOAD_SIZE + 1)).decode("ascii")
        with self.assertRaisesRegex(Base64ToolError, "10 МБ"):
            decode_value(oversized)

    def test_file_encode_and_decoded_download_round_trip(self):
        self.client.force_login(self.user_a)
        source = b"file contents"
        response = self.client.post(
            reverse("base64_tool"),
            {
                "operation": "encode",
                "file": SimpleUploadedFile("sample.txt", source, content_type="text/plain"),
            },
        )
        self.assertEqual(response.status_code, 200)
        encoded = base64.b64encode(source).decode("ascii")
        self.assertContains(response, encoded)

        response = self.client.post(
            reverse("base64_tool"),
            {
                "operation": "decode",
                "file": SimpleUploadedFile(
                    "encoded.txt",
                    encoded.encode("ascii"),
                    content_type="text/plain",
                ),
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "file contents")

        response = self.client.post(
            reverse("base64_download"),
            {"mode": "decoded", "payload": encoded, "filename": "result.txt"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, source)
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")

    def test_large_and_boundary_downloads_respect_ten_megabyte_limit(self):
        self.client.force_login(self.user_a)
        for size in (3 * 1024 * 1024 + 1, MAX_UPLOAD_SIZE):
            with self.subTest(size=size):
                source = b"x" * size
                response = self.client.post(
                    reverse("base64_download"),
                    {
                        "mode": "decoded",
                        "payload": base64.b64encode(source).decode("ascii"),
                        "filename": "result.bin",
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(response.content), size)

        oversized = base64.b64encode(b"x" * (MAX_UPLOAD_SIZE + 1)).decode("ascii")
        response = self.client.post(
            reverse("base64_download"),
            {"mode": "decoded", "payload": oversized, "filename": "too-large.bin"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertContains(response, "10 МБ", status_code=400)

    def test_data_url_image_preview_contract(self):
        self.client.force_login(self.user_a)
        png = b"\x89PNG\r\n\x1a\n" + b"preview"
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        response = self.client.post(
            reverse("base64_tool"),
            {"operation": "decode", "text": data_url},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'class="base64-preview"')
        self.assertContains(response, 'src="data:image/png;base64,')

    def test_invalid_data_and_file_type_are_rejected(self):
        self.client.force_login(self.user_a)
        response = self.client.post(
            reverse("base64_tool"),
            {"operation": "decode", "text": "***"},
        )
        self.assertContains(response, "Некорректные данные Base64")
        response = self.client.post(
            reverse("base64_tool"),
            {
                "operation": "encode",
                "file": SimpleUploadedFile("bad.exe", b"bad", content_type="application/octet-stream"),
            },
        )
        self.assertContains(response, "Этот тип файла не поддерживается")

    def test_download_requires_csrf(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user_a)
        self.assertEqual(
            client.post(
                reverse("base64_download"),
                {"mode": "decoded", "payload": "eA==", "filename": "x.txt"},
            ).status_code,
            403,
        )

    def test_result_is_explicitly_transient(self):
        self.client.force_login(self.user_a)
        response = self.client.post(
            reverse("base64_tool"),
            {"operation": "encode", "text": "hello"},
        )
        self.assertContains(
            response,
            "Результат не сохраняется в материалах и исчезнет после закрытия страницы.",
        )
        self.assertNotContains(response, "Сохранить как материал")
