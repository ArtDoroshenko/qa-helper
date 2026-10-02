from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from materials.models import DatasetMaterial, JsonMaterial
from notes.models import Note

from .forms import ProfileForm


@login_required
def dashboard(request):
    limit = 4
    notes = list(
        Note.objects.filter(owner=request.user, bookmarked_at__isnull=False)
        .order_by("-updated_at", "-pk")
        .values("id", "title", "updated_at")[:limit]
    )
    materials = list(
        JsonMaterial.objects.filter(owner=request.user)
        .order_by("-updated_at", "-pk")
        .values("id", "title", "updated_at")[:limit]
    )
    datasets = list(
        DatasetMaterial.objects.filter(owner=request.user)
        .order_by("-updated_at", "-pk")
        .values("id", "title", "updated_at", "row_count")[:limit]
    )
    recent_materials = [
        *({**note, "kind": "note"} for note in notes),
        *({**material, "kind": "json"} for material in materials),
        *({**dataset, "kind": "dataset"} for dataset in datasets),
    ]
    recent_materials.sort(
        key=lambda item: (item["updated_at"], item["id"], item["kind"]),
        reverse=True,
    )
    return render(
        request,
        "accounts/dashboard.html",
        {"recent_materials": recent_materials[:limit]},
    )


@login_required
@require_http_methods(["GET", "POST"])
def profile(request):
    form = ProfileForm(
        request.POST if request.method == "POST" else None,
        initial={"first_name": request.user.first_name},
    )
    if request.method == "POST" and form.is_valid():
        request.user.first_name = form.cleaned_data["first_name"]
        request.user.save(update_fields=("first_name",))
        messages.success(request, "Имя успешно обновлено.")
        return redirect("profile")
    return render(request, "accounts/profile.html", {"form": form})
