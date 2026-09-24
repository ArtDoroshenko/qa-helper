from django import forms


class SignupForm(forms.Form):
    first_name = forms.CharField(
        label="Имя",
        max_length=150,
        widget=forms.TextInput(
            attrs={
                "autocomplete": "given-name",
                "placeholder": "Как к вам обращаться",
            }
        ),
    )
    field_order = ("first_name", "email", "password1", "password2")

    def signup(self, request, user):
        user.first_name = self.cleaned_data["first_name"].strip()
        user.save(update_fields=("first_name",))


class ProfileForm(forms.Form):
    first_name = forms.CharField(
        label="Имя",
        max_length=150,
        error_messages={"required": "Введите имя."},
        widget=forms.TextInput(attrs={"autocomplete": "given-name"}),
    )
