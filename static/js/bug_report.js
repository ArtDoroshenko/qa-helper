(() => {
    "use strict";

    const root = document.querySelector("[data-bug-report]");
    const core = globalThis.QABugReport;
    if (!root || !core) return;
    const find = selector => root.querySelector(selector);
    const fields = Object.fromEntries([...root.querySelectorAll("[data-br-field]")]
        .map(input => [input.dataset.brField, input]));
    const fieldErrors = Object.fromEntries([...root.querySelectorAll("[data-br-error]")]
        .map(error => [error.dataset.brError, error]));
    const suggestionNames = ["module", "action", "symptom"];
    const reportNames = ["title", "steps", "actual", "expected", "environment", "issue"];
    const preview = find("[data-br-preview]");
    const status = find("[data-br-status]");
    const copy = find("[data-br-copy]");
    const download = find("[data-br-download]");
    const downloadUrls = new Set();
    let report = null;

    function feedback(message, error = false) {
        status.textContent = message;
        status.classList.toggle("br-error", error);
    }

    function setFieldError(name, message) {
        if (message) fields[name].setAttribute("aria-invalid", "true");
        else fields[name].removeAttribute("aria-invalid");
        fieldErrors[name].textContent = message || "";
        fieldErrors[name].hidden = !message;
    }

    function check(names, errors) {
        for (const name of names) setFieldError(name, errors[name]);
        const firstError = names.find(name => errors[name]);
        if (!firstError) return true;
        feedback("Проверьте отмеченные поля.", true);
        fields[firstError].focus();
        return false;
    }

    function values(names) {
        return Object.fromEntries(names.map(name => [name, fields[name].value]));
    }

    function invalidate(message = "") {
        report = null;
        preview.value = "";
        copy.disabled = true;
        download.disabled = true;
        feedback(message);
    }

    for (const [name, input] of Object.entries(fields)) {
        input.addEventListener("input", () => {
            setFieldError(name);
            invalidate(report ? "Данные изменились. Соберите отчёт заново." : "");
        });
    }

    find("[data-br-suggest]").addEventListener("click", () => {
        const suggestion = core.suggestTitle(values(suggestionNames));
        if (!check(suggestionNames, suggestion.errors)) return;
        fields.title.value = suggestion.title;
        setFieldError("title");
        invalidate("Заголовок предложен. Его можно редактировать.");
        fields.title.focus();
    });

    find("[data-br-build]").addEventListener("click", () => {
        invalidate();
        const current = core.buildReport(values(reportNames));
        if (!check(reportNames, current.errors)) return;
        report = current;
        preview.value = report.markdown;
        copy.disabled = false;
        download.disabled = false;
        feedback("Отчёт готов.");
    });

    function reset(focus) {
        for (const [name, input] of Object.entries(fields)) {
            input.value = "";
            setFieldError(name);
        }
        invalidate(focus ? "Поля очищены." : "");
        if (focus) fields.title.focus();
    }

    find("[data-br-reset]").addEventListener("click", () => reset(true));

    copy.addEventListener("click", async () => {
        const current = report;
        if (!current || copy.disabled) return;
        copy.disabled = true;
        try {
            await navigator.clipboard.writeText(current.markdown);
            if (report === current) feedback("Markdown скопирован.");
        } catch {
            if (report === current) feedback("Копирование недоступно. Выделите текст или скачайте файл.", true);
        } finally {
            if (report === current) copy.disabled = false;
        }
    });

    function releaseDownload(url) {
        if (downloadUrls.delete(url)) URL.revokeObjectURL(url);
    }

    download.addEventListener("click", () => {
        if (!report) return;
        const blob = new Blob([report.markdown], {type: "text/markdown;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        downloadUrls.add(url);
        const link = document.createElement("a");
        link.href = url;
        link.download = "bug-report.md";
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => releaseDownload(url), 1000);
    });

    window.addEventListener("pagehide", () => {
        for (const url of downloadUrls) releaseDownload(url);
        reset(false);
    });
})();
