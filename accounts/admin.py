from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.utils.translation import gettext_lazy as _

from .models import AuthenticationEvent, User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ("email",)
    list_display = ("email", "first_name", "last_name", "is_staff", "is_active")
    search_fields = ("email", "first_name", "last_name")

    fieldsets = (
        (None, {"fields": ("email", "password")}),
        (_("Personal info"), {"fields": ("first_name", "last_name")}),
        (
            _("Permissions"),
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                )
            },
        ),
        (_("Important dates"), {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "password1", "password2", "is_staff", "is_active"),
            },
        ),
    )


@admin.register(AuthenticationEvent)
class AuthenticationEventAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "event_type",
        "email",
        "ip_address",
        "short_user_agent",
    )
    list_filter = ("event_type", "created_at")
    search_fields = ("email", "user__email", "ip_address", "user_agent")
    date_hierarchy = "created_at"
    ordering = ("-created_at",)
    readonly_fields = (
        "event_type",
        "user",
        "email",
        "ip_address",
        "user_agent",
        "created_at",
    )

    @admin.display(description="User-Agent")
    def short_user_agent(self, event):
        if len(event.user_agent) <= 80:
            return event.user_agent
        return f"{event.user_agent[:77]}..."

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
