from decimal import Decimal, localcontext
from random import Random
from unittest import TestCase
from unittest.mock import patch
from uuid import UUID

from config.upload_validation import MAX_UPLOAD_SIZE
from materials import json_tools
from materials.base64_tools import Base64ToolError, decode_value, encode_bytes
from materials.test_data import MAX_ROWS, TestDataError, build_field_checks, generate_dataset


class Base64ServiceTests(TestCase):
    def test_utf8_and_data_url_round_trip(self):
        data = "Строка QA 🙂".encode("utf-8")
        plain = encode_bytes(data)
        self.assertEqual(decode_value(" \n" + plain.decode("ascii") + "\t"), (data, "application/octet-stream"))
        url = encode_bytes(data, "text/plain", as_data_url=True)
        self.assertEqual(decode_value(url.decode("ascii")), (data, "text/plain"))

    def test_maximum_input_round_trips_as_longer_base64(self):
        data = b"\x00" * MAX_UPLOAD_SIZE
        encoded = encode_bytes(data, "application/octet-stream", as_data_url=True)
        self.assertGreater(len(encoded), MAX_UPLOAD_SIZE)
        decoded, mime = decode_value(encoded.decode("ascii"))
        self.assertTrue(decoded == data)
        self.assertEqual(mime, "application/octet-stream")

    def test_invalid_input_and_limit_errors(self):
        for source in ("", "aG!sbG8=", "data:text/plain,hello", "data:image/png;base64,aGVsbG8="):
            with self.subTest(source=source), self.assertRaises(Base64ToolError):
                decode_value(source)
        with self.assertRaisesRegex(Base64ToolError, "10 МБ"):
            encode_bytes(b"x" * (MAX_UPLOAD_SIZE + 1))


class JsonServiceTests(TestCase):
    def test_preserves_number_lexemes_with_sorting_indents_and_minification(self):
        source = '{"z":-0,"а":9007199254740993,"a":1.2500e+30}'
        formatted = json_tools.process_json(source, indent=4, sort_keys=True)
        self.assertEqual(formatted, '{\n    "a": 1.2500e+30,\n    "z": -0,\n    "а": 9007199254740993\n}')
        self.assertEqual(json_tools.process_json(formatted, operation="minify"),
                         '{"a":1.2500e+30,"z":-0,"а":9007199254740993}')

    def test_rejects_duplicate_keys_invalid_unicode_and_non_json_numbers(self):
        for source, message in (
            (r'{"x":1,"\u0078":2}', "Повторяющийся ключ"),
            (r'{"x":"\ud800"}', "суррогат"),
            ('[NaN]', "Недопустимое числовое значение"),
            ('{\n  "x": }', "строка 2, столбец"),
        ):
            with self.subTest(source=source), self.assertRaisesRegex(json_tools.JsonToolError, message):
                json_tools.process_json(source)

    def test_input_byte_size_and_depth_boundaries(self):
        value = "я" * ((json_tools.MAX_JSON_INPUT_BYTES - 2) // 2)
        allowed = '"' + value + '"'
        self.assertTrue(json_tools.process_json(allowed, operation="minify") == allowed)
        with self.assertRaisesRegex(json_tools.JsonToolError, "1 МБ"):
            json_tools.process_json('"a' + value + '"')
        nesting = json_tools.MAX_JSON_DEPTH - 1
        shallow = "[" * nesting + "0" + "]" * nesting
        self.assertEqual(json_tools.process_json(shallow, operation="minify"), shallow)
        with self.assertRaisesRegex(json_tools.JsonToolError, "Вложенность"):
            json_tools.process_json("[" + shallow + "]")

    def test_formatter_stops_at_output_limit(self):
        with patch.object(json_tools, "MAX_JSON_OUTPUT_BYTES", 3):
            self.assertEqual(json_tools.process_json("[0]", operation="minify"), "[0]")
            with self.assertRaisesRegex(json_tools.JsonToolError, "Результат"):
                json_tools.process_json("[0]")


class DatasetServiceTests(TestCase):
    def test_seeded_generation_keeps_field_order_and_synthetic_values(self):
        options = {"fields": ["uuid", "email", "password"], "count": 3, "locale": "ru_RU", "password_length": 8}
        settings, rows = generate_dataset(options, Random(21))
        self.assertEqual((settings, rows), generate_dataset(options, Random(21)))
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertEqual(list(row), options["fields"])
            self.assertEqual(UUID(row["uuid"]).version, 4)
            self.assertTrue(row["email"].endswith("@example.test"))
            self.assertEqual(len(row["password"]), 8)

    def test_row_boundaries_and_invalid_settings(self):
        options = {"fields": ["name"], "count": MAX_ROWS, "locale": "en_US"}
        self.assertEqual(len(generate_dataset(options, Random(1))[1]), MAX_ROWS)
        for changed in ({"count": 0}, {"count": MAX_ROWS + 1}, {"fields": ["name", "name"]}, {"locale": []}):
            with self.subTest(changed=changed), self.assertRaises(TestDataError):
                generate_dataset({**options, **changed}, Random(1))


class FieldCheckServiceTests(TestCase):
    def test_dates_cover_leap_day_and_reject_invalid_or_reversed_bounds(self):
        checks = build_field_checks({"type": "date", "min": "2024-02-29", "max": "2024-02-29"})
        positions = {row["purpose"]: row["value"] for row in checks}
        self.assertEqual(positions["До минимума"], "2024-02-28")
        self.assertEqual(positions["После максимума"], "2024-03-01")
        for minimum, maximum in (("2023-02-29", "2024-02-29"), ("2024-03-01", "2024-02-29")):
            with self.assertRaises(TestDataError):
                build_field_checks({"type": "date", "min": minimum, "max": maximum})

    def test_numeric_boundaries_are_exact_even_with_small_ambient_precision(self):
        minimum = "123456789012345678901234567890.125"
        maximum = "123456789012345678901234567891.125"
        with localcontext() as context:
            context.prec = 6
            checks = build_field_checks({"type": "number", "min": minimum, "max": Decimal(maximum)})
        boundaries = [row["value"] for row in checks if row["purpose"] == "Граница диапазона"]
        self.assertEqual(boundaries, ["123456789012345678901234567889.125", minimum, maximum,
                                      "123456789012345678901234567892.125"])
        self.assertEqual([row["expected"] for row in checks if row["purpose"] == "Граница диапазона"],
                         ["Отклонить: вне диапазона", "Принять", "Принять", "Отклонить: вне диапазона"])

    def test_scientific_boundaries_and_out_of_range_or_inexact_inputs(self):
        checks = build_field_checks({"type": "number", "min": "1e-100", "max": "1e100"})
        boundaries = [row["value"] for row in checks if row["purpose"] == "Граница диапазона"]
        self.assertEqual(boundaries[0], "-0." + "9" * 100)
        self.assertEqual(boundaries[-1], "1" + "0" * 99 + "1")
        for bound in ("1e101", "1e-101", "9" * 101, "Infinity", 0.1, True):
            with self.subTest(bound=bound), self.assertRaises(TestDataError):
                build_field_checks({"type": "number", "min": 0, "max": bound})

    def test_text_lengths_follow_inclusive_boundaries(self):
        checks = build_field_checks({"type": "text", "min_length": 2, "max_length": 3, "required": True})
        outcomes = {row["value"]: row["expected"] for row in checks if row["purpose"].startswith("Длина")}
        self.assertEqual(outcomes, {
            "a": "Отклонить: вне диапазона длины", "aa": "Принять по заданной длине",
            "aaa": "Принять по заданной длине", "aaaa": "Отклонить: вне диапазона длины",
        })
