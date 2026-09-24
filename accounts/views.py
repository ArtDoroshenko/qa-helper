from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from .forms import ProfileForm


@login_required
def dashboard(request):
    return render(request, "accounts/dashboard.html")


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
