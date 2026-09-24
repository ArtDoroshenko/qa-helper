from django import forms

from .models import Note


class NoteForm(forms.ModelForm):
    class Meta:
        model = Note
        fields = ("title", "content")
        labels = {
            "title": "Заголовок",
            "content": "Текст заметки",
        }
        error_messages = {
            "title": {
                "required": "Введите заголовок.",
                "max_length": "Заголовок не должен превышать 200 символов.",
            },
        }
        widgets = {
            "title": forms.TextInput(
                attrs={"placeholder": "Например, проверка регистрации"},
            ),
            "content": forms.Textarea(
                attrs={
                    "placeholder": "Запишите наблюдения, шаги или результат проверки…",
                    "rows": 14,
                },
            ),
        }
