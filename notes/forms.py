from django import forms

from config.upload_validation import validate_uploaded_file

from .models import Attachment, Note

MAX_NOTES = 50
MAX_NOTE_CHARACTERS = 50_000
MAX_NOTE_BYTES = 200 * 1024
MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
MAX_ATTACHMENTS_PER_NOTE = 5
MAX_OWNER_ATTACHMENT_BYTES = 20 * 1024 * 1024


def _within_limit_or_reduced(current, previous, limit):
    return current <= limit or (previous > limit and current <= previous)


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

    def clean_content(self):
        content = self.cleaned_data["content"]
        previous = self.instance.content if self.instance.pk else ""
        if not _within_limit_or_reduced(len(content), len(previous), MAX_NOTE_CHARACTERS):
            raise forms.ValidationError("Текст заметки не должен превышать 50 000 символов.")
        try:
            size = len(content.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise forms.ValidationError("Текст заметки содержит недопустимые символы Unicode.") from error
        if not _within_limit_or_reduced(
            size, len(previous.encode("utf-8")), MAX_NOTE_BYTES,
        ):
            raise forms.ValidationError("Текст заметки не должен превышать 200 КиБ в UTF-8.")
        return content


class AttachmentForm(forms.ModelForm):
    class Meta:
        model = Attachment
        fields = ("file",)
        labels = {"file": "Файл"}

    def clean_file(self):
        uploaded_file = self.cleaned_data["file"]
        if uploaded_file.size > MAX_ATTACHMENT_BYTES:
            raise forms.ValidationError("Размер вложения не должен превышать 2 МиБ.")
        safe_name, content_type = validate_uploaded_file(uploaded_file)
        self.safe_name = safe_name
        self.content_type = content_type
        return uploaded_file
