from django.contrib.auth.decorators import login_required
from django.http import HttpResponse, HttpResponseBadRequest
from django.shortcuts import render
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
from .forms import Base64ToolForm, DownloadForm


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
