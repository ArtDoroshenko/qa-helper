from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .forms import AttachmentForm, NoteForm
from .models import Attachment, Note


def _is_autosave(request):
    return request.headers.get("x-requested-with") == "XMLHttpRequest"


@login_required
def note_list(request):
    notes = Note.objects.filter(owner=request.user)
    return render(request, "notes/note_list.html", {"notes": notes})


@login_required
@require_http_methods(["GET", "POST"])
def note_create(request):
    form = NoteForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        note = form.save(commit=False)
        note.owner = request.user
        note.save()
        messages.success(request, "Заметка создана.")
        return redirect("note_detail", pk=note.pk)
    return render(request, "notes/note_form.html", {"form": form})


@login_required
@require_http_methods(["GET", "POST"])
def note_detail(request, pk):
    note = get_object_or_404(Note.objects.filter(owner=request.user), pk=pk)
    form = NoteForm(
        request.POST if request.method == "POST" else None,
        instance=note,
    )
    if request.method == "POST":
        if form.is_valid():
            note = form.save()
            if _is_autosave(request):
                saved_at = timezone.localtime(note.updated_at)
                return JsonResponse(
                    {
                        "ok": True,
                        "saved_at": saved_at.strftime("%d.%m.%Y, %H:%M"),
                        "updated_at": saved_at.isoformat(),
                    },
                )
            messages.success(request, "Заметка сохранена.")
            return redirect("note_detail", pk=note.pk)
        if _is_autosave(request):
            return JsonResponse(
                {"ok": False, "errors": form.errors.get_json_data()},
                status=400,
            )
    return render(
        request,
        "notes/note_form.html",
        {
            "form": form,
            "note": note,
            "attachment_form": AttachmentForm(),
            "attachments": Attachment.objects.filter(
                owner=request.user,
                note=note,
            ),
        },
    )


@login_required
@require_http_methods(["GET", "POST"])
def note_delete(request, pk):
    note = get_object_or_404(Note.objects.filter(owner=request.user), pk=pk)
    if request.method == "POST":
        note.delete()
        messages.success(request, "Заметка удалена.")
        return redirect("note_list")
    return render(request, "notes/note_confirm_delete.html", {"note": note})


@login_required
@require_POST
def attachment_upload(request, note_pk):
    note = get_object_or_404(Note.objects.filter(owner=request.user), pk=note_pk)
    form = AttachmentForm(request.POST, request.FILES)
    if form.is_valid():
        uploaded_file = form.cleaned_data["file"]
        Attachment.objects.create(
            owner=request.user,
            note=note,
            file=uploaded_file,
            original_name=form.safe_name,
            content_type=form.content_type,
            size=uploaded_file.size,
        )
        messages.success(request, "Файл прикреплён.")
    else:
        messages.error(request, form.errors["file"][0])
    return redirect("note_detail", pk=note.pk)


@login_required
@require_GET
def attachment_download(request, pk):
    attachment = get_object_or_404(
        Attachment.objects.filter(owner=request.user),
        pk=pk,
    )
    try:
        response = FileResponse(
            attachment.file.open("rb"),
            as_attachment=True,
            filename=attachment.original_name,
            content_type=attachment.content_type,
        )
    except FileNotFoundError as error:
        raise Http404 from error
    response["X-Content-Type-Options"] = "nosniff"
    return response


@login_required
@require_POST
def attachment_delete(request, pk):
    attachment = get_object_or_404(
        Attachment.objects.filter(owner=request.user),
        pk=pk,
    )
    note_pk = attachment.note_id
    attachment.delete()
    messages.success(request, "Файл удалён.")
    return redirect("note_detail", pk=note_pk)
