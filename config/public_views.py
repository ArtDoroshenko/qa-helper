"""Public pages and one-request tools; no models, sessions, or persistence."""

import codecs
import json
from decimal import Decimal, DecimalException

from django.core.exceptions import ValidationError
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from config.upload_validation import detect_image_type, guessed_extension, safe_filename
from materials.base64_tools import Base64ToolError, decode_value, encode_bytes
from materials.forms import Base64ToolForm, JsonProcessForm
from materials.json_tools import JsonToolError, process_json
from materials.test_data import (
    FIELD_GROUPS, TestDataError, build_field_checks, dataset_bytes, generate_dataset,
)


DASHBOARD_TOOLS = (
    ("base64_tool", "binary", "Конвертер", "Преобразуйте Base64, даты и URL, декодируйте JWT и считайте хеши."),
    ("json_tool", "braces", "JSON Lab", "Форматируйте и сравнивайте JSON."),
    ("test_data_tool", "database", "Тестовые данные", "Готовьте наборы данных, проверки полей и тестовые файлы."),
    ("text_tool", "columns-2", "Работа с текстом", "Сравнивайте текст и проверяйте орфографию."),
    ("screenshots_tool", "monitor", "Сравнение скриншотов", "Сравнивайте PNG и JPEG по карте различий или наложению."),
    ("bug_report_tool", "notebook-pen", "Баг-репорт", "Соберите отчёт с шагами и скачайте его в Markdown."),
)


@require_GET
def dashboard(request):
    return render(request, "tools_dashboard.html", {"tools": DASHBOARD_TOOLS})


@require_GET
def health(request):
    return HttpResponse("ok", content_type="text/plain")


@require_GET
def json_tool(request):
    return render(request, "materials/json_tool.html")


def _json_result(request):
    form = JsonProcessForm(request.POST, request.FILES)
    if not form.is_valid():
        errors = [str(error) for values in form.errors.values() for error in values]
        raise JsonToolError(errors[0] if errors else "Проверьте данные.")
    return process_json(
        form.cleaned_data["source"],
        operation=form.cleaned_data["operation"],
        indent=form.cleaned_data["indent"],
        sort_keys=form.cleaned_data["sort_keys"],
    )


@require_POST
def json_process(request):
    try:
        result = _json_result(request)
    except JsonToolError as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)
    return JsonResponse({"ok": True, "result": result})


MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024


def _is_utf8(data):
    decoder = codecs.getincrementaldecoder("utf-8")()
    block_size = 64 * 1024
    try:
        for start in range(0, len(data), block_size):
            decoder.decode(data[start:start + block_size])
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return False
    return True


def _base64_result(form):
    operation = form.cleaned_data["operation"]
    uploaded = form.cleaned_data.get("file")
    source = form.cleaned_data.get("text", "")
    if operation == Base64ToolForm.Operation.ENCODE:
        original = uploaded.read() if uploaded else source.encode("utf-8")
        mime = form.content_type if uploaded else "text/plain"
        data = encode_bytes(original, mime, form.cleaned_data["as_data_url"])
        source_name = form.safe_name if uploaded else "encoded.txt"
        filename = safe_filename(f"{source_name}.base64.txt")
        mime = "text/plain; charset=utf-8"
        is_text = True
    else:
        if uploaded:
            try:
                source = uploaded.read().decode("ascii")
            except UnicodeDecodeError as error:
                raise Base64ToolError("Base64-файл должен содержать ASCII-текст.") from error
        data, mime = decode_value(source)
        original = data
        filename = safe_filename(form.cleaned_data.get("output_name") or f"decoded{guessed_extension(mime)}")
        is_text = _is_utf8(data)

    response = HttpResponse(data, content_type=mime)
    response["Content-Disposition"] = content_disposition_header(True, filename)
    response["X-QA-Result-Text"] = "1" if is_text else "0"
    preview_type = detect_image_type(original[:32]) if len(original) <= MAX_PREVIEW_IMAGE_BYTES else None
    if preview_type:
        response["X-QA-Preview-Type"] = preview_type
    return response


@require_http_methods(["GET", "POST"])
def base64_tool(request):
    if request.method == "GET":
        return render(request, "materials/base64_tool.html", {"form": Base64ToolForm()})
    form = Base64ToolForm(request.POST, request.FILES)
    if not form.is_valid():
        errors = [str(error) for values in form.errors.values() for error in values]
        return JsonResponse({"ok": False, "error": errors[0] if errors else "Проверьте данные."}, status=400)
    try:
        return _base64_result(form)
    except (Base64ToolError, ValidationError) as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)


@require_GET
def test_data_tool(request):
    return render(request, "materials/test_data_tool.html", {"field_groups": FIELD_GROUPS})


def _test_data_settings(request):
    if request.content_type != "application/json":
        raise TestDataError("Ожидается JSON-запрос.")
    try:
        data = json.loads(request.body, parse_float=Decimal)
    except (ValueError, RecursionError, DecimalException) as error:
        raise TestDataError("Некорректный JSON-запрос.") from error
    if not isinstance(data, dict) or data.keys() != {"settings"} or not isinstance(data["settings"], dict):
        raise TestDataError("Ожидается объект JSON с настройками в поле settings.")
    return data["settings"]


@require_POST
def test_data_generate(request):
    try:
        settings, rows = generate_dataset(_test_data_settings(request))
        size = len(dataset_bytes(settings, rows))
    except TestDataError as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)
    return JsonResponse({"ok": True, "settings": settings, "rows": rows, "size_bytes": size})


@require_POST
def test_data_checks(request):
    try:
        rows = build_field_checks(_test_data_settings(request))
    except TestDataError as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)
    return JsonResponse({"ok": True, "rows": rows})


@require_GET
def text_tool(request):
    return render(request, "materials/text_tool.html")


@require_GET
def screenshots_tool(request):
    return render(request, "materials/screenshots_tool.html")


@require_GET
def bug_report_tool(request):
    return render(request, "materials/bug_report_tool.html")
