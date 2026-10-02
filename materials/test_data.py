import csv
import io
import json
import random
import re
import string
import uuid
from datetime import date, timedelta
from decimal import Decimal, DecimalException, InvalidOperation


MAX_ROWS = 1000
MAX_DATASET_BYTES = 2 * 1024 * 1024
MAX_SAVED_DATASETS = 10
FIELD_GROUPS = (
    ("Личные данные", (("name", "ФИО"), ("phone", "Телефон"), ("email", "Email"),
                       ("birth", "Дата рождения"), ("inn_person", "ИНН физлица"), ("snils", "СНИЛС"))),
    ("Работа и местоположение", (("company", "Компания"), ("inn_company", "ИНН юрлица"),
                                 ("ogrn", "ОГРН"), ("job", "Профессия"),
                                 ("city", "Страна / город"), ("address", "Адрес"),
                                 ("coordinates", "Координаты"))),
    ("Технические данные", (("ipv4", "IPv4"), ("uuid", "UUID v4"),
                            ("user_agent", "User Agent"), ("mac", "MAC-адрес"),
                            ("login", "Логин"), ("password", "Тестовый пароль"))),
)
FIELD_LABELS = {key: label for _, group in FIELD_GROUPS for key, label in group}
LOCALES = {"ru_RU": "Русская", "en_US": "English"}


class TestDataError(ValueError):
    pass


def _control_digit(digits, weights):
    return sum(int(digit) * weight for digit, weight in zip(digits, weights)) % 11 % 10


def inn_company(prefix):
    if not re.fullmatch(r"\d{9}", prefix):
        raise TestDataError("ИНН юрлица требует 9 цифр основы.")
    return prefix + str(_control_digit(prefix, (2, 4, 10, 3, 5, 9, 4, 6, 8)))


def inn_person(prefix):
    if not re.fullmatch(r"\d{10}", prefix):
        raise TestDataError("ИНН физлица требует 10 цифр основы.")
    first = str(_control_digit(prefix, (7, 2, 4, 10, 3, 5, 9, 4, 6, 8)))
    eleven = prefix + first
    return eleven + str(_control_digit(eleven, (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8)))


def snils(prefix):
    if not re.fullmatch(r"\d{9}", prefix):
        raise TestDataError("СНИЛС требует 9 цифр основы.")
    if int(prefix) <= 1001998:
        raise TestDataError("Для расчёта контрольного числа СНИЛС основа должна быть больше 001001998.")
    total = sum(int(digit) * (9 - index) for index, digit in enumerate(prefix))
    check = total if total < 100 else 0 if total in (100, 101) else total % 101
    if check == 100:
        check = 0
    return f"{prefix[:3]}-{prefix[3:6]}-{prefix[6:]} {check:02d}"


def ogrn(prefix):
    if not re.fullmatch(r"[15]\d{11}", prefix):
        raise TestDataError("ОГРН требует 12 цифр основы с первой цифрой 1 или 5.")
    return prefix + str(int(prefix) % 11 % 10)


def validate_settings(raw):
    if not isinstance(raw, dict):
        raise TestDataError("Проверьте настройки генератора.")
    fields = raw.get("fields")
    if not isinstance(fields, list) or not fields or len(fields) > len(FIELD_LABELS):
        raise TestDataError("Выберите хотя бы одно поле.")
    if any(not isinstance(field, str) or field not in FIELD_LABELS for field in fields) or len(set(fields)) != len(fields):
        raise TestDataError("Выбраны неизвестные или повторяющиеся поля.")
    try:
        count = int(raw.get("count"))
    except (TypeError, ValueError, OverflowError) as error:
        raise TestDataError("Укажите от 1 до 1000 записей.") from error
    if str(raw.get("count")) != str(count) or not 1 <= count <= MAX_ROWS:
        raise TestDataError("Укажите от 1 до 1000 записей.")
    locale = raw.get("locale")
    if locale not in LOCALES:
        raise TestDataError("Выберите поддерживаемую локаль.")
    try:
        password_length = int(raw.get("password_length", 12))
    except (TypeError, ValueError, OverflowError) as error:
        raise TestDataError("Длина тестового пароля должна быть от 8 до 64.") from error
    if not 8 <= password_length <= 64:
        raise TestDataError("Длина тестового пароля должна быть от 8 до 64.")
    return {"kind": "generator", "fields": fields, "count": count,
            "locale": locale, "password_length": password_length}


_NAMES = {
    "ru_RU": (("Анна", "Иван", "Мария", "Павел", "Ольга", "Дмитрий"),
              ("Иванова", "Петров", "Смирнова", "Кузнецов", "Попова", "Соколов"),
              ("Москва", "Казань", "Екатеринбург"),
              ("Тестовая", "Примерная", "Новая"),
              ("Инженер", "Аналитик", "Тестировщик"), "Россия"),
    "en_US": (("Alice", "Bob", "Carol", "David", "Emma", "Frank"),
              ("Smith", "Johnson", "Brown", "Taylor", "Miller", "Wilson"),
              ("New York", "Austin", "Seattle"),
              ("Example", "Sample", "Main"),
              ("Engineer", "Analyst", "Tester"), "United States"),
}


def _digits(rng, count):
    return "".join(str(rng.randrange(10)) for _ in range(count))


def _row(fields, locale, password_length, rng, index):
    first_names, last_names, cities, streets, jobs, country = _NAMES[locale]
    first, last = rng.choice(first_names), rng.choice(last_names)
    city, street = rng.choice(cities), rng.choice(streets)
    login = f"qa_{index:04d}_{rng.randrange(1000):03d}"
    phone = ("+7" if locale == "ru_RU" else "+1") + _digits(rng, 10)
    birth = date(1950, 1, 1) + timedelta(days=rng.randrange((date(2005, 12, 31) - date(1950, 1, 1)).days + 1))
    values = {
        "name": f"{first} {last}", "phone": phone,
        "email": f"{login}@example.test", "birth": birth.isoformat(),
        "inn_person": inn_person(_digits(rng, 10)),
        "snils": snils(f"{rng.randrange(1001999, 1000000000):09d}"),
        "company": f"{rng.choice(streets)} {('ООО' if locale == 'ru_RU' else 'LLC')}",
        "inn_company": inn_company(_digits(rng, 9)),
        "ogrn": ogrn(rng.choice("15") + _digits(rng, 11)),
        "job": rng.choice(jobs), "city": f"{country} / {city}",
        "address": f"{street} {rng.randrange(1, 200)}, {city}",
        "coordinates": f"{rng.uniform(-90, 90):.6f}, {rng.uniform(-180, 180):.6f}",
        "ipv4": f"198.51.100.{rng.randrange(1, 255)}",
        "uuid": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "user_agent": rng.choice(("QAHelper-Test/1.0", "Mozilla/5.0 (Test Data)")),
        "mac": "02:" + ":".join(f"{rng.randrange(256):02X}" for _ in range(5)),
        "login": login,
        "password": "".join(rng.choice(string.ascii_letters + string.digits + "!#%") for _ in range(password_length)),
    }
    return {field: values[field] for field in fields}


def dataset_bytes(settings, rows):
    return json.dumps({"settings": settings, "rows": rows}, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")


def validate_dataset(settings, rows):
    settings = validate_settings(settings)
    fields = settings["fields"]
    if not isinstance(rows, list) or len(rows) != settings["count"] or len(rows) > MAX_ROWS:
        raise TestDataError("Количество строк не совпадает с настройками или превышает 1000.")
    if any(not isinstance(row, dict) or list(row) != fields or
           any(not isinstance(value, str) for value in row.values()) for row in rows):
        raise TestDataError("Структура набора не совпадает с выбранными полями.")
    try:
        size = len(dataset_bytes(settings, rows))
    except UnicodeEncodeError as error:
        raise TestDataError("Набор содержит недопустимые символы Unicode.") from error
    if size > MAX_DATASET_BYTES:
        raise TestDataError("Набор превышает 2 МиБ (2 097 152 байта). Ничего не сохранено.")
    return settings, rows, size


def generate_dataset(raw_settings, rng=None):
    settings = validate_settings(raw_settings)
    rng = rng or random.SystemRandom()
    rows = [_row(settings["fields"], settings["locale"], settings["password_length"], rng, index + 1)
            for index in range(settings["count"])]
    validate_dataset(settings, rows)
    return settings, rows


def csv_text(fields, rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow([FIELD_LABELS.get(field, field) for field in fields])
    for row in rows:
        writer.writerow([row.get(field, "") for field in fields])
    return stream.getvalue()


def _valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def build_field_checks(raw):
    if not isinstance(raw, dict):
        raise TestDataError("Проверьте требования к полю.")
    field_type = raw.get("type", "text")
    if field_type not in {"text", "email", "phone", "inn_person", "inn_company", "snils", "ogrn", "date", "number"}:
        raise TestDataError("Неизвестный тип поля.")
    required = raw.get("required") is True
    trim = raw.get("trim", "unspecified")
    if trim not in {"unspecified", "trim"}:
        raise TestDataError("Неизвестное правило пробелов.")
    result = []

    def add(value, purpose, expected):
        result.append({"value": str(value), "purpose": purpose, "expected": expected})

    add("", "Пустое значение", "Отклонить: обязательное поле" if required else "Допустить отсутствие значения")
    add("   ", "Пробелы", "Отклонить после удаления пробелов" if required and trim == "trim"
        else "Допустить отсутствие значения" if trim == "trim"
        else "Не определено: обработка пробелов не задана")
    if field_type == "text":
        try:
            minimum, maximum = int(raw.get("min_length", 3)), int(raw.get("max_length", 12))
        except (TypeError, ValueError) as error:
            raise TestDataError("Укажите длины от 1 до 100.") from error
        if not 1 <= minimum <= maximum <= 100:
            raise TestDataError("Укажите длины от 1 до 100, минимум не больше максимума.")
        for length in dict.fromkeys((minimum - 1, minimum, maximum, maximum + 1)):
            add("a" * length, f"Длина {length}",
                "Отклонить: вне диапазона длины" if length < minimum or length > maximum else "Принять по заданной длине")
        for value in ("<script>", "Тест🙂", "\t", "\n", "a\u200bb"):
            add(value, "Спецсимволы / Unicode",
                "Отклонить: вне диапазона длины" if not minimum <= len(value) <= maximum
                else "Допустимо по длине; прочие ограничения не заданы")
    elif field_type == "date":
        minimum, maximum = _valid_date(raw.get("min", "2000-01-01")), _valid_date(raw.get("max", "2030-12-31"))
        if minimum is None or maximum is None or minimum > maximum:
            raise TestDataError("Задайте корректные даты YYYY-MM-DD: минимум не позже максимума.")
        if minimum > date.min:
            add((minimum - timedelta(days=1)).isoformat(), "До минимума", "Отклонить: вне диапазона")
        add(minimum.isoformat(), "Минимальная дата", "Принять")
        add(maximum.isoformat(), "Максимальная дата", "Принять")
        if maximum < date.max:
            add((maximum + timedelta(days=1)).isoformat(), "После максимума", "Отклонить: вне диапазона")
        add("2025-02-30", "Несуществующая дата", "Отклонить: такой даты нет")
        add("01/02/2025", "Другой формат", "Отклонить: ожидается YYYY-MM-DD")
    elif field_type == "number":
        try:
            minimum, maximum = Decimal(str(raw.get("min", "0"))), Decimal(str(raw.get("max", "100")))
        except InvalidOperation as error:
            raise TestDataError("Задайте числовой диапазон.") from error
        if not minimum.is_finite() or not maximum.is_finite() or minimum > maximum:
            raise TestDataError("Задайте числовой диапазон: минимум не больше максимума.")
        try:
            boundaries = (minimum - 1, minimum, maximum, maximum + 1)
        except DecimalException as error:
            raise TestDataError("Числовой диапазон слишком велик для вычисления границ.") from error
        for value in boundaries:
            add(value, "Граница диапазона", "Отклонить: вне диапазона" if value < minimum or value > maximum else "Принять")
        add("abc", "Нечисловое значение", "Отклонить: не число")
    elif field_type in {"inn_person", "inn_company", "snils", "ogrn"}:
        valid = {"inn_person": inn_person("0123456789"), "inn_company": inn_company("012345678"),
                 "snils": snils("012345678"), "ogrn": ogrn("100000000001")}[field_type]
        add(valid, "Формат и контрольная цифра", "Соответствует; наличие в реестре не проверено")
        digits = re.sub(r"\D", "", valid)
        add(digits[:-1], "Недостаточная длина", "Отклонить: неверная длина")
        add(digits[:-1] + str((int(digits[-1]) + 1) % 10), "Неверная контрольная цифра", "Отклонить: контрольная цифра")
        add("X" + digits[1:], "Буква вместо цифры", "Отклонить: неверный формат")
    elif field_type == "email":
        for value, purpose, expected in (("qa@example.test", "Базовый адрес", "Соответствует базовому формату"),
                                          ("qa.example.test", "Нет @", "Отклонить: неверный формат"),
                                          ("qa@", "Нет домена", "Отклонить: неверный формат"),
                                          ("юзер@example.test", "Unicode", "Не определено: политика Unicode не задана")):
            add(value, purpose, expected)
    else:
        phone_locale = raw.get("phone_locale")
        if phone_locale not in LOCALES:
            raise TestDataError("Выберите формат телефона для проверки.")
        prefix = "+7" if phone_locale == "ru_RU" else "+1"
        for value, purpose, expected in ((prefix + "9991234567", f"Формат {prefix} и 10 цифр", "Принять по заданному формату"),
                                          (prefix + "999123456", "Недостаточная длина", "Отклонить: неверная длина"),
                                          (prefix + "abc1234567", "Буквы в номере", "Отклонить: неверный формат")):
            add(value, purpose, expected)
    return result
