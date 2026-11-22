(() => {
    "use strict";
    const form = document.querySelector("[data-json-tool]");
    if (!form) return;
    const source = form.querySelector("[data-json-source]");
    const output = form.querySelector("[data-json-output]");
    const previewNote = form.querySelector("[data-json-preview-note]");
    const status = form.querySelector("[data-json-status]");
    const copy = form.querySelector("[data-json-copy]");
    const download = form.querySelector("[data-json-download]");
    const indent = form.querySelector("[data-json-indent]");
    const sort = form.querySelector("[data-json-sort]");
    const file = form.querySelector("[data-json-file]");
    const operations = form.querySelectorAll("[data-json-operation]");
    const tabs = [...document.querySelectorAll("[data-json-lab-tab]")];
    const panels = {
        analyzer: document.querySelector("[data-json-analyzer]"),
        compare: document.querySelector("[data-json-compare]"),
    };
    let revision = 0, result = null, controller = null;
    const previewLimit = 8192;
    const highlightLimit = 512;
    const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    const paint = value => {
        output.replaceChildren();
        const shortened = value.length > previewLimit;
        previewNote.textContent = shortened ? "Предпросмотр сокращён. Копирование и скачивание целиком." : "UTF-8";
        if (shortened) {
            output.textContent = value.slice(0, previewLimit).replace(/[\uD800-\uDBFF]$/, "");
            return;
        }
        if (!value) return;
        let last = 0;
        let highlighted = 0;
        for (const match of value.matchAll(tokenPattern)) {
            if (highlighted++ === highlightLimit) break;
            output.append(document.createTextNode(value.slice(last, match.index)));
            const span = document.createElement("span");
            span.className = match[1] ? "json-key" : match[2] ? "json-string" : match[3] ? "json-number" : "json-literal";
            span.textContent = match[0];
            output.append(span);
            last = match.index + match[0].length;
        }
        output.append(document.createTextNode(value.slice(last)));
    };
    const message = (value, error = false) => {
        status.textContent = value;
        status.classList.toggle("error", error);
    };
    const invalidate = () => {
        revision++;
        controller?.abort();
        result = null;
        paint("");
        copy.disabled = true;
        download.disabled = true;
        message("");
    };
    const payload = operation => {
        const data = new FormData();
        data.set("csrfmiddlewaretoken", form.querySelector('[name="csrfmiddlewaretoken"]').value);
        data.set("source", source.value);
        data.set("operation", operation);
        data.set("indent", indent.value);
        if (sort.checked) data.set("sort_keys", "on");
        return data;
    };
    tabs.forEach((tab, index) => {
        const activate = (selected) => {
            for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== selected;
            for (const button of tabs) {
                const active = button.dataset.jsonLabTab === selected;
                button.setAttribute("aria-selected", String(active));
                button.tabIndex = active ? 0 : -1;
            }
        };
        tab.addEventListener("click", () => activate(tab.dataset.jsonLabTab));
        tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[target].focus();
            activate(tabs[target].dataset.jsonLabTab);
        });
    });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const operation = event.submitter?.dataset.jsonOperation || "format";
        operations.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.jsonOperation === operation)));
        invalidate();
        const current = revision;
        controller = new AbortController();
        message("Проверяем…");
        try {
            const response = await fetch(form.action, {
                method: "POST", credentials: "same-origin", body: payload(operation), signal: controller.signal,
            });
            const data = await response.json();
            if (current !== revision) return;
            if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось обработать JSON.");
            result = data.result;
            paint(result);
            copy.disabled = false;
            download.disabled = false;
            message("Готово");
        } catch (error) {
            if (error.name !== "AbortError" && current === revision)
                message(error.message || "Не удалось обработать JSON.", true);
        }
    });
    source.addEventListener("input", invalidate);
    indent.addEventListener("change", invalidate);
    sort.addEventListener("change", invalidate);
    form.querySelector("[data-json-clear]").addEventListener("click", () => {
        source.value = "";
        invalidate();
        source.focus();
    });
    file.addEventListener("change", async () => {
        const selected = file.files[0];
        file.value = "";
        if (!selected) return;
        invalidate();
        const current = revision;
        if (!/\.json$/i.test(selected.name) || selected.size > 1024 * 1024) {
            message("Выберите .json до 1 МБ.", true);
            return;
        }
        try {
            const value = new TextDecoder("utf-8", {fatal: true}).decode(await selected.arrayBuffer());
            if (current !== revision) return;
            source.value = value.replace(/^\uFEFF/, "");
            invalidate();
            message("Файл открыт. Выберите операцию.");
        } catch {
            if (current === revision) message("Файл должен быть в UTF-8.", true);
        }
    });
    copy.addEventListener("click", async () => {
        if (result === null) return;
        const current = revision;
        try {
            await navigator.clipboard.writeText(result);
            if (current === revision) message("Скопировано");
        } catch {
            if (current === revision) message("Не удалось скопировать результат.", true);
        }
    });
    download.addEventListener("click", () => {
        if (result === null) return;
        const url = URL.createObjectURL(new Blob([result], {type: "application/json;charset=utf-8"}));
        const link = document.createElement("a");
        link.href = url;
        link.download = "result.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message("Файл подготовлен");
    });
    operations.forEach(button => { button.disabled = false; });
    message("");
})();
