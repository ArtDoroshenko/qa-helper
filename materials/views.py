import hashlib
import json

from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from django.core import signing
from django.core.paginator import Paginator
from django.core.exceptions import ValidationError
from django.db.models import Count, Q
from django.db import transaction
from django.http import Http404, HttpResponse, HttpResponseBadRequest, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_http_methods, require_POST

from config.upload_validation import guessed_extension, safe_filename

from .base64_tools import (
    Base64ToolError,
    decode_value,
    encode_bytes,
    encode_text,
    image_preview_data_url,
)
from notes.models import Note

from .forms import (
    Base64ToolForm,
    DownloadForm,
    JsonProcessForm,
    JsonRenameForm,
    JsonSaveForm,
)
from .json_tools import JsonToolError, process_json
from .models import DatasetMaterial, JsonMaterial
from .test_data import (
    FIELD_GROUPS, MAX_SAVED_DATASETS, TestDataError, build_field_checks,
    dataset_bytes, generate_dataset, validate_dataset,
)

MAX_SAVED_JSON = 5
MAX_SAVED_JSON_BYTES = 1024 * 1024


def _json_material_size(source, result, options):
    options_bytes = json.dumps(options, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(source.encode("utf-8")) + len(result.encode("utf-8")) + len(options_bytes)


def _decode_uploaded_base64(uploaded_file):
    try:
        return uploaded_file.read().decode("ascii")
    except UnicodeDecodeError as error:
        raise Base64ToolError("Base64-файл должен содержать ASCII-текст.") from error


def _process_base64(form):
    operation = form.cleaned_data["operation"]
    uploaded_file = form.cleaned_data.get("file")
    source_text = form.cleaned_data.get("text", "")
    output_name = form.cleaned_data.get("output_name")

    if operation == Base64ToolForm.Operation.ENCODE:
        if uploaded_file:
            data = uploaded_file.read()
            mime_type = form.content_type
            result_text = encode_bytes(data, mime_type, form.cleaned_data["as_data_url"])
            source_name = form.safe_name
            preview = image_preview_data_url(data, mime_type)
        else:
            data = source_text.encode("utf-8")
            mime_type = "text/plain"
            result_text = encode_text(source_text, form.cleaned_data["as_data_url"])
            source_name = "encoded.txt"
            preview = None
        return {
            "value": result_text,
            "preview": preview,
            "download_mode": "encoded",
            "download_payload": result_text,
            "download_name": safe_filename(f"{source_name}.base64.txt"),
        }

    encoded_source = _decode_uploaded_base64(uploaded_file) if uploaded_file else source_text
    decoded, mime_type, _ = decode_value(encoded_source)
    preview = image_preview_data_url(decoded, mime_type)
    try:
        result_text = decoded.decode("utf-8")
    except UnicodeDecodeError:
        result_text = "Двоичный результат готов к скачиванию."
    default_name = f"decoded{guessed_extension(mime_type)}"
    return {
        "value": result_text,
        "preview": preview,
        "download_mode": "decoded",
        "download_payload": encoded_source,
        "download_name": safe_filename(output_name or default_name),
    }


@login_required
@require_http_methods(["GET", "POST"])
def base64_tool(request):
    result = None
    if request.method == "POST":
        form = Base64ToolForm(request.POST, request.FILES)
        if form.is_valid():
            try:
                result = _process_base64(form)
            except Base64ToolError as error:
                form.add_error(None, str(error))
    else:
        form = Base64ToolForm()
    return render(
        request,
        "materials/base64_tool.html",
        {"form": form, "result": result},
    )


@login_required
@require_POST
def base64_download(request):
    form = DownloadForm(request.POST)
    if not form.is_valid():
        return HttpResponseBadRequest("Некорректные данные для скачивания.")
    mode = form.cleaned_data["mode"]
    payload = form.cleaned_data["payload"]
    filename = form.cleaned_data["filename"]
    try:
        if mode == "decoded":
            data, content_type, _ = decode_value(payload)
        else:
            data = payload.encode("utf-8")
            content_type = "text/plain"
    except Base64ToolError as error:
        return HttpResponseBadRequest(str(error))
    response = HttpResponse(data, content_type=content_type)
    response["Content-Disposition"] = content_disposition_header(True, filename)
    response["X-Content-Type-Options"] = "nosniff"
    return response


def _json_error(form):
    errors = []
    for field_errors in form.errors.values():
        errors.extend(str(error) for error in field_errors)
    return JsonResponse({"ok": False, "error": errors[0] if errors else "Проверьте данные."}, status=400)


def _process_json_form(form):
    return process_json(
        form.cleaned_data["source"],
        operation=form.cleaned_data["operation"],
        indent=form.cleaned_data["indent"],
        sort_keys=form.cleaned_data["sort_keys"],
    )


@login_required
def material_list(request):
    query = request.GET.get("q", "").strip()
    material_type = request.GET.get("type", "all")
    sort = request.GET.get("sort", "added")
    if material_type not in {"all", "note", "json", "dataset"}:
        material_type = "all"
    if sort not in {"added", "updated", "title"}:
        sort = "added"

    items = []
    if material_type in {"all", "note"}:
        notes = Note.objects.filter(owner=request.user, bookmarked_at__isnull=False).annotate(
            attachment_count=Count("attachments", filter=Q(attachments__owner=request.user)),
        ).only(
            "id", "title", "bookmarked_at", "updated_at",
        )
        if query:
            notes = notes.filter(title__icontains=query)
        items.extend(
            {
                "kind": "note",
                "title": note.title,
                "added_at": note.bookmarked_at,
                "updated_at": note.updated_at,
                "object": note,
            }
            for note in notes
        )
    if material_type in {"all", "json"}:
        json_materials = JsonMaterial.objects.filter(owner=request.user).only(
            "id", "title", "created_at", "updated_at",
        )
        if query:
            json_materials = json_materials.filter(title__icontains=query)
        items.extend(
            {
                "kind": "json",
                "title": material.title,
                "added_at": material.created_at,
                "updated_at": material.updated_at,
                "object": material,
            }
            for material in json_materials
        )
    if material_type in {"all", "dataset"}:
        datasets = DatasetMaterial.objects.filter(owner=request.user).only(
            "id", "title", "created_at", "updated_at", "row_count",
        )
        if query:
            datasets = datasets.filter(title__icontains=query)
        items.extend(
            {
                "kind": "dataset",
                "title": dataset.title,
                "added_at": dataset.created_at,
                "updated_at": dataset.updated_at,
                "object": dataset,
            }
            for dataset in datasets
        )

    if sort == "title":
        items.sort(key=lambda item: (item["title"].casefold(), item["object"].pk))
    else:
        items.sort(key=lambda item: (item[f"{sort}_at"], item["object"].pk), reverse=True)
    page_obj = Paginator(items, 20).get_page(request.GET.get("page"))
    return render(
        request,
        "materials/material_list.html",
        {
            "page_obj": page_obj,
            "query": query,
            "material_type": material_type,
            "sort": sort,
        },
    )


@login_required
@require_http_methods(["GET"])
def json_tool(request):
    material = None
    raw_material_id = request.GET.get("material")
    if raw_material_id:
        try:
            material_id = int(raw_material_id)
        except (TypeError, ValueError) as error:
            raise Http404 from error
        material = get_object_or_404(
            JsonMaterial.objects.filter(owner=request.user),
            pk=material_id,
        )
    return render(request, "materials/json_tool.html", {
        "material": material,
        "saved_count": JsonMaterial.objects.filter(owner=request.user).count(),
        "saved_limit": MAX_SAVED_JSON,
    })


@login_required
@require_POST
def json_process(request):
    form = JsonProcessForm(request.POST, request.FILES)
    if not form.is_valid():
        return _json_error(form)
    try:
        result = _process_json_form(form)
    except JsonToolError as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)
    return JsonResponse({"ok": True, "result": result})


@login_required
@require_POST
def json_download(request):
    form = JsonProcessForm(request.POST, request.FILES)
    if not form.is_valid():
        return HttpResponseBadRequest("Некорректные данные для скачивания.")
    try:
        result = _process_json_form(form)
    except JsonToolError as error:
        return HttpResponseBadRequest(str(error))
    try:
        filename = safe_filename(request.POST.get("filename", "result.json"), fallback="result.json")
    except ValidationError:
        return HttpResponseBadRequest("Некорректное имя файла.")
    if not filename.lower().endswith(".json"):
        filename += ".json"
    response = HttpResponse(result.encode("utf-8"), content_type="application/json; charset=utf-8")
    response["Content-Disposition"] = content_disposition_header(True, filename)
    response["X-Content-Type-Options"] = "nosniff"
    return response


@login_required
@require_POST
def json_save(request):
    form = JsonSaveForm(request.POST)
    if not form.is_valid():
        return _json_error(form)
    material_id = form.cleaned_data.get("material_id")
    existing = None
    if material_id:
        existing = get_object_or_404(
            JsonMaterial.objects.filter(owner=request.user),
            pk=material_id,
        )
    try:
        result = _process_json_form(form)
    except JsonToolError as error:
        return JsonResponse({"ok": False, "error": str(error)}, status=400)

    options = {
        "operation": form.cleaned_data["operation"],
        "indent": form.cleaned_data["indent"],
        "sort_keys": form.cleaned_data["sort_keys"],
    }
    size = _json_material_size(form.cleaned_data["source"], result, options)
    created = not material_id or form.cleaned_data["save_as_new"]
    with transaction.atomic():
        get_user_model().objects.select_for_update().get(pk=request.user.pk)
        if existing:
            existing = get_object_or_404(JsonMaterial.objects.filter(owner=request.user), pk=material_id)
        if created and JsonMaterial.objects.filter(owner=request.user).count() >= MAX_SAVED_JSON:
            return _data_error("Достигнут лимит 5 сохранённых JSON. Удалите ненужный материал.")
        if size > MAX_SAVED_JSON_BYTES:
            old_size = _json_material_size(
                existing.source_text, existing.result_text, existing.options,
            ) if existing and not created else 0
            if size > old_size:
                return _data_error("Сохранённый JSON не должен превышать 1 МиБ (исходник, результат и настройки).")
        material = JsonMaterial(owner=request.user) if created else existing
        material.title = form.cleaned_data["title"]
        material.source_text = form.cleaned_data["source"]
        material.result_text = result
        material.options = options
        material.save()
        saved_count = JsonMaterial.objects.filter(owner=request.user).count()
    return JsonResponse(
        {
            "ok": True,
            "id": material.pk,
            "title": material.title,
            "result": result,
            "created": created,
            "saved_count": saved_count,
        },
        status=201 if created else 200,
    )


@login_required
@require_POST
def json_rename(request, pk):
    material = get_object_or_404(JsonMaterial.objects.filter(owner=request.user), pk=pk)
    form = JsonRenameForm(request.POST)
    if not form.is_valid():
        messages.error(request, form.errors["title"][0])
    else:
        material.title = form.cleaned_data["title"]
        material.save(update_fields=("title", "updated_at"))
        messages.success(request, "JSON-материал переименован.")
    return redirect("material_list")


@login_required
@require_POST
def json_delete(request, pk):
    material = get_object_or_404(JsonMaterial.objects.filter(owner=request.user), pk=pk)
    with transaction.atomic():
        get_user_model().objects.select_for_update().get(pk=request.user.pk)
        get_object_or_404(JsonMaterial.objects.filter(owner=request.user), pk=pk).delete()
    messages.success(request, "JSON-материал удалён.")
    return redirect("material_list")


def _test_data_request(request):
    if request.content_type != "application/json":
        raise TestDataError("Ожидается JSON-запрос.")
    try:
        declared_size = int(request.META.get("CONTENT_LENGTH", "0"))
    except (TypeError, ValueError) as error:
        raise TestDataError("Некорректный размер запроса.") from error
    if declared_size > 8 * 1024 * 1024:
        raise TestDataError("Запрос слишком большой.")
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError) as error:
        raise TestDataError("Некорректный JSON-запрос.") from error
    if not isinstance(data, dict):
        raise TestDataError("Ожидается объект JSON.")
    return data


def _dataset_proof(owner_id, settings, rows):
    digest = hashlib.sha256(dataset_bytes(settings, rows)).hexdigest()
    return signing.Signer(salt="qa-helper-test-data").sign(f"{owner_id}:{digest}")


def _proof_matches(proof, owner_id, settings, rows):
    if not isinstance(proof, str):
        return False
    try:
        signed_value = signing.Signer(salt="qa-helper-test-data").unsign(proof)
    except signing.BadSignature:
        return False
    digest = hashlib.sha256(dataset_bytes(settings, rows)).hexdigest()
    return signed_value == f"{owner_id}:{digest}"


def _data_error(error, status=400):
    return JsonResponse({"ok": False, "error": str(error)}, status=status)


@login_required
@require_http_methods(["GET"])
def test_data_tool(request):
    dataset = None
    raw_id = request.GET.get("dataset")
    if raw_id:
        try:
            dataset_id = int(raw_id)
        except (TypeError, ValueError) as error:
            raise Http404 from error
        dataset = get_object_or_404(DatasetMaterial.objects.filter(owner=request.user), pk=dataset_id)
    initial = None
    if dataset:
        # PostgreSQL JSONB may reorder object keys; restore the selected column order.
        restored_rows = [
            {field: row[field] for field in dataset.settings["fields"]}
            for row in dataset.rows
        ]
        initial = {
            "id": dataset.pk, "title": dataset.title,
            "settings": dataset.settings, "rows": restored_rows,
            "proof": _dataset_proof(request.user.pk, dataset.settings, restored_rows),
        }
    return render(request, "materials/test_data_tool.html", {
        "field_groups": FIELD_GROUPS,
        "saved_count": DatasetMaterial.objects.filter(owner=request.user).count(),
        "saved_limit": MAX_SAVED_DATASETS,
        "dataset": dataset,
        "initial_dataset": initial,
    })


@login_required
@require_POST
def test_data_generate(request):
    try:
        data = _test_data_request(request)
        settings, rows = generate_dataset(data.get("settings"))
        size = len(dataset_bytes(settings, rows))
    except TestDataError as error:
        return _data_error(error)
    return JsonResponse({
        "ok": True, "settings": settings, "rows": rows,
        "proof": _dataset_proof(request.user.pk, settings, rows),
        "size_bytes": size,
    })


@login_required
@require_POST
def test_data_checks(request):
    try:
        data = _test_data_request(request)
        rows = build_field_checks(data.get("settings"))
    except TestDataError as error:
        return _data_error(error)
    return JsonResponse({"ok": True, "rows": rows})


@login_required
@require_POST
def test_data_save(request):
    try:
        data = _test_data_request(request)
        title = data.get("title")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120 or any(ord(char) < 32 for char in title):
            raise TestDataError("Введите название длиной до 120 символов.")
        try:
            title.encode("utf-8")
        except UnicodeEncodeError as error:
            raise TestDataError("Название содержит недопустимые символы Unicode.") from error
        settings, rows, size = validate_dataset(data.get("settings"), data.get("rows"))
        if not _proof_matches(data.get("proof"), request.user.pk, settings, rows):
            raise TestDataError("Набор изменён или устарел. Сгенерируйте его снова.")
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=request.user.pk)
            if DatasetMaterial.objects.filter(owner=request.user).count() >= MAX_SAVED_DATASETS:
                raise TestDataError("Достигнут лимит 10 наборов. Удалите ненужные наборы.")
            dataset = DatasetMaterial.objects.create(
                owner=request.user, title=title.strip(), settings=settings, rows=rows,
                row_count=len(rows), size_bytes=size,
            )
    except TestDataError as error:
        return _data_error(error)
    return JsonResponse({"ok": True, "id": dataset.pk, "title": dataset.title}, status=201)


@login_required
@require_POST
def test_data_delete(request, pk):
    dataset = get_object_or_404(DatasetMaterial.objects.filter(owner=request.user), pk=pk)
    dataset.delete()
    messages.success(request, "Набор тестовых данных удалён. Слот освобождён.")
    return redirect("material_list")
