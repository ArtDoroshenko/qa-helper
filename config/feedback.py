from collections import deque
from threading import Lock
from time import monotonic

from django import forms
from django.conf import settings
from django.core.mail import BadHeaderError, send_mail
from django.http import JsonResponse
from django.urls import reverse
from django.views.csrf import csrf_failure as django_csrf_failure
from django.views.decorators.debug import sensitive_post_parameters

from config.public_limits import FEEDBACK_PATH


MAX_MESSAGE_LENGTH = 3000
SEND_LIMIT = 5
WINDOW_SECONDS = 15 * 60
KINDS = {
    "bug": ("Сообщить об ошибке", "QA Kit · Сообщение об ошибке"),
    "idea": ("Предложить улучшение", "QA Kit · Предложение"),
}
PAGE_NAMES = ("home", "base64_tool", "json_tool", "test_data_tool", "text_tool",
              "screenshots_tool", "bug_report_tool")
EXPECTED_FIELDS = {"csrfmiddlewaretoken", "page", "kind", "message"}


class FeedbackQuota:
    def __init__(self):
        self._attempts = deque()
        self._lock = Lock()

    def reserve(self):
        with self._lock:
            now = monotonic()
            while self._attempts and now - self._attempts[0] >= WINDOW_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= SEND_LIMIT:
                return False
            self._attempts.append(now)
            return True


quota = FeedbackQuota()


class FeedbackForm(forms.Form):
    page = forms.ChoiceField(choices=[(name, name) for name in PAGE_NAMES], widget=forms.HiddenInput)
    kind = forms.ChoiceField(label="Тема", choices=[(key, values[0]) for key, values in KINDS.items()],
                             widget=forms.Select(attrs={"id": "feedback-kind"}))
    message = forms.CharField(
        label="Сообщение", max_length=MAX_MESSAGE_LENGTH, strip=False,
        widget=forms.Textarea(attrs={"rows": 7, "aria-describedby": "feedback-limit", "autocomplete": "off"}),
    )


def feedback_context(request):
    match = request.resolver_match
    if not settings.QA_FEEDBACK_ENABLED or not match or match.url_name not in PAGE_NAMES:
        return {}
    return {"qa_feedback_form": FeedbackForm(initial={"page": match.url_name}),
            "qa_feedback_max_length": MAX_MESSAGE_LENGTH}


def _error(message, status, *, headers=None):
    return JsonResponse({"ok": False, "error": message}, status=status, headers=headers)


def csrf_failure(request, reason=""):
    if request.path_info == FEEDBACK_PATH:
        return _error("Не удалось подтвердить запрос. Попробуйте ещё раз.", 403)
    return django_csrf_failure(request, reason=reason)


@sensitive_post_parameters()
def feedback(request):
    if not settings.QA_FEEDBACK_ENABLED:
        return _error("Обратная связь недоступна.", 404)
    if request.method != "POST":
        return _error("Метод запроса не поддерживается.", 405, headers={"Allow": "POST"})

    data = request.POST
    if set(data) != EXPECTED_FIELDS or any(len(data.getlist(field)) != 1 for field in EXPECTED_FIELDS):
        return _error("Проверьте поля сообщения.", 400)
    form = FeedbackForm(data)
    if not form.is_valid() or not form.cleaned_data["message"].strip():
        return _error(f"Проверьте тему, страницу и текст сообщения до {MAX_MESSAGE_LENGTH} символов.", 400)
    if not quota.reserve():
        return _error("Отправка временно недоступна. Попробуйте позже.", 429)

    fields = form.cleaned_data
    page = reverse(fields["page"])
    try:
        sent = send_mail(
            subject=KINDS[fields["kind"]][1],
            message=f"Страница: {page}\n\n{fields['message']}",
            from_email=settings.QA_FEEDBACK_FROM,
            recipient_list=[settings.QA_FEEDBACK_TO],
        )
    except (OSError, BadHeaderError):
        sent = 0
    if sent != 1:
        return _error("Отправка временно недоступна. Попробуйте позже.", 503)
    return JsonResponse({"ok": True})
