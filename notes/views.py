from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from .forms import NoteForm
from .models import Note


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
        {"form": form, "note": note},
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
