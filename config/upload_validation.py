import mimetypes
from pathlib import Path
from uuid import uuid4

from django.core.exceptions import ValidationError
from django.utils.text import get_valid_filename


MAX_UPLOAD_SIZE = 10 * 1024 * 1024
ALLOWED_FILE_TYPES = {
    ".csv": {"text/csv", "application/csv"},
    ".gif": {"image/gif"},
    ".jpeg": {"image/jpeg"},
    ".jpg": {"image/jpeg"},
    ".json": {"application/json", "text/json"},
    ".md": {"text/markdown", "text/plain"},
    ".pdf": {"application/pdf"},
    ".png": {"image/png"},
    ".txt": {"text/plain"},
    ".webp": {"image/webp"},
    ".zip": {"application/zip", "application/x-zip-compressed"},
}
IMAGE_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}


def safe_filename(name, fallback="file"):
    original = Path(name or fallback).name
    try:
        cleaned = get_valid_filename(original)
    except Exception as error:
        raise ValidationError("Некорректное имя файла.") from error
    if not cleaned:
        cleaned = fallback
    suffix = Path(cleaned).suffix.lower()[:12]
    stem = Path(cleaned).stem[:160] or fallback
    return f"{stem}{suffix}"


def detect_image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_uploaded_file(uploaded_file):
    if uploaded_file.size == 0:
        raise ValidationError("Нельзя загрузить пустой файл.")
    if uploaded_file.size > MAX_UPLOAD_SIZE:
        raise ValidationError("Размер файла не должен превышать 10 МБ.")

    name = safe_filename(uploaded_file.name)
    suffix = Path(name).suffix.lower()
    allowed_types = ALLOWED_FILE_TYPES.get(suffix)
    content_type = (uploaded_file.content_type or "").split(";", 1)[0].lower()
    if not allowed_types or content_type not in allowed_types:
        raise ValidationError("Этот тип файла не поддерживается.")

    if content_type in IMAGE_TYPES:
        position = uploaded_file.tell()
        header = uploaded_file.read(32)
        uploaded_file.seek(position)
        if detect_image_type(header) != content_type:
            raise ValidationError("Содержимое изображения не соответствует его типу.")
    return name, content_type


def private_upload_path(prefix, owner_id, original_name):
    suffix = Path(safe_filename(original_name)).suffix.lower()
    return f"{prefix}/{owner_id}/{uuid4().hex}{suffix}"


def guessed_extension(content_type):
    if content_type == "image/jpeg":
        return ".jpg"
    return mimetypes.guess_extension(content_type or "") or ".bin"
