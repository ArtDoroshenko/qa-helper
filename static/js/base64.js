(() => {
    "use strict";
    const form = document.getElementById("base64-tool-form");
    if (!form) return;
    form.classList.add("is-enhanced");

    const modeButtons = Array.from(form.querySelectorAll("[data-base64-mode]"));
    const textSource = form.querySelector("[data-base64-text-source]");
    const fileSource = form.querySelector("[data-base64-file-source]");
    const textInput = document.getElementById("id_text");
    const fileInput = document.getElementById("id_file");
    const operation = document.getElementById("id_operation");
    const sourceTitle = form.querySelector("[data-base64-source-title]");
    const dataUrlField = form.querySelector("[data-base64-data-url]");
    const dataUrlInput = document.getElementById("id_as_data_url");
    const output = form.querySelector("[data-base64-output]");
    const resultMeta = form.querySelector("[data-base64-result-meta]");
    const status = form.querySelector("[data-base64-status]");
    const copyButton = form.querySelector("[data-base64-copy]");
    const downloadButton = document.getElementById("base64-download-button");
    const preview = form.querySelector("[data-base64-preview]");
    const fileName = form.querySelector("[data-base64-file-name]");
    const fileLimit = form.querySelector("[data-base64-file-limit]");
    const dropZone = form.querySelector("[data-base64-drop]");
    const submitButton = form.querySelector(".base64-submit");
    const previewBytes = 8 * 1024;
    const previewImageBytes = 1024 * 1024;
    const previewTypes = new Set(["image/png", "image/jpeg"]);
    const responseErrors = {
        413: "Запрос слишком большой.",
        503: "Конвертер занят. Попробуйте ещё раз через несколько секунд.",
    };
    const utf8 = () => new TextDecoder("utf-8", {ignoreBOM: true});
    let pending = null;
    let result = null;
    let previewUrl = null;
    let ready = false;

    const feedback = (message, error = false) => {
        status.textContent = message;
        status.classList.toggle("error", error);
    };

    const clearPreview = () => {
        preview.hidden = true;
        preview.removeAttribute("src");
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
    };

    const invalidate = (message = "Данные изменены. Преобразуйте снова.") => {
        pending?.abort();
        pending = null;
        result = null;
        output.value = "";
        clearPreview();
        copyButton.disabled = true;
        downloadButton.disabled = true;
        submitButton.disabled = !ready;
        resultMeta.textContent = "UTF-8 · текст или файл";
        feedback(message);
    };

    const setMode = (mode) => {
        const isText = mode === "text";
        textSource.hidden = !isText;
        fileSource.hidden = isText;
        textInput.disabled = !isText;
        fileInput.disabled = isText;
        modeButtons.forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.base64Mode === mode));
        });
        sourceTitle.textContent = isText
            ? (operation.value === "encode" ? "Исходный текст" : "Строка Base64")
            : (operation.value === "encode" ? "Исходный файл" : "Файл с Base64");
    };

    const syncOperation = () => {
        const isEncode = operation.value === "encode";
        fileLimit.textContent = isEncode ? "Файл до 10 МиБ" : "Запрос до 16 МиБ · результат до 10 МиБ";
        dataUrlField.hidden = !isEncode;
        dataUrlInput.disabled = !isEncode;
        const activeMode = modeButtons.find((button) => button.getAttribute("aria-pressed") === "true");
        setMode(activeMode?.dataset.base64Mode || "text");
    };

    modeButtons.forEach((button) => {
        button.addEventListener("click", () => { setMode(button.dataset.base64Mode); invalidate(); });
    });
    operation.addEventListener("change", () => { syncOperation(); invalidate(); });
    textInput.addEventListener("input", () => invalidate());
    dataUrlInput.addEventListener("change", () => invalidate());
    form.querySelector("[name='output_name']").addEventListener("input", () => invalidate());

    fileInput.addEventListener("change", () => {
        fileName.textContent = fileInput.files[0]?.name || "Перетащите файл сюда или выберите на устройстве";
        invalidate();
        status.textContent = fileInput.files[0] ? "Файл выбран. Преобразуйте снова." : "Файл не выбран.";
    });

    ["dragenter", "dragover"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.add("is-dragging");
        });
    });
    ["dragleave", "drop"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.remove("is-dragging");
        });
    });
    dropZone.addEventListener("drop", (event) => {
        if (!event.dataTransfer.files.length) return;
        fileInput.files = event.dataTransfer.files;
        fileInput.dispatchEvent(new Event("change"));
    });

    form.querySelector("[data-base64-clear]").addEventListener("click", () => {
        textInput.value = "";
        fileInput.value = "";
        fileName.textContent = "Перетащите файл сюда или выберите на устройстве";
        invalidate("Очищено");
        (textInput.disabled ? fileInput : textInput).focus();
    });

    copyButton.addEventListener("click", async () => {
        const current = result;
        if (!current?.isText || copyButton.disabled) return;
        copyButton.disabled = true;
        try {
            if (navigator.clipboard.write && typeof ClipboardItem === "function") {
                const textBlob = current.blob.slice(0, current.blob.size, "text/plain");
                await navigator.clipboard.write([new ClipboardItem({"text/plain": textBlob})]);
            } else {
                const text = utf8().decode(await current.blob.arrayBuffer());
                if (current !== result) return;
                await navigator.clipboard.writeText(text);
            }
            if (current === result) feedback("Скопирован весь результат.");
        } catch {
            if (current === result) feedback("Не удалось скопировать результат. Его можно скачать.", true);
        } finally {
            if (current === result) copyButton.disabled = false;
        }
    });

    downloadButton.addEventListener("click", () => {
        if (!result) return;
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = result.filename;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    function filenameFrom(response) {
        const disposition = response.headers.get("Content-Disposition") || "";
        const utf8Name = disposition.match(/filename\*=utf-8''([^;]+)/i);
        return utf8Name ? decodeURIComponent(utf8Name[1])
            : disposition.match(/filename="([^"]+)"/i)?.[1] || "result.bin";
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        invalidate("Обрабатываем…");
        const job = new AbortController();
        pending = job;
        submitButton.disabled = true;
        const encoded = operation.value === "encode";
        const selectedFile = fileInput.disabled ? null : fileInput.files[0];
        try {
            const response = await fetch(form.action, {
                method: "POST", body: new FormData(form), credentials: "same-origin", signal: job.signal,
            });
            if (!response.ok) {
                const error = await response.json().catch(() => null);
                throw new Error(error?.error || responseErrors[response.status] || "Не удалось преобразовать данные.");
            }
            const blob = await response.blob();
            if (pending !== job) return;
            const isText = response.headers.get("X-QA-Result-Text") === "1";
            const truncated = isText && blob.size > previewBytes;
            const text = isText
                ? utf8().decode(await blob.slice(0, previewBytes).arrayBuffer(), {stream: truncated})
                : "Двоичный результат готов к скачиванию.";
            if (pending !== job) return;
            result = {blob, isText, filename: filenameFrom(response)};
            output.value = text;
            resultMeta.textContent = truncated ? "Первые 8 КиБ · копирование и скачивание целиком" : "Результат готов";
            const previewType = response.headers.get("X-QA-Preview-Type");
            const image = encoded ? selectedFile : blob;
            if (image && image.size <= previewImageBytes && previewTypes.has(previewType)) {
                const metadata = await window.QAScreenshots?.readMetadata(image).catch(() => null);
                if (pending !== job) return;
                if (metadata?.mime === previewType) {
                    previewUrl = URL.createObjectURL(image.slice(0, image.size, previewType));
                    preview.src = previewUrl;
                    preview.hidden = false;
                }
            }
            copyButton.disabled = !isText;
            downloadButton.disabled = false;
            feedback("Готово");
        } catch (error) {
            if (pending === job) feedback(error.message || "Не удалось преобразовать данные.", true);
        } finally {
            if (pending === job) {
                pending = null;
                submitButton.disabled = false;
            }
        }
    });
    preview.addEventListener("error", clearPreview);
    window.addEventListener("pagehide", () => invalidate(""));

    syncOperation();
    ready = true;
    submitButton.disabled = false;
    feedback("");
})();
