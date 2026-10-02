from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from .forms import NoteForm
from .models import Note


class NoteBookmarkTests(TestCase):
    def test_main_note_screen_edits_selected_owned_note_without_creating_on_get(self):
        self.client.force_login(self.user_a)
        second = Note.objects.create(owner=self.user_a, title="Second", content="Selected body")
        before = Note.objects.count()
        url = reverse("note_list")
        response = self.client.get(url)
        self.assertContains(response, 'class="note-workbench"')
        self.assertContains(response, 'data-note-autosave data-autosave-delay="1500"')
        self.assertEqual(response.context["note"].pk, second.pk)
        response = self.client.get(url, {"note": self.note_a.pk, "sort": "title"})
        self.assertEqual(response.context["note"].pk, self.note_a.pk)
        self.assertContains(response, f'action="{reverse("note_detail", args=(self.note_a.pk,))}"')
        self.assertEqual(Note.objects.count(), before)
        for selected in (self.note_b.pk, "invalid", 999999):
            with self.subTest(selected=selected):
                self.assertEqual(self.client.get(url, {"note": selected}).status_code, 404)

    def test_main_note_screen_keeps_filter_page_and_shows_empty_state(self):
        self.client.force_login(self.user_a)
        for index in range(21):
            Note.objects.create(owner=self.user_a, title=f"Filtered {index:02d}")
        response = self.client.get(reverse("note_list"), {"q": "Filtered", "sort": "title", "page": 2})
        self.assertEqual(response.context["note"].title, "Filtered 20")
        self.assertContains(response, 'q=Filtered&amp;sort=title&amp;page=2')
        response = self.client.get(reverse("note_list"), {"q": "no matches"})
        self.assertIsNone(response.context["note"])
        self.assertNotContains(response, "data-note-autosave")
        self.assertContains(response, "Создать заметку")

    def test_new_note_uses_workbench_with_disabled_attachments_and_bookmark(self):
        self.client.force_login(self.user_a)
        response = self.client.get(reverse("note_create"))
        self.assertContains(response, 'class="note-workbench"')
        self.assertContains(response, "Сначала создайте заметку")
        self.assertContains(response, 'type="button" disabled>Добавить файл')
        self.assertContains(response, self.note_a.title)
        self.assertNotContains(response, "data-note-autosave")

    @classmethod
    def setUpTestData(cls):
        cls.user_a = get_user_model().objects.create_user(email="bookmark-a@example.com", password="test-password")
        cls.user_b = get_user_model().objects.create_user(email="bookmark-b@example.com", password="test-password")
        cls.note_a = Note.objects.create(owner=cls.user_a, title="A")
        cls.note_b = Note.objects.create(owner=cls.user_b, title="B")

    def test_owner_can_toggle_without_copying_or_deleting_note(self):
        self.client.force_login(self.user_a)
        url = reverse("note_bookmark", args=(self.note_a.pk,))
        self.assertEqual(self.client.post(url).status_code, 302)
        self.note_a.refresh_from_db()
        self.assertIsNotNone(self.note_a.bookmarked_at)
        self.assertEqual(Note.objects.filter(owner=self.user_a).count(), 1)

        self.client.post(url)
        self.note_a.refresh_from_db()
        self.assertIsNone(self.note_a.bookmarked_at)
        self.assertTrue(Note.objects.filter(pk=self.note_a.pk).exists())

    def test_foreign_bookmark_is_404_and_post_requires_csrf(self):
        self.client.force_login(self.user_a)
        self.assertEqual(self.client.post(reverse("note_bookmark", args=(self.note_b.pk,))).status_code, 404)
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user_a)
        self.assertEqual(client.post(reverse("note_bookmark", args=(self.note_a.pk,))).status_code, 403)

    def test_note_search_sort_and_pagination(self):
        for index in range(25):
            Note.objects.create(owner=self.user_a, title=f"Title {index:02d}", content="needle" if index == 24 else "")
        self.client.force_login(self.user_a)
        response = self.client.get(reverse("note_list"), {"q": "needle"})
        self.assertEqual(list(response.context["page_obj"])[0].title, "Title 24")
        response = self.client.get(reverse("note_list"), {"sort": "title"})
        self.assertEqual(response.context["page_obj"].paginator.per_page, 20)
        self.assertEqual(response.context["page_obj"].paginator.num_pages, 2)

    def test_stale_autosave_preserves_concurrent_bookmark_set_and_unset(self):
        self.client.force_login(self.user_a)
        stamp = timezone.now()
        original_is_valid = NoteForm.is_valid
        for before, after in ((None, stamp), (stamp, None)):
            with self.subTest(bookmarked=after is not None):
                Note.objects.filter(pk=self.note_a.pk).update(bookmarked_at=before)
                def validate_with_concurrent_bookmark(form):
                    valid = original_is_valid(form)
                    Note.objects.filter(pk=form.instance.pk).update(bookmarked_at=after)
                    return valid
                with patch("notes.views.NoteForm.is_valid", new=validate_with_concurrent_bookmark):
                    with CaptureQueriesContext(connection) as captured:
                        response = self.client.post(
                            reverse("note_detail", args=(self.note_a.pk,)),
                            {"title": "Latest title", "content": "Latest content"},
                            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
                        )
                self.assertEqual(response.status_code, 200)
                self.note_a.refresh_from_db()
                self.assertEqual(self.note_a.bookmarked_at, after)
                self.assertEqual(self.note_a.content, "Latest content")
                note_updates = [
                    query["sql"] for query in captured
                    if query["sql"].startswith('UPDATE "notes_note"') and '"title" =' in query["sql"]
                ]
                self.assertEqual(len(note_updates), 1)
                assignments = note_updates[0].split(" SET ", 1)[1].split(" WHERE ", 1)[0]
                for protected in ("owner_id", "bookmarked_at", "created_at"):
                    self.assertNotIn(f'"{protected}"', assignments)

    def test_both_note_sidebars_select_metadata_without_loading_content(self):
        self.client.force_login(self.user_a)
        for url in (reverse("note_create"), reverse("note_detail", args=(self.note_a.pk,))):
            with self.subTest(url=url), CaptureQueriesContext(connection) as captured:
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                sidebar = list(response.context["note_sidebar"])
                self.assertTrue(sidebar)
                for note in sidebar:
                    self.assertIn("content", note.get_deferred_fields())
            sidebar_queries = [
                query["sql"] for query in captured
                if 'FROM "notes_note"' in query["sql"] and "LIMIT 30" in query["sql"]
            ]
            self.assertEqual(len(sidebar_queries), 1)
            self.assertNotIn('"content"', sidebar_queries[0])
