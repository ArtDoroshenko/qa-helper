from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from unittest.mock import patch

from django.db import connection
from django.shortcuts import render
from django.test import Client, RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from notes.models import Attachment, Note

from .json_tools import JsonToolError, process_json
from .models import JsonMaterial
from .views import material_list


class JsonProcessorTests(TestCase):
    def test_unicode_surrogates_are_rejected_and_valid_pairs_work(self):
        for source in (r'{"text":"\ud800"}', r'{"\udfff":1}', r'{"\ud800":1,"\ud800":2}', '{"text":"' + chr(0xD800) + '"}'):
            with self.subTest(source=repr(source)), self.assertRaisesRegex(JsonToolError, "Unicode"):
                process_json(source)
        self.assertEqual(process_json(r'{"\ud83d\ude00":"\ud83d\ude00"}', operation="minify"), '{"😀":"😀"}')

    def test_output_limit_is_enforced_before_joining(self):
        source = "[" * 90 + "[" + ",".join(["0"] * 10000) + "]" + "]" * 90
        with patch("materials.json_tools.BoundedJsonWriter.result") as join:
            with self.assertRaisesRegex(JsonToolError, "Результат"):
                process_json(source, indent=4)
            join.assert_not_called()

    def test_chunked_string_encoding_preserves_escapes(self):
        import json
        value = ('quote" slash\\\n😀' * 1000)
        source = json.dumps({"text": value})
        self.assertEqual(json.loads(process_json(source))["text"], value)

    def test_numbers_keep_their_original_lexemes(self):
        source = '{"large":123456789012345678901234567890,"decimal":1.2300,"exponent":1e+09}'
        self.assertEqual(
            process_json(source, operation="minify"),
            source,
        )

    def test_recursive_sort_keeps_array_order(self):
        source = '{"z":{"b":1,"a":2},"a":[{"d":4,"c":3},2,1]}'
        self.assertEqual(
            process_json(source, sort_keys=True, indent=2),
            '{\n  "a": [\n    {\n      "c": 3,\n      "d": 4\n    },\n    2,\n    1\n  ],\n  "z": {\n    "a": 2,\n    "b": 1\n  }\n}',
        )

    def test_rejects_duplicate_keys_constants_and_reports_position(self):
        invalid_cases = (
            ('{"a":1,"a":2}', "Повторяющийся ключ"),
            ('{"value":NaN}', "Недопустимое числовое"),
            ('{"broken":}', "строка 1, столбец"),
        )
        for source, message in invalid_cases:
            with self.subTest(source=source), self.assertRaisesRegex(JsonToolError, message):
                process_json(source)


class JsonMaterialFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user_a = get_user_model().objects.create_user(email="json-a@example.com", password="test-password")
        cls.user_b = get_user_model().objects.create_user(email="json-b@example.com", password="test-password")

    def setUp(self):
        self.client.force_login(self.user_a)

    def _save(self, **overrides):
        data = {
            "title": "Ответ API",
            "source": '{"count":10000000000000000001,"ok":true}',
            "operation": "format",
            "indent": "2",
            "sort_keys": "on",
        }
        data.update(overrides)
        return self.client.post(reverse("json_save"), data)

    def test_tool_page_restores_saved_material_and_theme_controls(self):
        material = JsonMaterial.objects.create(
            owner=self.user_a,
            title="Сохранённый JSON",
            source_text='{"safe":"</script><script>alert(1)</script>"}',
            result_text='{\n  "safe": "</script><script>alert(1)</script>"\n}',
            options={"operation": "format", "indent": 4, "sort_keys": True},
        )
        response = self.client.get(reverse("json_tool"), {"material": material.pk})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Сохранённый JSON")
        self.assertContains(response, 'data-json-material-id value="%s"' % material.pk)
        self.assertContains(response, 'data-theme-choice="light"')
        self.assertContains(response, 'data-theme-choice="dark"')
        self.assertNotContains(response, "<script>alert(1)</script>")

    def test_process_text_and_utf8_bom_file(self):
        response = self.client.post(
            reverse("json_process"),
            {"source": '{"b":2,"a":1}', "operation": "format", "indent": "2", "sort_keys": "on"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], '{\n  "a": 1,\n  "b": 2\n}')

        response = self.client.post(
            reverse("json_process"),
            {
                "file": SimpleUploadedFile("input.json", b"\xef\xbb\xbf{\"ok\":true}", content_type="application/json"),
                "operation": "minify",
                "indent": "4",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], '{"ok":true}')

    def test_invalid_json_clears_contract_with_error_response(self):
        response = self.client.post(
            reverse("json_process"),
            {"source": '{"a":}', "operation": "format", "indent": "2"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["ok"])
        self.assertNotIn("result", response.json())

    def test_save_recomputes_result_ignores_spoofed_fields_and_updates(self):
        response = self._save(owner=self.user_b.pk, result="spoofed")
        self.assertEqual(response.status_code, 201)
        material = JsonMaterial.objects.get()
        self.assertEqual(material.owner, self.user_a)
        self.assertNotEqual(material.result_text, "spoofed")
        self.assertIn("10000000000000000001", material.result_text)

        response = self._save(
            material_id=material.pk,
            title="Обновлённый ответ",
            source='{"value":2}',
            operation="minify",
            sort_keys="",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(JsonMaterial.objects.count(), 1)
        material.refresh_from_db()
        self.assertEqual(material.title, "Обновлённый ответ")
        self.assertEqual(material.result_text, '{"value":2}')

    def test_save_as_new_creates_copy_and_foreign_id_is_404(self):
        original = JsonMaterial.objects.create(
            owner=self.user_a,
            title="Оригинал",
            source_text="{}",
            result_text="{}",
            options={"operation": "minify", "indent": 2, "sort_keys": False},
        )
        response = self._save(material_id=original.pk, save_as_new="on")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(JsonMaterial.objects.filter(owner=self.user_a).count(), 2)

        foreign = JsonMaterial.objects.create(owner=self.user_b, title="Чужой", source_text="{}", result_text="{}")
        self.assertEqual(self._save(material_id=foreign.pk).status_code, 404)
        for material_id in (foreign.pk, foreign.pk + 1000):
            for source in ("{}", "invalid"):
                with self.subTest(material_id=material_id, source=source):
                    self.assertEqual(
                        self._save(material_id=material_id, save_as_new="on", source=source).status_code,
                        404,
                    )
        self.assertEqual(JsonMaterial.objects.filter(owner=self.user_a).count(), 2)
        self.assertEqual(self.client.get(reverse("json_tool") + f"?material={foreign.pk}").status_code, 404)

    def test_catalog_filters_owner_type_search_and_bookmarks(self):
        note = Note.objects.create(owner=self.user_a, title="API заметка", bookmarked_at="2026-09-28T10:00:00Z")
        Note.objects.create(owner=self.user_a, title="Не выбрана")
        Note.objects.create(owner=self.user_b, title="Чужая", bookmarked_at="2026-09-28T10:00:00Z")
        JsonMaterial.objects.create(owner=self.user_a, title="API JSON", source_text="{}", result_text="{}")
        JsonMaterial.objects.create(owner=self.user_b, title="Чужой JSON", source_text="{}", result_text="{}")

        response = self.client.get(reverse("material_list"), {"q": "API", "type": "all", "sort": "title"})
        self.assertContains(response, note.title)
        self.assertContains(response, "API JSON")
        self.assertNotContains(response, "Не выбрана")
        self.assertNotContains(response, "Чужая")
        response = self.client.get(reverse("material_list"), {"type": "json"})
        self.assertNotContains(response, note.title)

    def test_download_uses_recomputed_output_and_safe_filename(self):
        response = self.client.post(
            reverse("json_download"),
            {"source": '{"n":1.00}', "operation": "minify", "indent": "2", "filename": "../report"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'{"n":1.00}')
        self.assertIn("report.json", response["Content-Disposition"])
        self.assertNotIn("..", response["Content-Disposition"])

    def test_writes_require_csrf(self):
        material = JsonMaterial.objects.create(owner=self.user_a, title="Удалить", source_text="{}", result_text="{}")
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user_a)
        for url, data in (
            (reverse("json_process"), {"source": "{}", "operation": "format", "indent": "2"}),
            (reverse("json_save"), {"title": "x", "source": "{}", "operation": "format", "indent": "2"}),
            (reverse("json_rename", args=(material.pk,)), {"title": "x"}),
            (reverse("json_delete", args=(material.pk,)), {}),
        ):
            with self.subTest(url=url):
                self.assertEqual(client.post(url, data).status_code, 403)

    def test_unicode_errors_are_400_for_process_save_download(self):
        for route in ("json_process", "json_save", "json_download"):
            for source in (r'{"text":"\ud800"}', r'{"\udfff":1}', r'{"\ud800":1,"\ud800":2}'):
                with self.subTest(route=route, source=source):
                    response = self.client.post(reverse(route), {
                        "source": source, "title": "Unicode", "operation": "format", "indent": "2",
                    })
                    self.assertEqual(response.status_code, 400)
                    self.assertContains(response, "Unicode", status_code=400)
        self.assertFalse(JsonMaterial.objects.exists())
        self.assertEqual(self._save(source=r'{"text":"\ud83d\ude00"}').status_code, 201)
        self.assertIn("😀", JsonMaterial.objects.get().result_text)

    def test_invalid_utf8_and_extension_are_rejected(self):
        for name, content in (("input.json", b'{"text":"\xff"}'), ("input.txt", b"{}")):
            with self.subTest(name=name):
                response = self.client.post(reverse("json_process"), {
                    "file": SimpleUploadedFile(name, content),
                    "operation": "format", "indent": "2",
                })
                self.assertEqual(response.status_code, 400)

    def test_catalog_attachment_counts_are_current_without_n_plus_one(self):
        notes = [
            Note.objects.create(owner=self.user_a, title=f"Note {index}", bookmarked_at="2026-09-29T10:00:00Z")
            for index in range(4)
        ]
        attachment = Attachment.objects.create(
            owner=self.user_a, note=notes[0], file="placeholder.txt", original_name="placeholder.txt",
            content_type="text/plain", size=3,
        )
        request = RequestFactory().get(reverse("material_list"))
        request.user = self.user_a
        with self.assertNumQueries(2):
            response = material_list(request)
        self.assertContains(response, "Заметка · 1 влож.")
        attachment.delete()
        with self.assertNumQueries(2):
            response = material_list(request)
        self.assertContains(response, "Заметка · 0 влож.", count=4)
        self.assertNotContains(response, 'class="material-grid"')
        self.assertContains(response, 'aria-controls="material-chooser"')
        self.assertContains(response, 'id="material-chooser" hidden')

    def test_catalog_queries_load_metadata_only_for_notes_and_json(self):
        Note.objects.create(
            owner=self.user_a, title="Selected note", content="note body",
            bookmarked_at="2026-09-29T10:00:00Z",
        )
        JsonMaterial.objects.create(
            owner=self.user_a, title="Saved JSON", source_text='{"source":1}', result_text='{"result":1}',
        )
        request = RequestFactory().get(reverse("material_list"))
        request.user = self.user_a
        with patch("materials.views.render", wraps=render) as rendering:
            with CaptureQueriesContext(connection) as captured:
                response = material_list(request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(captured), 2)
                page = rendering.call_args.args[2]["page_obj"]
                for item in page:
                    deferred = item["object"].get_deferred_fields()
                    if item["kind"] == "note":
                        self.assertIn("content", deferred)
                    else:
                        self.assertTrue({"source_text", "result_text", "options"}.issubset(deferred))
        for query in captured:
            for text_field in ("content", "source_text", "result_text", "options"):
                self.assertNotIn(f'"{text_field}"', query["sql"])
