from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase


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
            email="qa@EXAMPLE.COM",
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

    def test_create_superuser_sets_required_flags(self):
        user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="test-password",
        )

        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)

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
