from django import forms

from config.upload_validation import validate_uploaded_file

from .models import Attachment, Note


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


class AttachmentForm(forms.ModelForm):
    class Meta:
        model = Attachment
        fields = ("file",)
        labels = {"file": "Файл"}

    def clean_file(self):
        uploaded_file = self.cleaned_data["file"]
        safe_name, content_type = validate_uploaded_file(uploaded_file)
        self.safe_name = safe_name
        self.content_type = content_type
        return uploaded_file
