import base64
import binascii
import re

from config.upload_validation import MAX_UPLOAD_SIZE, detect_image_type


MAX_BASE64_LENGTH = ((MAX_UPLOAD_SIZE + 2) // 3) * 4 + 16
MAX_DATA_URL_HEADER_LENGTH = 1024  # Includes the data: prefix, excludes the comma.
MIME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$", re.I)
NON_ASCII_DATA = re.compile(r"[^\x00-\x7f\s]")
WHITESPACE = dict.fromkeys(map(ord, (
    " \t\n\r\v\f\x1c\x1d\x1e\x1f\x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)))


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
    encoded = base64.b64encode(data)
    if as_data_url:
        return f"data:{_safe_mime_type(mime_type)};base64,".encode("ascii") + encoded
    return encoded


def decode_value(value):
    source = value.strip()
    mime_type = "application/octet-stream"
    if source.startswith("data:"):
        separator = source.find(",", 5, MAX_DATA_URL_HEADER_LENGTH + 1)
        if separator == -1:
            raise Base64ToolError("Некорректный или слишком длинный заголовок Data URL.")
        media_type, *parameters = source[5:separator].split(";")
        if "base64" not in parameters:
            raise Base64ToolError("Data URL должен содержать Base64-данные.")
        mime_type = _safe_mime_type(media_type)
        source = source[separator + 1:]

    if not source.isascii() and NON_ASCII_DATA.search(source):
        raise Base64ToolError("Некорректные данные Base64.")
    compact = source.translate(WHITESPACE)
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
    return decoded, base_mime_type
