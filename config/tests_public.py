import base64
import json
import random
import struct
import zlib
from html.parser import HTMLParser
from urllib.parse import urlencode

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, SimpleTestCase, override_settings
from django.urls import Resolver404, get_resolver, resolve

from config.public_limits import MAX_PUBLIC_BODY_BYTES, MAX_TEST_DATA_BODY_BYTES, MAX_URLENCODED_BODY_BYTES, TEST_DATA_PATHS
from config.upload_validation import MAX_UPLOAD_SIZE
from materials.base64_tools import MAX_DATA_URL_HEADER_LENGTH


TOOL_PAGES = ("/tools/base64/", "/tools/json/", "/tools/test-data/", "/tools/text/",
              "/tools/screenshots/", "/tools/bug-report/")
PAGES = ("/", *TOOL_PAGES)
API = ("/tools/json/process/",
       "/tools/test-data/generate/", "/tools/test-data/checks/")
RETIRED_EXPORTS = ("/tools/base64/download/", "/tools/json/download/")
PRIVATE = ("/admin/", "/accounts/login/", "/accounts/profile/", "/notes/", "/materials/",
           "/tools/json/save/", "/tools/test-data/save/", "/materials/json/1/delete/")


def png_image(side):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rng = random.Random(10)
    rows = b"".join(b"\x00" + rng.randbytes(side * 3) for _ in range(side))
    header = struct.pack(">2I5B", side, side, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, level=0)) + chunk(b"IEND", b"")


class FormMarkup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
        self.active = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "form":
            self.active = (attributes.get("method", "get"), [], [])
            self.forms.append(self.active)
        elif self.active and tag in {"button", "input", "select", "textarea"}:
            if attributes.get("name"):
                self.active[1].append(attributes["name"])
            if attributes.get("type", "submit" if tag == "button" else "") == "submit":
                self.active[2].append("disabled" in attributes)

    def handle_endtag(self, tag):
        if tag == "form":
            self.active = None


@override_settings(QA_FEEDBACK_ENABLED=False)
class PublicSiteTests(SimpleTestCase):
    def test_public_routing_uses_no_database_or_account_apps(self):
        self.assertEqual(settings.DATABASES["default"]["ENGINE"], "django.db.backends.dummy")
        self.assertNotIn("django.contrib.auth", settings.INSTALLED_APPS)
        self.assertNotIn("django.contrib.sessions", settings.INSTALLED_APPS)
        self.assertEqual({pattern.name for pattern in get_resolver().url_patterns}, {
            "home", "healthcheck", "json_tool", "json_process",
            "base64_tool", "test_data_tool", "test_data_generate",
            "test_data_checks", "text_tool", "screenshots_tool", "bug_report_tool", "feedback",
        })
        for path in PRIVATE + RETIRED_EXPORTS:
            with self.subTest(path=path), self.assertRaises(Resolver404):
                resolve(path)

    def test_pages_open_directly_and_exclude_saved_materials(self):
        client = Client()
        for path in PAGES:
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response["Cache-Control"])
                body = response.content.decode()
                for forbidden in ("Сохранить в материалы", "Мои материалы", "Мои наборы", "/accounts/", "/notes/"):
                    self.assertNotIn(forbidden, body)
                self.assertNotIn("sessionid", response.cookies)
                forms = FormMarkup()
                forms.feed(body)
                for method, fields, submit_controls in forms.forms:
                    self.assertTrue(submit_controls and all(submit_controls))
                    if method != "post":
                        self.assertFalse(fields, "Local forms must not send field values in a URL.")
        self.assertEqual(client.get("/healthz/").content, b"ok")
        for path in API:
            self.assertEqual(client.get(path).status_code, 405)

    def test_dashboard_has_a_card_for_each_public_tool_and_keeps_direct_base64_page(self):
        client = Client()
        response = client.get("/")
        self.assertContains(response, "<h1>QA Kit</h1>")
        self.assertContains(response, 'href="/" aria-current="page"')
        self.assertContains(response, '<a class="tool-card" ', count=len(TOOL_PAGES))
        for path in TOOL_PAGES:
            with self.subTest(path=path):
                self.assertContains(response, f'<a class="tool-card" href="{path}">', count=1)
        self.assertNotContains(response, "<form")
        self.assertContains(response, '<button class="nav-item" type="button" disabled aria-disabled="true">')
        self.assertContains(response, "Анализатор логов</button>", count=1)
        self.assertEqual(client.post("/").status_code, 405)
        self.assertContains(client.get("/tools/base64/"), 'id="base64-tool-form"')

    def test_stateless_processing_and_download(self):
        client = Client()
        encoded = client.post("/tools/base64/", {"operation": "encode", "text": "hello"})
        self.assertEqual(encoded.status_code, 200)
        self.assertEqual(encoded.content, b"aGVsbG8=")
        self.assertIn("no-store", encoded["Cache-Control"])
        decoded = client.post("/tools/base64/", {
            "operation": "decode", "text": "aGVsbG8=", "output_name": "answer.txt",
        })
        self.assertEqual(decoded.content, b"hello")
        self.assertIn("attachment", decoded["Content-Disposition"])
        processed = client.post("/tools/json/process/", {
            "source": '{"large":123456789012345678901234567890}', "operation": "format", "indent": 2,
        })
        self.assertEqual(processed.status_code, 200)
        self.assertIn("123456789012345678901234567890", processed.json()["result"])
        minified = client.post("/tools/json/process/", {
            "source": '{"a":1}', "operation": "minify", "indent": 2,
        })
        self.assertEqual(minified.json()["result"], '{"a":1}')
        settings_payload = {"fields": ["name"], "count": 2, "locale": "ru_RU", "password_length": 12}
        generated = client.post("/tools/test-data/generate/", data=json.dumps({"settings": settings_payload}),
                                content_type="application/json")
        self.assertEqual(generated.status_code, 200)
        self.assertEqual(len(generated.json()["rows"]), 2)
        self.assertNotIn("proof", generated.json())

    def test_screenshots_page_links_local_worker_and_has_no_upload_action(self):
        client = Client()
        path = "/tools/screenshots/"
        response = client.get(path)
        self.assertContains(response, 'href="/tools/screenshots/" aria-current="page"')
        self.assertContains(response, "js/screenshots_worker.js")
        self.assertContains(response, "js/screenshots.js")
        self.assertContains(response, 'data-sc-file="left"')
        self.assertContains(response, 'data-sc-file="right"')
        self.assertNotContains(response, "<form")
        self.assertEqual(client.post(path).status_code, 405)

    def test_bug_report_is_get_only_and_uses_local_scripts(self):
        client = Client()
        path = "/tools/bug-report/"
        response = client.get(path)
        self.assertContains(response, 'href="/tools/bug-report/" aria-current="page"')
        self.assertContains(response, "js/bug_report_core.js")
        self.assertContains(response, "js/bug_report.js")
        self.assertContains(response, 'aria-describedby="br-steps-hint br-steps-error"')
        self.assertNotContains(response, "<form")
        self.assertEqual(client.post(path).status_code, 405)

    def test_base64_returns_full_utf8_result_once_without_rendering_large_html(self):
        client = Client(enforce_csrf_checks=True)
        page = client.get("/tools/base64/")
        self.assertContains(page, 'enctype="multipart/form-data"')
        self.assertNotContains(page, 'name="payload"')
        self.assertContains(page, "js/base64.js")
        sample = "Проверка 🙂\n".encode("utf-8")
        repeats, remainder = divmod(MAX_UPLOAD_SIZE, len(sample))
        original = sample * repeats + b"x" * remainder
        processed = client.post("/tools/base64/", {
            "csrfmiddlewaretoken": client.cookies["csrftoken"].value,
            "operation": "decode",
            "file": SimpleUploadedFile("result.base64.txt", b"data:text/plain;base64," + base64.encodebytes(original),
                                       content_type="text/plain"),
            "output_name": "проверка.txt",
        })
        self.assertEqual(processed.status_code, 200)
        self.assertEqual(processed["Content-Type"], "text/plain")
        self.assertIn("attachment; filename*=utf-8''", processed["Content-Disposition"])
        self.assertEqual(processed["X-QA-Result-Text"], "1")
        self.assertIn("no-store", processed["Cache-Control"])
        self.assertTrue(processed.content == original, "Result bytes differ from the input bytes.")

    def test_base64_keeps_image_bytes_and_limits_preview(self):
        client = Client()
        for side, expects_preview in ((2, True), (1800, False)):
            with self.subTest(side=side):
                original = png_image(side)
                encoded = client.post("/tools/base64/", {
                    "operation": "encode", "as_data_url": "on",
                    "file": SimpleUploadedFile("fixture.png", original, content_type="image/png"),
                })
                self.assertEqual(encoded.status_code, 200)
                prefix, payload = encoded.content.split(b",", 1)
                self.assertEqual(prefix, b"data:image/png;base64")
                self.assertTrue(base64.b64decode(payload, validate=True) == original)
                self.assertEqual(encoded.has_header("X-QA-Preview-Type"), expects_preview)
                decoded = client.post("/tools/base64/", {"operation": "decode", "text": encoded.content.decode("ascii")})
                self.assertEqual(decoded.status_code, 200)
                self.assertEqual(decoded["Content-Type"], "image/png")
                self.assertEqual(decoded["Content-Disposition"], 'attachment; filename="decoded.png"')
                self.assertEqual(decoded.get("X-QA-Preview-Type"), "image/png" if expects_preview else None)
                self.assertTrue(decoded.content == original)

    def test_base64_data_url_header_limit_preserves_mime_and_charset_syntax(self):
        client = Client()
        prefix, marker = "data:text/plain;charset=utf-8", ";base64"
        parameter = ";name="
        padding_length = MAX_DATA_URL_HEADER_LENGTH - len(prefix + parameter + marker)
        for parameter_length, expected_status in ((None, 200), (padding_length, 200), (padding_length + 1, 400)):
            with self.subTest(parameter_length=parameter_length):
                header = prefix
                if parameter_length is not None:
                    header += parameter + "a" * parameter_length
                response = client.post("/tools/base64/", {
                    "operation": "decode", "text": f"{header}{marker},0K8=",
                })
                self.assertEqual(response.status_code, expected_status)
                if expected_status == 200:
                    self.assertEqual(response["Content-Type"], "text/plain")
                    self.assertEqual(response.content, "Я".encode("utf-8"))
                else:
                    self.assertEqual(response.json(), {
                        "ok": False, "error": "Некорректный или слишком длинный заголовок Data URL.",
                    })

    def test_urlencoded_limit_applies_before_csrf_without_affecting_multipart(self):
        client = Client(enforce_csrf_checks=True)
        url = "/tools/base64/"
        client.get(url)
        token = client.cookies["csrftoken"].value
        content_type = "application/x-www-form-urlencoded; charset=UTF-8"
        prefix = urlencode({"csrfmiddlewaretoken": token, "operation": "encode", "text": ""}).encode("ascii")
        at_limit = prefix.ljust(MAX_URLENCODED_BODY_BYTES, b"a")
        accepted = client.post(url, data=at_limit, content_type=content_type)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.content, base64.b64encode(at_limit[len(prefix):]))

        oversized = b"operation=encode&text=".ljust(MAX_URLENCODED_BODY_BYTES + 1, b"a")
        rejected = client.post(url, data=oversized, content_type=content_type)
        self.assertEqual(rejected.status_code, 413)
        self.assertIn("no-store", rejected["Cache-Control"])

        multipart = client.post(url, {"csrfmiddlewaretoken": token, "operation": "encode",
                                      "text": "a" * (MAX_URLENCODED_BODY_BYTES + 1)})
        self.assertEqual(multipart.status_code, 200)

    def test_invalid_input_returns_no_partial_result(self):
        client = Client()
        duplicate = client.post("/tools/json/process/", {
            "source": '{"a":1,"a":2}', "operation": "format", "indent": 2,
        })
        self.assertEqual(duplicate.status_code, 400)
        self.assertFalse(duplicate.json()["ok"])
        invalid_base64 = client.post("/tools/base64/", {"operation": "decode", "text": "not base64!"})
        self.assertEqual(invalid_base64.status_code, 400)
        self.assertEqual(invalid_base64.json(), {"ok": False, "error": "Некорректные данные Base64."})
        bad_dataset = client.post("/tools/test-data/generate/", data=json.dumps({"settings": {
            "fields": ["name"], "count": 1001, "locale": "ru_RU", "password_length": 12,
        }}), content_type="application/json")
        self.assertEqual(bad_dataset.status_code, 400)
        self.assertFalse(bad_dataset.json()["ok"])

    def test_test_data_endpoints_reject_invalid_structure_and_types(self):
        client = Client()
        for operation, body in (
            ("generate", {"settings": []}),
            ("generate", {"settings": {"fields": ["name"], "count": 2, "locale": ["ru_RU"]}}),
            ("checks", {"settings": {"type": ["text"]}}),
            ("checks", {"settings": {"type": "text", "required": "true"}}),
            ("checks", {"settings": {"type": "phone", "phone_locale": {"name": "ru_RU"}}}),
        ):
            with self.subTest(operation=operation, body=body):
                response = client.post(f"/tools/test-data/{operation}/", data=body, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.json()["ok"])

    def test_test_data_body_limit_applies_before_csrf_and_json_parsing(self):
        client = Client(enforce_csrf_checks=True)
        request_body = b'{"settings":{}}'
        for path in TEST_DATA_PATHS:
            with self.subTest(path=path):
                response = client.post(path, data=request_body.ljust(MAX_TEST_DATA_BODY_BYTES + 1),
                                       content_type="application/json")
                self.assertEqual(response.status_code, 413)
                self.assertFalse(response.json()["ok"])
                self.assertIn("no-store", response["Cache-Control"])

    def test_csrf_and_early_body_limit(self):
        self.assertEqual(settings.FILE_UPLOAD_HANDLERS, ["django.core.files.uploadhandler.MemoryFileUploadHandler"])
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post("/tools/json/process/", {"source": "{}"}).status_code, 403)
        client.get("/tools/test-data/")
        token = client.cookies["csrftoken"].value
        accepted = client.post("/tools/test-data/checks/", data=json.dumps({"settings": {
            "type": "text", "required": True, "trim": "unspecified", "min_length": "3", "max_length": "12",
            "min": "0", "max": "100", "phone_locale": "ru_RU",
        }}), content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(accepted.status_code, 200)
        self.assertTrue(accepted.json()["ok"])
        oversized = client.generic("POST", "/tools/json/process/", b"x", content_type="text/plain",
                                   CONTENT_LENGTH=str(MAX_PUBLIC_BODY_BYTES + 1))
        self.assertEqual(oversized.status_code, 413)
        self.assertIn("no-store", oversized["Cache-Control"])
