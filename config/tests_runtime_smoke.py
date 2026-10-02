import tempfile

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.contrib.staticfiles import finders
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import reverse

from materials.models import JsonMaterial
from notes.models import Attachment, Note


SMOKE_SETTINGS = {
    "DEBUG": False,
    "ALLOWED_HOSTS": ["qa-helper.test"],
    "CSRF_TRUSTED_ORIGINS": ["https://qa-helper.test"],
    "SECURE_SSL_REDIRECT": True,
    "SESSION_COOKIE_SECURE": True,
    "CSRF_COOKIE_SECURE": True,
    "STATIC_URL": "/static/",
    "ACCOUNT_ALLOW_SIGNUPS": True,
    "EMAIL_BACKEND": "django.core.mail.backends.locmem.EmailBackend",
}


@override_settings(**SMOKE_SETTINGS)
class RuntimeRouteSmokeTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="route-smoke@example.com", first_name="QA", password="route-smoke-password-9037",
        )
        EmailAddress.objects.create(user=self.user, email=self.user.email, primary=True, verified=True)
        self.note = Note.objects.create(owner=self.user, title="Smoke note")
        self.material = JsonMaterial.objects.create(
            owner=self.user, title="Smoke JSON", source_text="{}", result_text="{}",
            options={"operation": "format", "indent": 2, "sort_keys": False},
        )
        self.client = Client(enforce_csrf_checks=True, HTTP_HOST="qa-helper.test")
        self.get("account_login")
        response = self.post("account_login", {"login": self.user.email, "password": "route-smoke-password-9037"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.pk)
        media = tempfile.TemporaryDirectory()
        self.addCleanup(media.cleanup)
        settings = override_settings(MEDIA_ROOT=media.name)
        settings.enable()
        self.addCleanup(settings.disable)

    def get(self, route, args=(), data=None):
        return self.client.get(reverse(route, args=args), data or {}, secure=True)

    def post(self, route, data=None, args=(), **headers):
        return self.client.post(
            reverse(route, args=args),
            {**(data or {}), "csrfmiddlewaretoken": self.client.cookies["csrftoken"].value},
            secure=True, HTTP_REFERER="https://qa-helper.test/", **headers,
        )

    def test_registered_get_routes_with_real_authenticated_requests(self):
        routes = (
            ("dashboard", ()), ("profile", ()), ("account_email", ()),
            ("account_change_password", ()), ("usersessions_list", ()),
            ("note_list", ()), ("note_create", ()), ("note_detail", (self.note.pk,)),
            ("note_delete", (self.note.pk,)), ("material_list", ()), ("json_tool", ()),
            ("base64_tool", ()), ("healthcheck", ()),
        )
        for route, args in routes:
            with self.subTest(route=route):
                response = self.get(route, args)
                self.assertEqual(response.status_code, 200)
        self.assertEqual(self.get("json_tool", data={"material": self.material.pk}).status_code, 200)
        anonymous = Client(HTTP_HOST="qa-helper.test")
        for route in ("account_login", "account_signup", "account_reset_password"):
            with self.subTest(route=route):
                response = anonymous.get(reverse(route), secure=True)
                self.assertEqual(response.status_code, 200)
                self.assertContains(response, "/static/css/app.css")
        # Static delivery belongs to runserver/nginx; verify that referenced assets exist.
        for asset in ("css/app.css", "js/notes.js", "js/attachments.js", "js/json.js"):
            self.assertIsNotNone(finders.find(asset))
        self.assertEqual(self.client.get("/", HTTP_HOST="unexpected.test", secure=True).status_code, 400)
        self.assertEqual(self.client.get("/", secure=False).status_code, 301)

    def test_note_attachment_material_and_base64_post_flows(self):
        invalid = self.post("note_create", {"title": "", "content": "invalid"})
        self.assertEqual(invalid.status_code, 200)
        created = self.post("note_create", {"title": "New smoke note", "content": "body"})
        self.assertEqual(created.status_code, 302)
        note = Note.objects.get(owner=self.user, title="New smoke note")
        for title, status in (("", 400), ("Saved smoke note", 200)):
            with self.subTest(title=bool(title)):
                response = self.post(
                    "note_detail", {"title": title, "content": "saved"}, (note.pk,),
                    HTTP_X_REQUESTED_WITH="XMLHttpRequest",
                )
                self.assertEqual(response.status_code, status)
        self.assertEqual(self.post("note_bookmark", args=(note.pk,)).status_code, 302)
        self.assertContains(self.get("material_list"), "Saved smoke note")
        self.assertEqual(self.post("attachment_upload", {
            "file": SimpleUploadedFile("smoke.txt", b"attachment", content_type="text/plain"),
        }, (note.pk,)).status_code, 302)
        attachment = Attachment.objects.get(note=note)
        response = self.get("attachment_download", (attachment.pk,))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), b"attachment")
        self.assertEqual(self.post("attachment_delete", args=(attachment.pk,)).status_code, 302)
        self.assertEqual(self.post("note_delete", args=(note.pk,)).status_code, 302)
        self.assertEqual(self.post("profile", {"first_name": "Smoke QA"}).status_code, 302)
        self.assertEqual(self.post("profile", {"first_name": ""}).status_code, 200)
        for operation, value in (("encode", "smoke"), ("decode", "***")):
            self.assertEqual(self.post("base64_tool", {"operation": operation, "text": value}).status_code, 200)
        self.assertEqual(self.post("base64_download", {
            "mode": "decoded", "payload": "c21va2U=", "filename": "smoke.txt",
        }).content, b"smoke")
        self.assertEqual(self.post("base64_download", {
            "mode": "decoded", "payload": "***", "filename": "smoke.txt",
        }).status_code, 400)

    def test_json_posts_errors_ownership_and_account_errors(self):
        payload = {"source": '{"n":1.00}', "operation": "format", "indent": "2"}
        self.assertEqual(self.post("json_process", payload).status_code, 200)
        for source in ('{"bad":}', r'{"bad":"\ud800"}'):
            self.assertEqual(self.post("json_process", {**payload, "source": source}).status_code, 400)
        saved = self.post("json_save", {**payload, "title": "Created smoke JSON"})
        self.assertEqual(saved.status_code, 201)
        material_id = saved.json()["id"]
        self.assertEqual(self.get("json_tool", data={"material": material_id}).status_code, 200)
        self.assertEqual(self.post("json_download", {**payload, "filename": "smoke.json"}).status_code, 200)
        self.assertEqual(self.post("json_rename", {"title": "Renamed smoke JSON"}, (material_id,)).status_code, 302)
        self.assertEqual(self.post("json_delete", args=(material_id,)).status_code, 302)
        for route, args in (("note_detail", (999999,)), ("note_delete", (999999,)),
                            ("attachment_download", (999999,))):
            self.assertEqual(self.get(route, args).status_code, 404)
        self.assertEqual(self.get("json_tool", data={"material": 999999}).status_code, 404)
        for route in ("json_process", "json_save", "json_download", "base64_download"):
            self.assertEqual(self.get(route).status_code, 405)
        self.assertEqual(self.post("account_change_password", {
            "oldpassword": "wrong", "password1": "new", "password2": "mismatch",
        }).status_code, 200)
        self.assertEqual(self.post("account_email", {"email": "invalid", "action_add": ""}).status_code, 200)
        anonymous = Client(enforce_csrf_checks=True, HTTP_HOST="qa-helper.test")
        self.assertEqual(anonymous.post(reverse("json_save"), payload, secure=True).status_code, 403)


@override_settings(**SMOKE_SETTINGS)
class MissingS5SchemaRegressionTests(TransactionTestCase):
    def test_s4_schema_reproduces_both_local_failures_and_full_schema_recovers(self):
        self.assertTrue(connection.settings_dict["NAME"].startswith("test_"))
        user = get_user_model().objects.create_user(email="schema-smoke@example.com", password="test-password")
        Note.objects.create(owner=user, title="Existing S4 note")
        client = Client(HTTP_HOST="qa-helper.test", raise_request_exception=False)
        client.force_login(user)
        executor = MigrationExecutor(connection)
        complete_schema = executor.loader.graph.leaf_nodes()
        try:
            executor.migrate([("notes", "0002_attachment"), ("materials", None)])
            for route, missing_object in (("note_list", "bookmarked_at"), ("material_list", "bookmarked_at")):
                with self.subTest(route=route), self.assertLogs("django.request", level="ERROR"):
                    response = client.get(reverse(route), secure=True)
                    self.assertEqual(response.status_code, 500)
                    self.assertIn(missing_object, str(response.exc_info[1]))
            with self.assertLogs("django.request", level="ERROR"):
                response = client.get(reverse("material_list"), {"type": "json"}, secure=True)
                self.assertEqual(response.status_code, 500)
                self.assertIn("materials_jsonmaterial", str(response.exc_info[1]))
        finally:
            MigrationExecutor(connection).migrate(complete_schema)
        for route in ("note_list", "material_list"):
            self.assertEqual(client.get(reverse(route), secure=True).status_code, 200)
