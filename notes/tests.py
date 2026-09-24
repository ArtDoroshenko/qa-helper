from datetime import datetime, timezone as datetime_timezone

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Note


class NoteFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user_a = get_user_model().objects.create_user(
            email="owner-a@example.com",
            password="test-password",
        )
        cls.user_b = get_user_model().objects.create_user(
            email="owner-b@example.com",
            password="test-password",
        )
        cls.note_a = Note.objects.create(
            owner=cls.user_a,
            title="Заметка A",
            content="Содержание A",
        )
        cls.note_b = Note.objects.create(
            owner=cls.user_b,
            title="Секретная заметка B",
            content="Содержание B",
        )

    def test_anonymous_user_is_redirected_to_login(self):
        requests = (
            (self.client.get, reverse("note_list"), None),
            (self.client.get, reverse("note_create"), None),
            (
                self.client.post,
                reverse("note_create"),
                {"title": "Чужая заметка", "content": ""},
            ),
            (self.client.get, reverse("note_detail", args=(self.note_a.pk,)), None),
            (
                self.client.post,
                reverse("note_detail", args=(self.note_a.pk,)),
                {"title": "Чужое изменение", "content": ""},
            ),
            (self.client.get, reverse("note_delete", args=(self.note_a.pk,)), None),
            (self.client.post, reverse("note_delete", args=(self.note_a.pk,)), {}),
        )
        for method, url, data in requests:
            with self.subTest(method=method.__name__, url=url):
                response = method(url, data) if data is not None else method(url)
                self.assertRedirects(
                    response,
                    f"{reverse('account_login')}?next={url}",
                    fetch_redirect_response=False,
                )

    def test_user_can_create_and_open_note(self):
        self.client.force_login(self.user_a)
        create_page = self.client.get(reverse("note_create"))
        self.assertContains(create_page, "Создать заметку")
        self.assertNotContains(create_page, "data-note-autosave")
        response = self.client.post(
            reverse("note_create"),
            {"title": "Новая проверка", "content": "Шаги проверки"},
        )

        note = Note.objects.get(title="Новая проверка")
        self.assertEqual(note.owner, self.user_a)
        self.assertEqual(note.content, "Шаги проверки")
        self.assertRedirects(
            response,
            reverse("note_detail", args=(note.pk,)),
            fetch_redirect_response=False,
        )
        response = self.client.get(reverse("note_detail", args=(note.pk,)))
        self.assertContains(response, "Новая проверка")
        self.assertContains(response, "Шаги проверки")

    def test_edit_is_persisted_and_autosave_contract_is_present(self):
        self.client.force_login(self.user_a)
        url = reverse("note_detail", args=(self.note_a.pk,))

        response = self.client.post(
            url,
            {"title": "Обновлённая заметка", "content": "Новый текст"},
        )

        self.assertRedirects(response, url, fetch_redirect_response=False)
        self.note_a.refresh_from_db()
        self.assertEqual(self.note_a.title, "Обновлённая заметка")
        self.assertEqual(self.note_a.content, "Новый текст")
        response = self.client.get(url)
        for text in ("Сохраняется", "Сохранено", "Ошибка сохранения"):
            self.assertContains(response, text)
        content = response.content.decode()
        self.assertLess(
            content.index('class="note-editor-actions"'),
            content.index("data-save-status"),
        )
        self.assertContains(response, "data-last-saved")
        self.assertContains(response, 'data-autosave-delay="1500"')
        self.assertNotContains(response, "Сохранить сейчас")
        self.assertContains(response, "/static/js/notes.js")

    def test_ajax_autosave_persists_valid_data_and_rejects_invalid_title(self):
        self.client.force_login(self.user_a)
        url = reverse("note_detail", args=(self.note_a.pk,))
        response = self.client.post(
            url,
            {"title": "Автосохранение", "content": "Сохранено в фоне"},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.note_a.refresh_from_db()
        self.assertEqual(self.note_a.content, "Сохранено в фоне")
        expected_saved_at = timezone.localtime(self.note_a.updated_at).strftime(
            "%d.%m.%Y, %H:%M",
        )
        self.assertEqual(response.json()["saved_at"], expected_saved_at)
        self.assertEqual(
            response.json()["updated_at"],
            timezone.localtime(self.note_a.updated_at).isoformat(),
        )

        response = self.client.post(
            url,
            {"title": "", "content": "Не должно сохраниться"},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["ok"])
        self.note_a.refresh_from_db()
        self.assertEqual(self.note_a.title, "Автосохранение")
        self.assertEqual(self.note_a.content, "Сохранено в фоне")

    def test_note_dates_are_displayed_in_moscow_time(self):
        self.assertEqual(settings.TIME_ZONE, "Europe/Moscow")
        self.assertTrue(settings.USE_TZ)
        fixed_utc = datetime(2026, 1, 1, 12, 0, tzinfo=datetime_timezone.utc)
        Note.objects.filter(pk=self.note_a.pk).update(updated_at=fixed_utc)
        self.client.force_login(self.user_a)

        for url in (
            reverse("note_list"),
            reverse("note_detail", args=(self.note_a.pk,)),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertContains(response, "01.01.2026, 15:00")

    def test_user_can_confirm_and_delete_own_note(self):
        self.client.force_login(self.user_a)
        url = reverse("note_delete", args=(self.note_a.pk,))
        response = self.client.get(url)
        self.assertContains(response, "Удалить заметку?")
        self.assertContains(response, self.note_a.title)

        response = self.client.post(url)
        self.assertRedirects(
            response,
            reverse("note_list"),
            fetch_redirect_response=False,
        )
        self.assertFalse(Note.objects.filter(pk=self.note_a.pk).exists())

    def test_user_cannot_see_change_or_delete_another_users_note(self):
        self.client.force_login(self.user_a)
        response = self.client.get(reverse("note_list"))
        self.assertNotContains(response, self.note_b.title)

        detail_url = reverse("note_detail", args=(self.note_b.pk,))
        delete_url = reverse("note_delete", args=(self.note_b.pk,))
        for method, url, data in (
            (self.client.get, detail_url, None),
            (self.client.post, detail_url, {"title": "Взлом", "content": ""}),
            (self.client.get, delete_url, None),
            (self.client.post, delete_url, None),
        ):
            with self.subTest(method=method.__name__, url=url):
                response = method(url, data) if data is not None else method(url)
                self.assertEqual(response.status_code, 404)

        self.note_b.refresh_from_db()
        self.assertEqual(self.note_b.title, "Секретная заметка B")

    def test_missing_note_returns_404(self):
        self.client.force_login(self.user_a)
        missing_pk = max(self.note_a.pk, self.note_b.pk) + 1000
        detail_url = reverse("note_detail", args=(missing_pk,))
        delete_url = reverse("note_delete", args=(missing_pk,))
        for method, url, data in (
            (self.client.get, detail_url, None),
            (self.client.post, detail_url, {"title": "Нет", "content": ""}),
            (self.client.get, delete_url, None),
            (self.client.post, delete_url, {}),
        ):
            with self.subTest(method=method.__name__, url=url):
                response = method(url, data) if data is not None else method(url)
                self.assertEqual(response.status_code, 404)

    def test_owner_from_post_is_ignored_on_create_and_edit(self):
        self.client.force_login(self.user_a)
        response = self.client.post(
            reverse("note_create"),
            {
                "title": "Проверка владельца",
                "content": "",
                "owner": self.user_b.pk,
            },
        )
        self.assertEqual(response.status_code, 302)
        note = Note.objects.get(title="Проверка владельца")
        self.assertEqual(note.owner, self.user_a)

        self.client.post(
            reverse("note_detail", args=(note.pk,)),
            {
                "title": "Владелец не изменился",
                "content": "",
                "owner": self.user_b.pk,
            },
        )
        note.refresh_from_db()
        self.assertEqual(note.owner, self.user_a)

    def test_empty_and_long_titles_are_rejected(self):
        self.client.force_login(self.user_a)
        initial_count = Note.objects.count()
        for title in ("", "   ", "я" * 201):
            with self.subTest(length=len(title)):
                response = self.client.post(
                    reverse("note_create"),
                    {"title": title, "content": "Текст"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertIn("title", response.context["form"].errors)
                self.assertEqual(Note.objects.count(), initial_count)

    def test_create_edit_and_delete_require_csrf_token(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user_a)
        requests = (
            (
                reverse("note_create"),
                {"title": "Без CSRF", "content": ""},
            ),
            (
                reverse("note_detail", args=(self.note_a.pk,)),
                {"title": "Без CSRF", "content": ""},
            ),
            (reverse("note_delete", args=(self.note_a.pk,)), {}),
        )
        for url, data in requests:
            with self.subTest(url=url):
                response = client.post(url, data)
                self.assertEqual(response.status_code, 403)

        self.note_a.refresh_from_db()
        self.assertEqual(self.note_a.title, "Заметка A")
        self.assertTrue(Note.objects.filter(pk=self.note_a.pk).exists())
