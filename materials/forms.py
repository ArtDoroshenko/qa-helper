from django import forms

from config.upload_validation import safe_filename, validate_uploaded_file

from .base64_tools import MAX_BASE64_LENGTH
from .json_tools import MAX_JSON_INPUT_BYTES


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


class JsonOptionsForm(forms.Form):
    class Operation:
        FORMAT = "format"
        MINIFY = "minify"

    operation = forms.ChoiceField(
        choices=((Operation.FORMAT, "Форматировать"), (Operation.MINIFY, "Минифицировать")),
    )
    indent = forms.TypedChoiceField(choices=((2, "2 пробела"), (4, "4 пробела")), coerce=int)
    sort_keys = forms.BooleanField(required=False)


class JsonProcessForm(JsonOptionsForm):
    source = forms.CharField(required=False, strip=False)
    file = forms.FileField(required=False)

    def clean(self):
        cleaned_data = super().clean()
        source = cleaned_data.get("source", "")
        uploaded_file = cleaned_data.get("file")
        if bool(source) == bool(uploaded_file):
            raise forms.ValidationError("Введите JSON или выберите один файл.")
        if uploaded_file:
            if uploaded_file.size > MAX_JSON_INPUT_BYTES:
                raise forms.ValidationError("JSON-файл не должен превышать 1 МБ.")
            if not uploaded_file.name.lower().endswith(".json"):
                raise forms.ValidationError("Выберите файл с расширением .json.")
            try:
                cleaned_data["source"] = uploaded_file.read().decode("utf-8-sig")
            except UnicodeDecodeError as error:
                raise forms.ValidationError("JSON-файл должен быть в кодировке UTF-8.") from error
        return cleaned_data


class JsonSaveForm(JsonOptionsForm):
    title = forms.CharField(max_length=120, strip=True)
    source = forms.CharField(strip=False)
    material_id = forms.IntegerField(required=False, min_value=1)
    save_as_new = forms.BooleanField(required=False)

    def clean_title(self):
        title = self.cleaned_data["title"].strip()
        if not title:
            raise forms.ValidationError("Введите название материала.")
        return title


class JsonRenameForm(forms.Form):
    title = forms.CharField(max_length=120, strip=True)

    def clean_title(self):
        title = self.cleaned_data["title"].strip()
        if not title:
            raise forms.ValidationError("Введите название материала.")
        return title
