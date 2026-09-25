import base64
import binascii
import re

from config.upload_validation import MAX_UPLOAD_SIZE, detect_image_type


MAX_BASE64_LENGTH = ((MAX_UPLOAD_SIZE + 2) // 3) * 4 + 16
MIME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$", re.I)


class Base64ToolError(ValueError):
    pass


def _safe_mime_type(value):
    mime_type = (value or "application/octet-stream").split(";", 1)[0].lower()
    if len(mime_type) > 100 or not MIME_PATTERN.fullmatch(mime_type):
        raise Base64ToolError("Некорректный MIME-тип.")
    return mime_type


def encode_bytes(data, mime_type="application/octet-stream", as_data_url=False):
    if len(data) > MAX_UPLOAD_SIZE:
        raise Base64ToolError("Размер данных не должен превышать 10 МБ.")
    encoded = base64.b64encode(data).decode("ascii")
    if as_data_url:
        return f"data:{_safe_mime_type(mime_type)};base64,{encoded}"
    return encoded


def encode_text(value, as_data_url=False):
    return encode_bytes(
        value.encode("utf-8"),
        mime_type="text/plain",
        as_data_url=as_data_url,
    )


def decode_value(value):
    source = value.strip()
    mime_type = "application/octet-stream"
    is_data_url = source.startswith("data:")
    if is_data_url:
        try:
            header, source = source.split(",", 1)
        except ValueError as error:
            raise Base64ToolError("Некорректный Data URL.") from error
        parts = header[5:].split(";")
        if "base64" not in parts[1:]:
            raise Base64ToolError("Data URL должен содержать Base64-данные.")
        mime_type = _safe_mime_type(parts[0])

    compact = re.sub(r"\s+", "", source)
    if not compact:
        raise Base64ToolError("Введите данные Base64.")
    if len(compact) > MAX_BASE64_LENGTH:
        raise Base64ToolError("Размер результата не должен превышать 10 МБ.")
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as error:
        raise Base64ToolError("Некорректные данные Base64.") from error
    if len(decoded) > MAX_UPLOAD_SIZE:
        raise Base64ToolError("Размер результата не должен превышать 10 МБ.")

    base_mime_type = _safe_mime_type(mime_type)
    if base_mime_type.startswith("image/"):
        detected = detect_image_type(decoded[:32])
        if detected != base_mime_type:
            raise Base64ToolError("Данные изображения не соответствуют MIME-типу.")
    return decoded, base_mime_type, is_data_url


def image_preview_data_url(data, mime_type):
    detected = detect_image_type(data[:32])
    if not detected:
        return None
    if mime_type.startswith("image/") and mime_type != detected:
        raise Base64ToolError("Данные изображения не соответствуют MIME-типу.")
    return encode_bytes(data, detected, as_data_url=True)
