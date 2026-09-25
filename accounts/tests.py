from allauth.account.models import EmailAddress
from allauth.usersessions.models import UserSession
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import AuthenticationEvent


class UserManagerTests(TestCase):
    def test_create_user_uses_email_as_identifier(self):
        user = get_user_model().objects.create_user(
            email="qa@example.com",
            password="test-password",
        )

        self.assertEqual(user.email, "qa@example.com")
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.check_password("test-password"))

    def test_create_user_requires_email(self):
        with self.assertRaisesMessage(ValueError, "Email is required"):
            get_user_model().objects.create_user(email="", password="test-password")

    def test_create_user_normalizes_email_domain(self):
        user = get_user_model().objects.create_user(
            email="QA@EXAMPLE.COM",
            password="test-password",
        )

        self.assertEqual(user.email, "qa@example.com")

    def test_duplicate_email_is_rejected(self):
        user_model = get_user_model()
        user_model.objects.create_user(
            email="qa@example.com",
            password="test-password",
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            user_model.objects.create_user(
                email="qa@example.com",
                password="another-password",
            )

    def test_case_insensitive_duplicate_email_is_rejected_by_database(self):
        user_model = get_user_model()
        user_model.objects.create_user(
            email="qa@example.com",
            password="test-password",
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            user_model.objects.bulk_create(
                [user_model(email="QA@EXAMPLE.COM")],
            )

    def test_direct_model_save_normalizes_full_email(self):
        user = get_user_model()(email="Admin@EXAMPLE.COM")
        user.set_password("test-password")

        user.save()

        self.assertEqual(user.email, "admin@example.com")

    def test_create_superuser_sets_required_flags(self):
        user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="test-password",
        )

        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertTrue(
            EmailAddress.objects.filter(
                user=user,
                email=user.email,
                primary=True,
                verified=True,
            ).exists(),
        )

    def test_create_superuser_rejects_missing_staff_flag(self):
        with self.assertRaisesMessage(ValueError, "is_staff=True"):
            get_user_model().objects.create_superuser(
                email="admin@example.com",
                password="test-password",
                is_staff=False,
            )

    def test_create_superuser_rejects_missing_superuser_flag(self):
        with self.assertRaisesMessage(ValueError, "is_superuser=True"):
            get_user_model().objects.create_superuser(
                email="admin@example.com",
                password="test-password",
                is_superuser=False,
            )


@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
)
class AccountFlowTests(TestCase):
    def test_dashboard_redirects_anonymous_user_to_login(self):
        response = self.client.get(reverse("dashboard"))

        self.assertRedirects(
            response,
            f"{reverse('account_login')}?next={reverse('dashboard')}",
            fetch_redirect_response=False,
        )

    def test_signup_form_uses_email_without_username(self):
        response = self.client.get(reverse("account_signup"))

        self.assertEqual(response.status_code, 200)
        self.assertIn("first_name", response.context["form"].fields)
        self.assertIn("email", response.context["form"].fields)
        self.assertNotIn("username", response.context["form"].fields)
        content = response.content.decode()
        self.assertLess(
            content.index('id="id_first_name"'),
            content.index('id="id_email"'),
        )
        self.assertLess(
            content.index('id="id_password1"'),
            content.index('id="id_password2"'),
        )
        self.assertLess(
            content.index('id="id_password2"'),
            content.index('class="password-help"'),
        )

    def test_login_uses_project_layout(self):
        response = self.client.get(reverse("account_login"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "QA Helper")
        self.assertContains(response, "/static/css/app.css")
        self.assertContains(response, 'class="account-panel"')
        self.assertContains(response, "С возвращением.")
        self.assertContains(response, "Запомнить меня")
        self.assertNotContains(response, "Menu:")

    def test_signup_creates_unverified_user_and_sends_confirmation(self):
        response = self.client.post(
            reverse("account_signup"),
            {
                "first_name": "Артём",
                "email": "new-user@example.com",
                "password1": "safe-test-password-4827",
                "password2": "safe-test-password-4827",
            },
        )

        self.assertEqual(response.status_code, 302)
        user = get_user_model().objects.get(email="new-user@example.com")
        self.assertEqual(user.first_name, "Артём")
        email_address = EmailAddress.objects.get(user=user)
        self.assertFalse(email_address.verified)
        self.assertEqual(len(mail.outbox), 1)
        self.assertNotIn("_auth_user_id", self.client.session)

        self.client.post(
            reverse("account_login"),
            {"login": user.email, "password": "safe-test-password-4827"},
        )

        self.assertNotIn("_auth_user_id", self.client.session)

    def test_signup_requires_name(self):
        response = self.client.post(
            reverse("account_signup"),
            {
                "first_name": "",
                "email": "nameless@example.com",
                "password1": "safe-test-password-4827",
                "password2": "safe-test-password-4827",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("first_name", response.context["form"].errors)
        self.assertFalse(
            get_user_model().objects.filter(email="nameless@example.com").exists()
        )

    @override_settings(ACCOUNT_ALLOW_SIGNUPS=False)
    def test_closed_signup_rejects_get_and_post_without_creating_user(self):
        signup_url = reverse("account_signup")

        response = self.client.get(signup_url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Регистрация закрыта")
        self.assertNotContains(response, "Создать аккаунт")

        response = self.client.post(
            signup_url,
            {
                "first_name": "Новый пользователь",
                "email": "closed-signup@example.com",
                "password1": "safe-test-password-4827",
                "password2": "safe-test-password-4827",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            get_user_model().objects.filter(email="closed-signup@example.com").exists()
        )

    @override_settings(ACCOUNT_ALLOW_SIGNUPS=False)
    def test_closed_signup_does_not_block_existing_verified_user_login(self):
        password = "safe-test-password-4827"
        user = get_user_model().objects.create_user(
            email="demo-user@example.com",
            password=password,
        )
        EmailAddress.objects.create(
            user=user,
            email=user.email,
            primary=True,
            verified=True,
        )

        response = self.client.post(
            reverse("account_login"),
            {"login": user.email, "password": password},
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.session.get("_auth_user_id"), str(user.pk))

    def test_authenticated_user_can_open_dashboard(self):
        user = get_user_model().objects.create_user(
            email="qa@example.com",
            password="safe-test-password-4827",
            first_name="Артём",
        )
        self.client.force_login(user)

        response = self.client.get(reverse("dashboard"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, user.first_name)
        self.assertContains(response, reverse("profile"))
        self.assertContains(response, reverse("usersessions_list"))
        self.assertContains(response, "/static/css/app.css")
        self.assertContains(response, 'class="workspace"')

    def test_verified_user_login_creates_active_session(self):
        password = "safe-test-password-4827"
        user = get_user_model().objects.create_user(
            email="Verified@Example.COM",
            password=password,
        )
        self.assertEqual(user.email, "verified@example.com")
        EmailAddress.objects.create(
            user=user,
            email=user.email,
            primary=True,
            verified=True,
        )

        response = self.client.post(
            reverse("account_login"),
            {"login": "VERIFIED@EXAMPLE.COM", "password": password},
        )

        self.assertRedirects(
            response,
            reverse("dashboard"),
            fetch_redirect_response=False,
        )
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))
        self.assertTrue(UserSession.objects.filter(user=user).exists())
        event = AuthenticationEvent.objects.get(
            event_type=AuthenticationEvent.Type.LOGIN_SUCCESS,
            user=user,
        )
        self.assertEqual(event.email, user.email)

    def test_failed_login_records_metadata_without_password(self):
        response = self.client.post(
            reverse("account_login"),
            {"login": "MISSING@EXAMPLE.COM", "password": "secret-value"},
            REMOTE_ADDR="127.0.0.1",
            HTTP_USER_AGENT="QA test browser",
        )

        self.assertEqual(response.status_code, 200)
        event = AuthenticationEvent.objects.get(
            event_type=AuthenticationEvent.Type.LOGIN_FAILED,
        )
        self.assertIsNone(event.user)
        self.assertEqual(event.email, "missing@example.com")
        self.assertEqual(event.ip_address, "127.0.0.1")
        self.assertEqual(event.user_agent, "QA test browser")
        self.assertNotIn("secret-value", str(event.__dict__))

    def test_logout_is_recorded(self):
        user = get_user_model().objects.create_user(
            email="qa@example.com",
            password="safe-test-password-4827",
        )
        self.client.force_login(user)
        AuthenticationEvent.objects.all().delete()

        response = self.client.post(reverse("account_logout"))

        self.assertRedirects(
            response,
            reverse("account_login"),
            fetch_redirect_response=False,
        )
        event = AuthenticationEvent.objects.get(
            event_type=AuthenticationEvent.Type.LOGOUT,
        )
        self.assertEqual(event.user, user)
        self.assertEqual(event.email, user.email)

    def test_authentication_event_admin_is_read_only(self):
        model_admin = admin.site._registry[AuthenticationEvent]

        self.assertFalse(model_admin.has_add_permission(None))
        self.assertFalse(model_admin.has_change_permission(None))
        self.assertFalse(model_admin.has_delete_permission(None))

    def test_superuser_can_still_log_in_to_admin_with_email(self):
        password = "safe-test-password-4827"
        user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password=password,
        )

        response = self.client.post(
            reverse("admin:login"),
            {
                "username": user.email,
                "password": password,
                "next": reverse("admin:index"),
            },
        )

        self.assertRedirects(
            response,
            reverse("admin:index"),
            fetch_redirect_response=False,
        )
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))

    def test_superuser_can_log_in_to_public_account_without_confirmation(self):
        password = "safe-test-password-4827"
        user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password=password,
        )

        response = self.client.post(
            reverse("account_login"),
            {"login": user.email, "password": password},
        )

        self.assertRedirects(
            response,
            reverse("dashboard"),
            fetch_redirect_response=False,
        )
        self.assertEqual(self.client.session["_auth_user_id"], str(user.pk))


class ProfileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="profile@example.com", first_name="Мария", password="test-password",
        )
        cls.other = get_user_model().objects.create_user(
            email="other@example.com", first_name="Олег", password="test-password",
        )

    def test_anonymous_requests_redirect_to_login(self):
        for method in (self.client.get, self.client.post):
            with self.subTest(method=method.__name__):
                response = method(reverse("profile"))
                self.assertRedirects(
                    response, f"{reverse('account_login')}?next={reverse('profile')}",
                    fetch_redirect_response=False,
                )

    def test_profile_data_links_and_navigation(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse("profile"))
        for text in ("Мария", "profile@example.com", "Пользователь", "Уровень доступа"):
            self.assertContains(response, text)
        self.assertNotContains(response, "other@example.com")
        for name in ("account_email", "account_change_password", "usersessions_list"):
            self.assertContains(response, f'href="{reverse(name)}"')
        response = self.client.get(reverse("dashboard"))
        self.assertContains(response, f'href="{reverse("profile")}"', count=2)

    def test_update_changes_only_current_users_name(self):
        self.client.force_login(self.user)
        response = self.client.post(reverse("profile"), {
            "first_name": "  Анна  ", "user_id": self.other.pk,
            "email": "changed@example.com", "is_staff": "True", "is_superuser": "True",
        }, follow=True)
        self.assertRedirects(response, reverse("profile"))
        self.assertContains(response, "Имя успешно обновлено.")
        self.user.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.user.first_name, "Анна")
        self.assertEqual(self.other.first_name, "Олег")
        self.assertEqual(self.user.email, "profile@example.com")
        self.assertFalse(self.user.is_staff)
        self.assertFalse(self.user.is_superuser)

    def test_empty_whitespace_and_long_names_are_rejected(self):
        self.client.force_login(self.user)
        for name in ("", "   ", "я" * 151):
            with self.subTest(name=name):
                response = self.client.post(reverse("profile"), {"first_name": name})
                self.assertEqual(response.status_code, 200)
                self.assertIn("first_name", response.context["form"].errors)
                self.user.refresh_from_db()
                self.assertEqual(self.user.first_name, "Мария")

    def test_post_requires_csrf_token(self):
        from django.test import Client

        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        response = client.post(reverse("profile"), {"first_name": "Анна"})
        self.assertEqual(response.status_code, 403)
        self.user.refresh_from_db()
        self.assertEqual(self.user.first_name, "Мария")

    def test_role_and_access_reflect_server_flags(self):
        self.client.force_login(self.user)
        for flags, role, access in (
            ((True, False), "Сотрудник", "Администрирование в рамках назначенных разрешений"),
            ((True, True), "Суперпользователь", "Полный доступ к администрированию"),
        ):
            with self.subTest(role=role):
                self.user.is_staff, self.user.is_superuser = flags
                self.user.save(update_fields=("is_staff", "is_superuser"))
                response = self.client.get(reverse("profile"))
                self.assertContains(response, role)
                self.assertContains(response, access)
