import json
import random
import re
import csv
import io
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.contrib.auth import get_user_model
from django.db import connections
from django.test import Client, SimpleTestCase, TestCase, TransactionTestCase
from django.urls import reverse

from .models import DatasetMaterial
from .test_data import (
    MAX_DATASET_BYTES, TestDataError, build_field_checks, csv_text,
    dataset_bytes, generate_dataset, inn_company, inn_person, ogrn, snils,
    validate_dataset, validate_settings,
)


class TestDataLogicTests(SimpleTestCase):
    def test_identifiers_keep_zeroes_and_have_valid_control_digits(self):
        company = inn_company("012345678")
        person = inn_person("0123456789")
        insurance = snils("112233445")
        registry = ogrn("100000000001")
        self.assertEqual(len(company), 10)
        self.assertEqual(len(person), 12)
        self.assertTrue(company.startswith("0"))
        self.assertTrue(person.startswith("0"))
        self.assertRegex(insurance, r"^\d{3}-\d{3}-\d{3} \d{2}$")
        self.assertEqual(len(registry), 13)
        self.assertEqual(int(company[-1]), sum(int(d) * w for d, w in zip(company[:9], (2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10)
        self.assertEqual(int(person[-2]), sum(int(d) * w for d, w in zip(person[:10], (7, 2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10)
        self.assertEqual(int(person[-1]), sum(int(d) * w for d, w in zip(person[:11], (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10)
        digits = re.sub(r"\D", "", insurance)
        total = sum(int(d) * (9 - index) for index, d in enumerate(digits[:9]))
        expected = total if total < 100 else 0 if total in (100, 101) else total % 101
        self.assertEqual(int(digits[-2:]), 0 if expected == 100 else expected)
        self.assertEqual(int(registry[-1]), int(registry[:12]) % 11 % 10)
        with self.assertRaisesRegex(TestDataError, "001001998"):
            snils("001001998")

    def test_generation_has_all_fields_and_localized_phone_and_iso_date(self):
        fields = ["name", "phone", "email", "birth", "inn_person", "snils", "company", "inn_company",
                  "ogrn", "job", "city", "address", "coordinates", "ipv4", "uuid", "user_agent",
                  "mac", "login", "password"]
        for locale, prefix in (("ru_RU", "+7"), ("en_US", "+1")):
            with self.subTest(locale=locale):
                settings, rows = generate_dataset({"fields": fields, "count": 2, "locale": locale,
                                                   "password_length": 14}, random.Random(7))
                self.assertEqual(settings["locale"], locale)
                self.assertEqual(len(rows), 2)
                self.assertEqual(list(rows[0]), fields)
                self.assertRegex(rows[0]["phone"], r"^\+\d{11}$")
                self.assertTrue(rows[0]["phone"].startswith(prefix))
                self.assertRegex(rows[0]["birth"], r"^\d{4}-\d{2}-\d{2}$")
                self.assertEqual(len(rows[0]["password"]), 14)
                self.assertIn("/", rows[0]["city"])

    def test_count_and_size_boundaries(self):
        settings = validate_settings({"fields": ["name"], "count": 1000, "locale": "ru_RU"})
        self.assertEqual(settings["count"], 1000)
        generated_settings, generated_rows = generate_dataset(settings, random.Random(11))
        self.assertEqual(len(generated_rows), 1000)
        self.assertLessEqual(len(dataset_bytes(generated_settings, generated_rows)), MAX_DATASET_BYTES)
        for count in (0, 1001, "1.5"):
            with self.subTest(count=count), self.assertRaises(TestDataError):
                validate_settings({"fields": ["name"], "count": count, "locale": "ru_RU"})
        settings["count"] = 1
        rows = [{"name": ""}]
        overhead = len(dataset_bytes(settings, rows))
        rows[0]["name"] = "a" * (MAX_DATASET_BYTES - overhead)
        self.assertEqual(validate_dataset(settings, rows)[2], MAX_DATASET_BYTES)
        rows[0]["name"] += "a"
        with self.assertRaisesRegex(TestDataError, "2 МиБ"):
            validate_dataset(settings, rows)
        with self.assertRaisesRegex(TestDataError, "Unicode"):
            validate_dataset(settings, [{"name": "\ud800"}])

    def test_csv_escape_and_check_values_are_not_executed_or_fixed(self):
        rendered = csv_text(["name", "email", "phone", "inn_person"],
                            [{"name": "=1+1", "email": "001@example.test", "phone": "+79991234567",
                              "inn_person": "001234567890"}])
        self.assertEqual(list(csv.reader(io.StringIO(rendered)))[1],
                         ["=1+1", "001@example.test", "+79991234567", "001234567890"])
        checks = build_field_checks({"type": "text", "required": True, "min_length": 1, "max_length": 12})
        self.assertTrue(any(row["value"] == "<script>" for row in checks))
        self.assertTrue(any(row["value"] == "\n" for row in checks))
        dates = build_field_checks({"type": "date", "min": "2025-01-01", "max": "2025-12-31"})
        self.assertIn("такой даты нет", next(row["expected"] for row in dates if row["value"] == "2025-02-30"))
        self.assertIn("вне диапазона", next(row["expected"] for row in dates if row["value"] == "2024-12-31"))
        with self.assertRaisesRegex(TestDataError, "корректные даты"):
            build_field_checks({"type": "date", "min": "2025-02-30", "max": "2025-12-31"})
        for locale, prefix in (("ru_RU", "+7"), ("en_US", "+1")):
            phone = build_field_checks({"type": "phone", "phone_locale": locale})
            self.assertEqual(next(row["value"] for row in phone if row["purpose"].startswith("Формат")),
                             prefix + "9991234567")
        with self.assertRaisesRegex(TestDataError, "формат телефона"):
            build_field_checks({"type": "phone"})
        with self.assertRaisesRegex(TestDataError, "слишком велик"):
            build_field_checks({"type": "number", "min": "1e999999999", "max": "1e999999999"})


class TestDataRouteTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(email="dataset@example.com", password="test-password")
        cls.other = get_user_model().objects.create_user(email="other-dataset@example.com", password="test-password")

    def setUp(self):
        self.client.force_login(self.user)

    def post_json(self, route, data):
        return self.client.post(reverse(route), json.dumps(data), content_type="application/json")

    def generated(self):
        response = self.post_json("test_data_generate", {"settings": {"fields": ["name", "inn_person"],
                                                              "count": 2, "locale": "ru_RU"}})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_generate_save_and_exact_reopen_without_regeneration(self):
        generated = self.generated()
        response = self.post_json("test_data_save", {**generated, "title": "Набор QA"})
        self.assertEqual(response.status_code, 201)
        dataset = DatasetMaterial.objects.get(pk=response.json()["id"])
        self.assertEqual(dataset.owner, self.user)
        self.assertEqual(dataset.rows, generated["rows"])
        self.assertEqual(dataset.settings, generated["settings"])
        reopened = self.client.get(reverse("test_data_tool"), {"dataset": dataset.pk})
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.context["initial_dataset"]["rows"], generated["rows"])
        self.assertEqual(reopened.context["initial_dataset"]["settings"], generated["settings"])
        self.assertEqual(list(reopened.context["initial_dataset"]["rows"][0]), generated["settings"]["fields"])
        self.client.logout()
        self.assertTrue(self.client.login(email="dataset@example.com", password="test-password"))
        reopened = self.client.get(reverse("test_data_tool"), {"dataset": dataset.pk})
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.context["initial_dataset"]["rows"], generated["rows"])

    def test_anonymous_user_cannot_open_or_mutate_test_data(self):
        self.client.logout()
        routes = (
            ("get", reverse("test_data_tool"), None),
            ("get", reverse("test_data_tool") + "?dataset=1", None),
            ("post", reverse("test_data_generate"), {}),
            ("post", reverse("test_data_checks"), {}),
            ("post", reverse("test_data_save"), {}),
            ("post", reverse("test_data_delete", args=(1,)), {}),
        )
        for method, url, payload in routes:
            with self.subTest(url=url):
                response = getattr(self.client, method)(url, payload)
                self.assertRedirects(response, f"{reverse('account_login')}?next={url}",
                                     fetch_redirect_response=False)

    def test_save_limit_delete_releases_slot_and_owner_cannot_be_spoofed(self):
        generated = self.generated()
        for index in range(10):
            response = self.post_json("test_data_save", {**generated, "title": f"Набор {index}", "owner": self.other.pk})
            self.assertEqual(response.status_code, 201)
        self.assertEqual(DatasetMaterial.objects.filter(owner=self.user).count(), 10)
        self.assertFalse(DatasetMaterial.objects.filter(owner=self.other).exists())
        self.assertEqual(self.post_json("test_data_save", {**generated, "title": "11-й"}).status_code, 400)
        self.assertEqual(DatasetMaterial.objects.count(), 10)
        first = DatasetMaterial.objects.filter(owner=self.user).first()
        self.assertEqual(self.client.post(reverse("test_data_delete", args=(first.pk,))).status_code, 302)
        self.assertEqual(self.post_json("test_data_save", {**generated, "title": "Теперь 10"}).status_code, 201)

    def test_foreign_ids_are_404_and_signed_result_is_owner_bound(self):
        generated = self.generated()
        self.client.force_login(self.other)
        self.assertEqual(self.post_json("test_data_save", {**generated, "title": "Чужая подпись"}).status_code, 400)
        self.client.force_login(self.user)
        dataset = DatasetMaterial.objects.create(owner=self.other, title="Чужой набор",
            settings=generated["settings"], rows=generated["rows"], row_count=2,
            size_bytes=generated["size_bytes"])
        self.assertEqual(self.client.get(reverse("test_data_tool"), {"dataset": dataset.pk}).status_code, 404)
        self.assertEqual(self.client.post(reverse("test_data_delete", args=(dataset.pk,))).status_code, 404)
        self.assertEqual(self.client.get(reverse("test_data_tool"), {"dataset": "invalid"}).status_code, 404)

    def test_invalid_rows_and_proof_never_create_partial_dataset(self):
        generated = self.generated()
        for data in ({**generated, "title": "x", "rows": []},
                     {**generated, "title": "x", "rows": [{"name": "tampered"}] * 2},
                     {**generated, "title": "x", "proof": "bad"},
                     {**generated, "title": "bad\u0000title"},
                     {**generated, "title": "bad\ud800title"}):
            with self.subTest(data=data.get("proof")):
                self.assertEqual(self.post_json("test_data_save", data).status_code, 400)
        self.assertFalse(DatasetMaterial.objects.exists())

    def test_field_checks_are_transient_and_mutations_require_csrf(self):
        checks = self.post_json("test_data_checks", {"settings": {"type": "text", "min_length": 1,
                                                                  "max_length": 12, "required": True}})
        self.assertEqual(checks.status_code, 200)
        self.assertTrue(any(row["value"] == "<script>" for row in checks.json()["rows"]))
        self.assertFalse(DatasetMaterial.objects.exists())
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        response = client.post(reverse("test_data_generate"), json.dumps({"settings": {"fields": ["name"],
                                      "count": 1, "locale": "ru_RU"}}), content_type="application/json")
        self.assertEqual(response.status_code, 403)
        response = client.post(reverse("test_data_checks"), json.dumps({"settings": {"type": "text"}}),
                               content_type="application/json")
        self.assertEqual(response.status_code, 403)
        generated = self.generated()
        response = client.post(reverse("test_data_save"), json.dumps({**generated, "title": "Blocked"}),
                               content_type="application/json")
        self.assertEqual(response.status_code, 403)
        dataset = DatasetMaterial.objects.create(owner=self.user, title="Protected",
            settings=generated["settings"], rows=generated["rows"], row_count=2,
            size_bytes=generated["size_bytes"])
        self.assertEqual(client.post(reverse("test_data_delete", args=(dataset.pk,))).status_code, 403)
        self.assertTrue(DatasetMaterial.objects.filter(pk=dataset.pk).exists())


class TestDataConcurrentQuotaTests(TransactionTestCase):
    def test_two_simultaneous_saves_compete_for_one_remaining_slot(self):
        user = get_user_model().objects.create_user(email="quota@example.com", password="test-password")
        client = Client()
        client.force_login(user)
        generated = client.post(reverse("test_data_generate"), json.dumps({"settings": {
            "fields": ["name"], "count": 1, "locale": "ru_RU"}}),
            content_type="application/json").json()
        for index in range(9):
            DatasetMaterial.objects.create(owner=user, title=f"Existing {index}",
                settings=generated["settings"], rows=generated["rows"], row_count=1,
                size_bytes=generated["size_bytes"])
        barrier = Barrier(2)

        def save(index):
            connections.close_all()
            try:
                worker = Client()
                worker.force_login(user)
                barrier.wait(timeout=5)
                response = worker.post(reverse("test_data_save"),
                    json.dumps({**generated, "title": f"Concurrent {index}"}),
                    content_type="application/json")
                return response.status_code
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(save, range(2)))
        self.assertCountEqual(statuses, (201, 400))
        self.assertEqual(DatasetMaterial.objects.filter(owner=user).count(), 10)
