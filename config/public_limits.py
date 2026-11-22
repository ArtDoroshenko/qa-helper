"""Reject oversized public requests before Django parses form or file data."""

from django.conf import settings
from django.http import HttpResponse, JsonResponse


MAX_PUBLIC_BODY_BYTES = 16 * 1024 * 1024
MAX_URLENCODED_BODY_BYTES = 64 * 1024
MAX_TEST_DATA_BODY_BYTES = 8 * 1024
MAX_FEEDBACK_BODY_BYTES = 40 * 1024
FEEDBACK_PATH = "/feedback/"
TEST_DATA_PATHS = {"/tools/test-data/generate/", "/tools/test-data/checks/"}
FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"


class PublicLimitsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method in {"POST", "PUT", "PATCH"}:
            declared = request.META.get("CONTENT_LENGTH")
            try:
                size = int(declared)
            except (TypeError, ValueError):
                size = -1
            is_test_data = request.path_info in TEST_DATA_PATHS
            is_feedback = request.method == "POST" and request.path_info == FEEDBACK_PATH
            if is_test_data:
                limit = MAX_TEST_DATA_BODY_BYTES
            elif is_feedback:
                limit = MAX_FEEDBACK_BODY_BYTES
            elif request.content_type == FORM_CONTENT_TYPE:
                limit = MAX_URLENCODED_BODY_BYTES
            else:
                limit = MAX_PUBLIC_BODY_BYTES
            if is_feedback and not settings.QA_FEEDBACK_ENABLED:
                response = JsonResponse({"ok": False, "error": "Обратная связь недоступна."}, status=404)
            elif is_feedback and request.content_type != FORM_CONTENT_TYPE:
                response = JsonResponse({"ok": False, "error": "Допустима только текстовая форма без вложений."},
                                        status=415)
            elif not 0 <= size <= limit:
                message = "Некорректный или слишком большой запрос."
                if is_test_data or is_feedback:
                    response = JsonResponse({"ok": False, "error": message}, status=413)
                else:
                    response = HttpResponse(message, status=413, content_type="text/plain; charset=utf-8")
            else:
                response = self.get_response(request)
        else:
            response = self.get_response(request)
        response["Cache-Control"] = "no-store, max-age=0"
        response["Pragma"] = "no-cache"
        return response
