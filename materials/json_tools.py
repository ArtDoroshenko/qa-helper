import json
from dataclasses import dataclass


MAX_JSON_INPUT_BYTES = 1024 * 1024
MAX_JSON_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_JSON_DEPTH = 100


class JsonToolError(ValueError):
    def __init__(self, message, *, token=None):
        super().__init__(message)
        self.token = token


@dataclass(frozen=True)
class JsonNumber:
    lexeme: str


def _reject_constant(value):
    raise JsonToolError(f"Недопустимое числовое значение: {value}.", token=value)


def _object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        _validate_unicode(key)
        if key in result:
            raise JsonToolError(
                f"Повторяющийся ключ «{key}».",
                token=json.dumps(key, ensure_ascii=False),
            )
        result[key] = value
    return result


def parse_json(source):
    if not isinstance(source, str):
        raise JsonToolError("JSON должен быть текстом.")
    try:
        source_size = len(source.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise JsonToolError("JSON содержит некорректный Unicode.") from error
    if source_size > MAX_JSON_INPUT_BYTES:
        raise JsonToolError("JSON не должен превышать 1 МБ.")
    try:
        value = json.loads(
            source,
            parse_int=JsonNumber,
            parse_float=JsonNumber,
            parse_constant=_reject_constant,
            object_pairs_hook=_object_without_duplicates,
        )
    except json.JSONDecodeError as error:
        raise JsonToolError(
            f"Некорректный JSON: строка {error.lineno}, столбец {error.colno}.",
        ) from error
    except JsonToolError as error:
        index = source.rfind(error.token) if error.token else -1
        if index >= 0:
            line = source.count("\n", 0, index) + 1
            previous_newline = source.rfind("\n", 0, index)
            column = index - previous_newline
            raise JsonToolError(f"{error} Строка {line}, столбец {column}.") from error
        raise
    except RecursionError as error:
        raise JsonToolError(f"Вложенность JSON не должна превышать {MAX_JSON_DEPTH} уровней.") from error
    _validate_depth(value)
    return value


def _validate_depth(value):
    stack = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        if depth > MAX_JSON_DEPTH:
            raise JsonToolError(f"Вложенность JSON не должна превышать {MAX_JSON_DEPTH} уровней.")
        if isinstance(current, dict):
            for key in current:
                _validate_unicode(key)
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            _validate_unicode(current)


def _validate_unicode(value):
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise JsonToolError("JSON содержит некорректный Unicode: одиночный суррогат.") from error


class BoundedJsonWriter:
    def __init__(self):
        self.parts = []
        self.size = 0

    def write(self, text):
        size = len(text.encode("utf-8"))
        if self.size + size > MAX_JSON_OUTPUT_BYTES:
            raise JsonToolError("Результат не должен превышать 2 МБ.")
        self.parts.append(text)
        self.size += size

    def string(self, value):
        self.write('"')
        for offset in range(0, len(value), 4096):
            self.write(json.dumps(value[offset:offset + 4096], ensure_ascii=False)[1:-1])
        self.write('"')

    def result(self):
        return "".join(self.parts)


def _serialize(value, indent, sort_keys, writer, level=0):
    if isinstance(value, JsonNumber):
        writer.write(value.lexeme)
    elif value is None:
        writer.write("null")
    elif value is True:
        writer.write("true")
    elif value is False:
        writer.write("false")
    elif isinstance(value, str):
        writer.string(value)
    elif isinstance(value, (list, dict)):
        is_object = isinstance(value, dict)
        writer.write("{" if is_object else "[")
        items = value.items() if is_object else enumerate(value)
        if is_object and sort_keys:
            items = sorted(items, key=lambda item: item[0])
        for index, (key, item) in enumerate(items):
            if index:
                writer.write(",")
            if indent:
                writer.write("\n" + " " * (indent * (level + 1)))
            if is_object:
                writer.string(key)
                writer.write(": " if indent else ":")
            _serialize(item, indent, sort_keys, writer, level + 1)
        if value and indent:
            writer.write("\n" + " " * (indent * level))
        writer.write("}" if is_object else "]")
    else:
        raise JsonToolError("JSON содержит неподдерживаемое значение.")


def process_json(source, operation="format", indent=2, sort_keys=False):
    if operation not in {"format", "minify"}:
        raise JsonToolError("Выберите форматирование или минификацию.")
    if indent not in {2, 4}:
        raise JsonToolError("Отступ должен быть 2 или 4 пробела.")
    value = parse_json(source)
    writer = BoundedJsonWriter()
    _serialize(value, 0 if operation == "minify" else indent, sort_keys, writer)
    return writer.result()
