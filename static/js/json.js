(() => {
    const form = document.querySelector("[data-json-tool]");
    if (!form) return;
    const source = form.querySelector("[data-json-source]");
    const output = form.querySelector("[data-json-output]");
    const status = form.querySelector("[data-json-status]");
    const copy = form.querySelector("[data-json-copy]");
    const download = form.querySelector("[data-json-download]");
    const save = form.querySelector("[data-json-save]");
    const saveNew = form.querySelector("[data-json-save-new]");
    const panel = document.querySelector("[data-json-save-panel]");
    const title = panel.querySelector("[data-json-title]");
    const confirm = panel.querySelector("[data-json-save-confirm]");
    const heading = panel.querySelector("[data-json-save-heading]");
    const materialId = form.querySelector("[data-json-material-id]");
    const notice = document.querySelector("[data-json-saved-notice]");
    let savedTitle = title.value;
    let operation = form.querySelector('[data-json-operation][aria-pressed="true"]')?.dataset.jsonOperation || "format";
    let revision = 0;
    let titleRevision = 0;
    let processedRevision = -1;
    let result = "";
    let processEpoch = 0;
    let fileEpoch = 0;
    let filePending = false;
    let savePending = false;
    let copyPending = false;
    let downloadPending = false;
    let saveAsNew = false;
    let controller;
    const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

    const paint = (value) => {
        output.replaceChildren();
        if (!value) return;
        let last = 0;
        for (const match of value.matchAll(tokenPattern)) {
            output.append(document.createTextNode(value.slice(last, match.index)));
            const span = document.createElement("span");
            span.className = match[1] ? "json-key" : match[2] ? "json-string" : match[3] ? "json-number" : "json-literal";
            span.textContent = match[0];
            output.append(span);
            last = match.index + match[0].length;
        }
        output.append(document.createTextNode(value.slice(last)));
    };
    const message = (text, error = false) => {
        status.textContent = text;
        status.classList.toggle("error", error);
    };
    const sync = () => {
        const valid = processedRevision === revision && !filePending;
        copy.disabled = !valid || copyPending;
        download.disabled = !valid || downloadPending;
        save.disabled = !valid || savePending;
        saveNew.disabled = !valid || savePending;
        confirm.disabled = !valid || savePending;
        form.querySelectorAll("[data-json-operation]").forEach((button) => { button.disabled = filePending; });
        saveNew.hidden = !materialId.value;
        save.textContent = materialId.value ? "Сохранить изменения" : "Сохранить в материалы";
    };
    const clearResult = () => {
        processedRevision = -1;
        result = "";
        paint("");
        sync();
    };
    const invalidate = () => {
        revision += 1;
        processEpoch += 1;
        fileEpoch += 1;
        filePending = false;
        controller?.abort();
        clearResult();
        notice.hidden = true;
        message("");
    };
    const payload = () => {
        const data = new FormData();
        data.set("csrfmiddlewaretoken", form.querySelector('[name="csrfmiddlewaretoken"]').value);
        data.set("source", source.value);
        data.set("operation", operation);
        data.set("indent", form.querySelector("[data-json-indent]").value);
        if (form.querySelector("[data-json-sort]").checked) data.set("sort_keys", "on");
        return data;
    };
    const snapshot = () => ({revision, titleRevision});
    const isCurrent = (state) => state.revision === revision && state.titleRevision === titleRevision;
    const acceptResult = (value) => {
        result = value;
        processedRevision = revision;
        paint(value);
        sync();
    };

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (filePending) return;
        controller?.abort();
        controller = new AbortController();
        const epoch = ++processEpoch;
        const targetRevision = revision;
        clearResult();
        message("Проверяем…");
        try {
            const response = await fetch(form.dataset.processUrl, {method: "POST", body: payload(), signal: controller.signal});
            if (epoch !== processEpoch || targetRevision !== revision) return;
            const data = await response.json();
            if (epoch !== processEpoch || targetRevision !== revision) return;
            if (!response.ok || !data.ok) throw new Error(data.error || "Ошибка обработки.");
            acceptResult(data.result);
            message("Готово");
        } catch (error) {
            if (error.name !== "AbortError" && epoch === processEpoch && targetRevision === revision) {
                clearResult();
                message(error.message || "Не удалось обработать JSON.", true);
            }
        }
    });
    source.addEventListener("input", invalidate);
    title.addEventListener("input", () => {
        titleRevision += 1;
        notice.hidden = true;
        message("");
    });
    form.querySelectorAll("[data-json-operation]").forEach((button) => button.addEventListener("click", () => {
        operation = button.dataset.jsonOperation;
        form.querySelectorAll("[data-json-operation]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        invalidate();
    }));
    form.querySelector("[data-json-indent]").addEventListener("change", invalidate);
    form.querySelector("[data-json-sort]").addEventListener("change", invalidate);
    form.querySelector("[data-json-clear]").addEventListener("click", () => { source.value = ""; invalidate(); source.focus(); });
    form.querySelector("[data-json-file]").addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        invalidate();
        const epoch = fileEpoch;
        if (!/\.json$/i.test(file.name)) { message("Выберите файл с расширением .json.", true); event.target.value = ""; return; }
        if (file.size > 1024 * 1024) { message("JSON-файл не должен превышать 1 МБ.", true); event.target.value = ""; return; }
        filePending = true;
        sync();
        try {
            const bytes = await file.arrayBuffer();
            if (epoch !== fileEpoch) return;
            const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
            if (epoch !== fileEpoch) return;
            source.value = text.replace(/^\uFEFF/, "");
            invalidate();
            message("Файл загружен. Обработайте JSON.");
        } catch (error) {
            if (epoch === fileEpoch) message("Не удалось прочитать файл: требуется корректный UTF-8.", true);
        } finally {
            if (epoch === fileEpoch) { filePending = false; sync(); }
            event.target.value = "";
        }
    });
    copy.addEventListener("click", async () => {
        if (copy.disabled) return;
        const state = snapshot();
        copyPending = true;
        sync();
        try {
            await navigator.clipboard.writeText(result);
            if (!isCurrent(state)) return;
            message("Скопировано");
        } catch (error) {
            if (isCurrent(state)) message("Не удалось скопировать результат. Проверьте доступ к буферу обмена.", true);
        } finally { copyPending = false; sync(); }
    });
    download.addEventListener("click", async () => {
        if (download.disabled) return;
        const state = snapshot();
        const data = payload();
        const filename = (savedTitle || "result").replace(/[\\/\u0000-\u001f]/g, "_") + ".json";
        data.set("filename", filename);
        downloadPending = true;
        sync();
        try {
            const response = await fetch(form.dataset.downloadUrl, {method: "POST", body: data});
            if (!isCurrent(state)) return;
            if (!response.ok) throw new Error("Сервер не смог подготовить JSON для скачивания.");
            const blob = await response.blob();
            if (!isCurrent(state)) return;
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.download = filename;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            message("Файл подготовлен");
        } catch (error) {
            if (isCurrent(state)) message(error.message || "Не удалось скачать результат.", true);
        } finally { downloadPending = false; sync(); }
    });

    const openSave = (asNew) => {
        if (savePending || processedRevision !== revision) return;
        saveAsNew = asNew;
        titleRevision += 1;
        title.value = materialId.value && !asNew ? savedTitle : "";
        heading.textContent = materialId.value && !asNew ? "Сохранить изменения" : "Назовите материал";
        confirm.textContent = materialId.value && !asNew ? "Сохранить изменения" : "Сохранить";
        panel.hidden = false;
        title.focus();
    };
    save.addEventListener("click", () => openSave(false));
    saveNew.addEventListener("click", () => openSave(true));
    panel.querySelector("[data-json-save-cancel]").addEventListener("click", () => {
        panel.hidden = true;
        titleRevision += 1;
    });
    panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (panel.hidden || savePending || processedRevision !== revision) return;
        const submittedTitle = title.value.trim();
        if (!submittedTitle) { title.setCustomValidity("Введите название материала."); title.reportValidity(); return; }
        title.setCustomValidity("");
        const state = snapshot();
        const data = payload();
        data.set("title", submittedTitle);
        if (materialId.value) data.set("material_id", materialId.value);
        if (saveAsNew) data.set("save_as_new", "on");
        savePending = true;
        sync();
        message("Сохраняем…");
        try {
            const response = await fetch(form.dataset.saveUrl, {method: "POST", body: data});
            const body = await response.json();
            if (!response.ok || !body.ok) throw new Error(body.error || "Ошибка сохранения.");
            // Even a stale success owns an ID: the next save must update it.
            materialId.value = body.id;
            savedTitle = body.title;
            saveAsNew = false;
            if (!isCurrent(state)) {
                message("Предыдущая версия сохранена. Текущие изменения ещё не сохранены.");
                return;
            }
            acceptResult(body.result);
            panel.hidden = true;
            notice.querySelector("[data-json-saved-message]").textContent = body.created ? "Материал сохранён." : "Изменения сохранены.";
            notice.hidden = false;
            message("Сохранено");
        } catch (error) {
            if (isCurrent(state)) message(error.message || "Не удалось сохранить материал.", true);
        } finally { savePending = false; sync(); }
    });
    title.addEventListener("input", () => title.setCustomValidity(""));
    const initial = document.getElementById("json-initial-result");
    if (initial) acceptResult(JSON.parse(initial.textContent));
    sync();
})();
