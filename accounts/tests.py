from allauth.account.models import EmailAddress
from allauth.usersessions.models import UserSession
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse


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
        self.assertIn("email", response.context["form"].fields)
        self.assertNotIn("username", response.context["form"].fields)
        content = response.content.decode()
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
        self.assertNotContains(response, "Menu:")

    def test_signup_creates_unverified_user_and_sends_confirmation(self):
        response = self.client.post(
            reverse("account_signup"),
            {
                "email": "new-user@example.com",
                "password1": "safe-test-password-4827",
                "password2": "safe-test-password-4827",
            },
        )

        self.assertEqual(response.status_code, 302)
        user = get_user_model().objects.get(email="new-user@example.com")
        email_address = EmailAddress.objects.get(user=user)
        self.assertFalse(email_address.verified)
        self.assertEqual(len(mail.outbox), 1)
        self.assertNotIn("_auth_user_id", self.client.session)

        self.client.post(
            reverse("account_login"),
            {"login": user.email, "password": "safe-test-password-4827"},
        )

        self.assertNotIn("_auth_user_id", self.client.session)

    def test_authenticated_user_can_open_dashboard(self):
        user = get_user_model().objects.create_user(
            email="qa@example.com",
            password="safe-test-password-4827",
        )
        self.client.force_login(user)

        response = self.client.get(reverse("dashboard"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, user.email)
        self.assertContains(response, reverse("account_email"))
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
