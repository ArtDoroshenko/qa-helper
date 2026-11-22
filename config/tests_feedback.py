import os
import runpy
from smtplib import SMTPException
from unittest.mock import patch
from urllib.parse import urlencode

from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, SimpleTestCase, override_settings

from config import settings_public
from config.feedback import FeedbackQuota, MAX_MESSAGE_LENGTH, SEND_LIMIT, WINDOW_SECONDS
from config.public_limits import MAX_FEEDBACK_BODY_BYTES


class FeedbackSettingsTests(SimpleTestCase):
    def test_requires_explicit_activation_and_complete_tls_configuration(self):
        env = {
            "QA_FEEDBACK_ENABLED": "1",
            "QA_FEEDBACK_FROM": "sender@example.test",
            "QA_FEEDBACK_TO": "owner@example.test",
            "QA_FEEDBACK_SMTP_HOST": "smtp.example.test",
            "QA_FEEDBACK_SMTP_PORT": "587",
            "QA_FEEDBACK_SMTP_USER": "sender@example.test",
            "QA_FEEDBACK_SMTP_PASSWORD": "fixture-placeholder",
        }
        for changes in (
            {"QA_FEEDBACK_ENABLED": "0"},
            {"QA_FEEDBACK_SMTP_PASSWORD": ""},
            {"QA_FEEDBACK_SMTP_PORT": "invalid"},
            {"QA_FEEDBACK_TO": "owner@example.test,other@example.test"},
            {"QA_FEEDBACK_SMTP_HOST": "https://smtp.example.test"},
        ):
            with self.subTest(changes=changes), patch.dict(os.environ, {**env, **changes}):
                self.assertFalse(runpy.run_path(settings_public.__file__)["QA_FEEDBACK_ENABLED"])
        with patch.dict(os.environ, env):
            config = runpy.run_path(settings_public.__file__)
            self.assertTrue(config["QA_FEEDBACK_ENABLED"])
            self.assertTrue(config["EMAIL_USE_TLS"])
            self.assertFalse(config["EMAIL_USE_SSL"])
            self.assertEqual(config["EMAIL_TIMEOUT"], 5)


@override_settings(
    QA_FEEDBACK_ENABLED=True,
    QA_FEEDBACK_FROM="sender@example.test",
    QA_FEEDBACK_TO="owner@example.test",
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
)
class FeedbackTests(SimpleTestCase):
    path = "/feedback/"
    content_type = "application/x-www-form-urlencoded"

    def setUp(self):
        mail.get_connection()
        mail.outbox.clear()
        quota = patch("config.feedback.quota", new=FeedbackQuota())
        quota.start()
        self.addCleanup(quota.stop)
        self.client = Client(enforce_csrf_checks=True)

    def token(self, page="/"):
        self.assertEqual(self.client.get(page).status_code, 200)
        return self.client.cookies["csrftoken"].value

    def post_feedback(self, fields, token, *, page="home", **headers):
        pairs = [("csrfmiddlewaretoken", token), *fields]
        if page is not None:
            pairs.append(("page", page))
        return self.client.post(
            self.path, urlencode(pairs), content_type=self.content_type, **headers,
        )

    @override_settings(QA_FEEDBACK_ENABLED=False)
    def test_disabled_page_and_navigation_and_no_send(self):
        self.assertNotContains(self.client.get("/"), 'data-feedback-open')
        self.assertNotContains(self.client.get("/"), 'id="feedback-dialog"')
        self.assertEqual(self.client.get(self.path).status_code, 404)
        self.assertEqual(self.client.post(self.path, "kind=idea&message=Test", content_type=self.content_type).status_code, 404)
        self.assertFalse(mail.outbox)

    def test_dialog_on_all_seven_pages_and_endpoint_has_no_get_page(self):
        pages = {
            "/": "home", "/tools/base64/": "base64_tool", "/tools/json/": "json_tool",
            "/tools/test-data/": "test_data_tool", "/tools/text/": "text_tool",
            "/tools/screenshots/": "screenshots_tool", "/tools/bug-report/": "bug_report_tool",
        }
        for path, page_key in pages.items():
            with self.subTest(path=path):
                page = self.client.get(path + "?example=not-a-page-key")
                self.assertEqual(page["Referrer-Policy"], "no-referrer")
                self.assertContains(page, 'id="feedback-dialog"')
                self.assertContains(page, 'data-feedback-open', count=1)
                self.assertContains(page, 'aria-controls="feedback-dialog" disabled')
                self.assertContains(page, 'data-feedback-send disabled')
                self.assertContains(page, f'name="page" value="{page_key}"')
                self.assertContains(page, 'name="csrfmiddlewaretoken"')
                self.assertContains(page, "Не вставляйте пароли, токены, другие секреты и личные данные")
                self.assertNotContains(page, "owner@example.test")
                self.assertNotContains(page, 'href="/feedback/"')
        response = self.client.get(self.path)
        self.assertEqual(response.status_code, 405)
        self.assertEqual(response["Allow"], "POST")
        self.assertFalse(response.json()["ok"])

    def test_standard_csrf_plain_text_and_constant_addresses_subjects_and_canonical_pages(self):
        token = self.token("/tools/base64/")
        content = "Не открывается вкладка.\nВведённый <текст> остаётся обычным текстом."
        for kind, subject, page, path in (
            ("bug", "QA Kit · Сообщение об ошибке", "base64_tool", "/tools/base64/"),
            ("idea", "QA Kit · Предложение", "bug_report_tool", "/tools/bug-report/"),
        ):
            with self.subTest(kind=kind):
                submitted = self.post_feedback(
                    [("kind", kind), ("message", content)], token, page=page,
                    HTTP_ORIGIN="http://testserver", HTTP_REFERER="http://testserver" + path + "?draft=fixture",
                )
                self.assertEqual(submitted.status_code, 200)
                self.assertEqual(submitted.json(), {"ok": True})
                self.assertIn("no-store", submitted["Cache-Control"])
                delivered = mail.outbox[-1]
                self.assertEqual(delivered.subject, subject)
                self.assertEqual(delivered.body, f"Страница: {path}\n\n{content}")
                self.assertEqual(delivered.from_email, "sender@example.test")
                self.assertEqual(delivered.recipients(), ["owner@example.test"])
                self.assertEqual(delivered.reply_to, [])
                self.assertEqual(delivered.content_subtype, "plain")
                self.assertEqual(delivered.attachments, [])

    def test_request_without_csrf_token_is_rejected(self):
        self.token()
        response = self.client.post(self.path, "kind=bug&message=Example", content_type=self.content_type)
        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.json()["ok"])
        self.assertFalse(mail.outbox)

    def test_csrf_rejects_foreign_and_null_origins_even_with_valid_token(self):
        token = self.token()
        for origin in ("https://other.example.test", "null"):
            with self.subTest(origin=origin):
                response = self.post_feedback([("kind", "bug"), ("message", "Пример")], token,
                                              HTTP_ORIGIN=origin)
                self.assertEqual(response.status_code, 403)
                self.assertFalse(response.json()["ok"])
        self.assertFalse(mail.outbox)

    def test_multipart_and_non_form_content_rejected_before_csrf(self):
        attachment = SimpleUploadedFile("test.txt", b"file fixture")
        response = self.client.post(self.path, {"kind": "bug", "message": "Test", "attachment": attachment})
        self.assertEqual(response.status_code, 415)
        self.assertFalse(response.json()["ok"])
        response = self.client.post(self.path, '{"kind":"bug","message":"Test"}', content_type="application/json")
        self.assertEqual(response.status_code, 415)
        self.assertFalse(mail.outbox)

    def test_limits_reject_large_body_before_csrf_and_accept_message_boundary(self):
        oversized = self.client.post(self.path, b"message=" + b"x" * MAX_FEEDBACK_BODY_BYTES,
                                     content_type=self.content_type)
        self.assertEqual(oversized.status_code, 413)
        self.assertFalse(oversized.json()["ok"])
        self.assertIn("no-store", oversized["Cache-Control"])
        token = self.token()
        valid = "🙂" * MAX_MESSAGE_LENGTH
        self.assertEqual(self.post_feedback([("kind", "bug"), ("message", valid)], token).status_code, 200)
        self.assertEqual(mail.outbox[0].body, "Страница: /\n\n" + valid)
        truncated = self.post_feedback([("kind", "bug"), ("message", " " + valid)], token)
        self.assertEqual(truncated.status_code, 400)
        self.assertEqual(len(mail.outbox), 1)

    def test_extra_duplicate_and_invalid_fields_reject_without_sending(self):
        token = self.token()
        normal = [("kind", "bug"), ("message", "Тест")]
        for fields in (
            normal + [("to", "other@example.test")],
            normal + [("subject", "Клиентская тема")],
            normal + [("message", "Ещё одно значение")],
            normal + [("kind", "idea")],
            normal + [("page", "json_tool")],
            normal + [("csrfmiddlewaretoken", token)],
            [("kind", "other"), ("message", "Тест")],
            [("kind", "idea"), ("message", "  \n ")],
        ):
            with self.subTest(fields=fields):
                self.assertEqual(self.post_feedback(fields, token).status_code, 400)
        self.assertFalse(mail.outbox)

    def test_rejects_raw_urls_endpoint_names_and_missing_page_key(self):
        token = self.token()
        fields = [("kind", "idea"), ("message", "Пример")]
        for page in (None, "feedback", "json_process", "/tools/json/?draft=fixture#result",
                     "https://other.example.test/tools/json/", "json_tool?draft=fixture"):
            with self.subTest(page=page):
                rejected = self.post_feedback(fields, token, page=page)
                self.assertEqual(rejected.status_code, 400)
                self.assertFalse(rejected.json()["ok"])
        self.assertFalse(mail.outbox)

    def test_global_quota_fails_closed(self):
        first_token = self.token()
        for _ in range(SEND_LIMIT):
            self.assertEqual(self.post_feedback([("kind", "idea"), ("message", "Тест")], first_token).status_code, 200)
        self.client = Client(enforce_csrf_checks=True)
        next_token = self.token()
        response = self.post_feedback([("kind", "idea"), ("message", "Следующее <сообщение>")], next_token)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json(), {"ok": False, "error": "Отправка временно недоступна. Попробуйте позже."})
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(len(mail.outbox), SEND_LIMIT)

    def test_smtp_failure_is_neutral_and_counts_against_quota(self):
        token = self.token()
        with patch("config.feedback.send_mail", side_effect=SMTPException("fixture smtp details")) as send:
            for _ in range(SEND_LIMIT):
                error = self.post_feedback([("kind", "bug"), ("message", "Тест <сбоя> & текст")], token)
                self.assertEqual(error.status_code, 503)
                self.assertEqual(error.json(), {"ok": False, "error": "Отправка временно недоступна. Попробуйте позже."})
                self.assertIn("no-store", error["Cache-Control"])
            limited = self.post_feedback([("kind", "bug"), ("message", "Тест")], token)
            self.assertEqual(limited.status_code, 429)
            self.assertEqual(send.call_count, SEND_LIMIT)
        self.assertFalse(mail.outbox)

    def test_quota_reopens_after_window(self):
        quota = FeedbackQuota()
        times = [1] * SEND_LIMIT + [WINDOW_SECONDS, WINDOW_SECONDS + 1]
        with patch("config.feedback.monotonic", side_effect=times):
            self.assertTrue(all(quota.reserve() for _ in range(SEND_LIMIT)))
            self.assertFalse(quota.reserve())
            self.assertTrue(quota.reserve())
