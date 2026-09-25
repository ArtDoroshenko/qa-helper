from django import forms

from config.upload_validation import safe_filename, validate_uploaded_file

from .base64_tools import MAX_BASE64_LENGTH


class Base64ToolForm(forms.Form):
    class Operation:
        ENCODE = "encode"
        DECODE = "decode"

    operation = forms.ChoiceField(
        label="Операция",
        choices=((Operation.ENCODE, "Кодировать"), (Operation.DECODE, "Декодировать")),
    )
    text = forms.CharField(
        label="Текст или Base64",
        required=False,
        strip=False,
        widget=forms.Textarea(attrs={"rows": 10}),
    )
    file = forms.FileField(label="Или выберите файл", required=False)
    as_data_url = forms.BooleanField(label="Сформировать Data URL", required=False)
    output_name = forms.CharField(
        label="Имя скачиваемого файла",
        max_length=180,
        required=False,
    )

    def clean(self):
        cleaned_data = super().clean()
        text = cleaned_data.get("text", "")
        uploaded_file = cleaned_data.get("file")
        if bool(text) == bool(uploaded_file):
            raise forms.ValidationError("Введите текст или выберите один файл.")
        if uploaded_file:
            safe_name, content_type = validate_uploaded_file(uploaded_file)
            if cleaned_data.get("operation") == self.Operation.DECODE:
                if content_type != "text/plain":
                    raise forms.ValidationError("Для декодирования загрузите текстовый Base64-файл.")
            self.safe_name = safe_name
            self.content_type = content_type
        return cleaned_data


class DownloadForm(forms.Form):
    mode = forms.ChoiceField(choices=(("encoded", "encoded"), ("decoded", "decoded")))
    payload = forms.CharField(max_length=MAX_BASE64_LENGTH + 200, strip=False)
    filename = forms.CharField(max_length=180)

    def clean_filename(self):
        return safe_filename(self.cleaned_data["filename"], fallback="result.bin")
