from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.contrib.auth import get_user_model
from django.db import connections
from django.test import Client, TestCase, TransactionTestCase
from django.urls import reverse

from .models import JsonMaterial
from .views import MAX_SAVED_JSON, MAX_SAVED_JSON_BYTES, _json_material_size


class JsonQuotaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = get_user_model().objects.create_user(email="json-quota@example.com", password="password")
        cls.other = get_user_model().objects.create_user(email="other-json-quota@example.com", password="password")

    def setUp(self):
        self.client.force_login(self.owner)

    def _save(self, **overrides):
        data = {"title": "Saved", "source": '{"v":1}', "operation": "minify", "indent": "2"}
        data.update(overrides)
        return self.client.post(reverse("json_save"), data)

    def test_count_update_save_as_new_and_owner_isolation(self):
        empty_page = self.client.get(reverse("json_tool"))
        self.assertContains(empty_page, 'href="%s?type=json"' % reverse("material_list"))
        self.assertContains(empty_page, 'data-json-quota>0 / 5</span>')
        self.assertContains(empty_page, '/static/js/json.js?v=20261004-quota')
        saved = [JsonMaterial.objects.create(owner=self.owner, title=f"Saved {index}", source_text="{}",
                                             result_text="{}", options={}) for index in range(MAX_SAVED_JSON)]
        JsonMaterial.objects.create(owner=self.other, title="Other", source_text="{}", result_text="{}")
        full_page = self.client.get(reverse("json_tool"), {"material": saved[0].pk})
        self.assertContains(full_page, 'data-json-quota>5 / 5</span>')
        self.assertEqual(self._save().status_code, 400)
        self.assertIn("лимит 5", self._save().json()["error"])
        response = self._save(material_id=saved[0].pk, source='{"v":2}')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["created"])
        self.assertEqual(response.json()["saved_count"], MAX_SAVED_JSON)
        self.assertEqual(self._save(material_id=saved[0].pk, save_as_new="on").status_code, 400)
        foreign = JsonMaterial.objects.get(owner=self.other)
        self.assertEqual(self._save(material_id=foreign.pk, save_as_new="on").status_code, 404)
        self.client.post(reverse("json_delete", args=(saved[1].pk,)))
        response = self._save(material_id=saved[0].pk, save_as_new="on")
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["created"])
        self.assertEqual(response.json()["saved_count"], MAX_SAVED_JSON)
        self.assertEqual(JsonMaterial.objects.filter(owner=self.owner).count(), MAX_SAVED_JSON)
        self.assertEqual(JsonMaterial.objects.filter(owner=self.other).count(), 1)

    def test_new_save_response_and_reloaded_page_agree_on_count(self):
        response = self._save()
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["created"])
        self.assertEqual(response.json()["saved_count"], 1)
        self.assertContains(self.client.get(reverse("json_tool")), 'data-json-quota>1 / 5</span>')

    def test_serialized_utf8_size_and_one_off_processing(self):
        options = {"operation": "minify", "indent": 2, "sort_keys": False}
        base = '{"v":""}'
        available = MAX_SAVED_JSON_BYTES - _json_material_size(base, base, options)
        repeated, trailing = divmod(available, 2)
        at_limit = '{"v":"' + "x" * repeated + '"}' + " " * trailing
        self.assertEqual(_json_material_size(at_limit, at_limit.rstrip(), options), MAX_SAVED_JSON_BYTES)
        self.assertEqual(self._save(source=at_limit).status_code, 201)
        self.assertEqual(self._save(source=at_limit + " ").status_code, 400)
        # Unicode is counted in UTF-8 bytes, not Python characters.
        source = '{"v":"' + "é" * 260_000 + '"}'
        self.assertLess(_json_material_size(source, source, options), MAX_SAVED_JSON_BYTES)
        self.assertEqual(self._save(source=source).status_code, 201)
        too_large = '{"v":"' + "é" * 263_000 + '"}'
        self.assertGreater(_json_material_size(too_large, too_large, options), MAX_SAVED_JSON_BYTES)
        self.assertEqual(self._save(source=too_large).status_code, 400)
        self.assertEqual(JsonMaterial.objects.filter(owner=self.owner).count(), 2)
        self.assertEqual(self.client.post(reverse("json_process"), {
            "source": too_large, "operation": "minify", "indent": "2",
        }).status_code, 200)

    def test_old_oversized_record_can_shrink_or_rename_but_not_grow(self):
        source = '{"v":"' + "x" * 530_000 + '"}'
        old = JsonMaterial.objects.create(owner=self.owner, title="Old", source_text=source,
                                          result_text=source, options={"operation": "minify", "indent": 2,
                                                                       "sort_keys": False})
        self.assertGreater(_json_material_size(old.source_text, old.result_text, old.options), MAX_SAVED_JSON_BYTES)
        self.assertEqual(self.client.get(reverse("json_tool"), {"material": old.pk}).status_code, 200)
        self.assertEqual(self._save(material_id=old.pk, title="Renamed", source=source).status_code, 200)
        self.assertEqual(self._save(material_id=old.pk, source=source[:-2] + 'x"}').status_code, 400)
        reduced = '{"v":"' + "x" * 529_999 + '"}'
        self.assertEqual(self._save(material_id=old.pk, source=reduced).status_code, 200)
        self.assertEqual(self._save(material_id=old.pk, save_as_new="on", source=reduced).status_code, 400)
        self.client.post(reverse("json_delete", args=(old.pk,)))
        self.assertFalse(JsonMaterial.objects.filter(pk=old.pk).exists())


class ConcurrentJsonQuotaTests(TransactionTestCase):
    def test_two_creations_share_one_remaining_slot(self):
        owner = get_user_model().objects.create_user(email="concurrent-json@example.com", password="password")
        JsonMaterial.objects.bulk_create(JsonMaterial(owner=owner, title=f"J{index}", source_text="{}",
                                                     result_text="{}", options={}) for index in range(MAX_SAVED_JSON - 1))
        barrier = Barrier(2)

        def create(index):
            connections.close_all()
            client = Client()
            client.force_login(owner)
            barrier.wait()
            try:
                return client.post(reverse("json_save"), {"title": f"New {index}", "source": "{}",
                                                          "operation": "minify", "indent": "2"}).status_code
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(create, (1, 2)))
        self.assertEqual(sorted(statuses), [201, 400])
        self.assertEqual(JsonMaterial.objects.filter(owner=owner).count(), MAX_SAVED_JSON)
