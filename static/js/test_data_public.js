(() => {
    const root = document.querySelector("[data-td-tool]");
    if (!root) return;
    const one = (selector) => root.querySelector(selector);
    const all = (selector) => Array.from(root.querySelectorAll(selector));
    const generatorForm = one("[data-td-generator]");
    const checksForm = one("[data-td-checks]");
    const filesPanel = document.querySelector("[data-td-files]");
    const limitCaption = document.querySelector("[data-td-limit]");
    const groups = JSON.parse(document.getElementById("td-field-groups").textContent);
    const labels = Object.fromEntries(groups.flatMap(([, fields]) => fields));
    const csrf = generatorForm.querySelector('[name="csrfmiddlewaretoken"]').value;
    const state = {tab: "generator", format: "table", generator: null,
        checks: null, dirty: false, busy: false, page: 0};
    let ready = false;

    const setError = (message) => {
        const error = one("[data-td-error]");
        error.textContent = message || "";
        error.hidden = !message;
    };
    const current = () => state.tab === "generator" ? state.generator : state.checks;
    const fieldsFor = () => state.tab === "generator" ? current()?.settings.fields || [] : ["value", "purpose", "expected"];
    const csvText = (rows, fields) => {
        const quote = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
        return [fields.map(field => quote(labels[field] || ({value: "Значение", purpose: "Назначение", expected: "Ожидаемый результат"})[field])).join(","),
            ...rows.map(row => fields.map(field => quote(row[field])).join(","))].join("\r\n") + "\r\n";
    };
    const exportText = () => {
        const rows = current()?.rows || [];
        return state.format === "json" ? JSON.stringify(rows, null, 2) : csvText(rows, fieldsFor());
    };
    const cell = (tag, value) => {
        const element = document.createElement(tag);
        element.textContent = String(value ?? "");
        return element;
    };
    const renderTable = (rows, fields) => {
        const target = one("[data-td-table]");
        target.replaceChildren();
        if (!rows.length) return;
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const heading = document.createElement("tr");
        fields.forEach(field => heading.append(cell("th", labels[field] || ({value: "Значение", purpose: "Назначение", expected: "Ожидаемый результат"})[field])));
        head.append(heading);
        table.append(head);
        const body = document.createElement("tbody");
        rows.slice(state.page * 10, (state.page + 1) * 10).forEach(row => {
            const line = document.createElement("tr");
            fields.forEach(field => line.append(cell("td", row[field])));
            body.append(line);
        });
        table.append(body);
        target.append(table);
    };
    const render = () => {
        const filesActive = state.tab === "files";
        root.hidden = filesActive;
        if (filesPanel) filesPanel.hidden = !filesActive;
        if (limitCaption) limitCaption.hidden = filesActive;
        document.querySelectorAll("[data-td-tab]").forEach(button => {
            const active = button.dataset.tdTab === state.tab;
            button.setAttribute("aria-pressed", String(active));
            button.classList.toggle("active", active);
        });
        if (filesActive) return;
        const generating = state.tab === "generator";
        const result = current();
        const rows = result?.rows || [];
        const hasRows = rows.length > 0;
        generatorForm.hidden = state.tab !== "generator";
        checksForm.hidden = state.tab !== "checks";
        all("[data-td-format]").forEach(button => {
            const active = button.dataset.tdFormat === state.format;
            button.setAttribute("aria-pressed", String(active));
            button.classList.toggle("active", active);
        });
        one("[data-td-new]").disabled = state.busy;
        one("[data-td-new]").textContent = generating ? "Новый набор" : "Новые проверки";
        one("[data-td-title]").textContent = generating ? "Набор данных" : "Проверки полей";
        one("[data-td-copy]").disabled = state.busy || !hasRows;
        one("[data-td-download]").disabled = state.busy || !hasRows;
        one("[data-td-generate]").disabled = !ready || state.busy;
        one("[data-td-build-checks]").disabled = !ready || state.busy;
        one("[data-td-meta]").textContent = hasRows ? `${rows.length} записей` : "Нет результата";
        const pagination = one("[data-td-pagination]");
        pagination.hidden = state.format !== "table" || rows.length <= 10;
        const pages = Math.max(1, Math.ceil(rows.length / 10));
        if (state.page >= pages) state.page = pages - 1;
        one("[data-td-page]").textContent = `${state.page + 1} из ${pages}`;
        one("[data-td-prev]").disabled = state.page <= 0;
        one("[data-td-next]").disabled = state.page >= pages - 1;
        one("[data-td-table]").hidden = state.format !== "table";
        one("[data-td-code]").hidden = state.format === "table";
        if (state.format === "table") {
            one("[data-td-code]").textContent = "";
            renderTable(rows, fieldsFor());
        } else {
            one("[data-td-table]").replaceChildren();
            one("[data-td-code]").textContent = hasRows ? exportText() : "";
        }
        if (state.tab === "generator" && state.dirty && state.generator)
            one("[data-td-status]").textContent = "Настройки изменены. Сгенерируйте новый результат.";
    };
    const post = async (url, data) => {
        const response = await fetch(url, {method: "POST", credentials: "same-origin",
            headers: {"Content-Type": "application/json", "X-CSRFToken": csrf}, body: JSON.stringify(data)});
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Запрос не выполнен.");
        return payload;
    };
    const setBusy = (busy) => {
        state.busy = busy;
        all("[data-td-generator] input, [data-td-generator] select, [data-td-checks] input, [data-td-checks] select")
            .forEach(control => { if (control.type !== "hidden") control.disabled = busy; });
        render();
    };
    const generatorSettings = () => ({fields: all('[name="fields"]:checked').map(input => input.value),
        count: generatorForm.querySelector('[name="count"]').value,
        locale: generatorForm.querySelector('[name="locale"]').value,
        password_length: generatorForm.querySelector('[name="password_length"]').value});
    const checksSettings = () => ({type: checksForm.querySelector('[name="type"]').value,
        required: checksForm.querySelector('[name="required"]').checked,
        trim: checksForm.querySelector('[name="trim"]').value,
        phone_locale: checksForm.querySelector('[name="phone_locale"]').value,
        min_length: checksForm.querySelector('[name="min_length"]').value,
        max_length: checksForm.querySelector('[name="max_length"]').value,
        min: checksForm.querySelector('[name="min"]').value,
        max: checksForm.querySelector('[name="max"]').value});

    generatorForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (state.busy) return;
        setError("");
        setBusy(true);
        one("[data-td-status]").textContent = "Генерация…";
        try {
            const payload = await post(generatorForm.action, {settings: generatorSettings()});
            state.generator = {settings: payload.settings, rows: payload.rows};
            state.dirty = false;
            state.page = 0;
            one("[data-td-status]").textContent = `Готово · ${payload.rows.length} записей · ${payload.size_bytes} байт`;
        } catch (error) { setError(error.message); one("[data-td-status]").textContent = "Предыдущий результат сохранён на экране."; }
        finally { setBusy(false); }
    });
    checksForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (state.busy) return;
        setError("");
        setBusy(true);
        one("[data-td-status]").textContent = "Подготовка проверок…";
        try {
            const payload = await post(checksForm.action, {settings: checksSettings()});
            state.checks = {rows: payload.rows};
            state.page = 0;
            one("[data-td-status]").textContent = "Проверки готовы. Результат доступен до закрытия страницы.";
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
    });
    generatorForm.addEventListener("input", () => { if (state.generator) state.dirty = true; render(); });
    generatorForm.addEventListener("change", () => { if (state.generator) state.dirty = true; render(); });
    const passwordToggle = () => {
        one("[data-td-password-length]").hidden = !generatorForm.querySelector('[name="fields"][value="password"]').checked;
    };
    generatorForm.addEventListener("change", passwordToggle);
    const checkType = checksForm.querySelector("[data-td-check-type]");
    const showCheckSettings = () => {
        const kind = checkType.value;
        one("[data-td-length]").hidden = kind !== "text";
        one("[data-td-range]").hidden = !["date", "number"].includes(kind);
        one("[data-td-phone]").hidden = kind !== "phone";
        if (kind === "date") { checksForm.querySelector('[name="min"]').value = "2000-01-01";
            checksForm.querySelector('[name="max"]').value = "2030-12-31"; }
        if (kind === "number") { checksForm.querySelector('[name="min"]').value = "0";
            checksForm.querySelector('[name="max"]').value = "100"; }
    };
    checkType.addEventListener("change", showCheckSettings);
    document.querySelectorAll("[data-td-tab]").forEach(button => button.addEventListener("click", () => {
        state.tab = button.dataset.tdTab; state.page = 0; setError(""); render();
    }));
    all("[data-td-format]").forEach(button => button.addEventListener("click", () => {
        state.format = button.dataset.tdFormat; state.page = 0; render();
    }));
    one("[data-td-prev]").addEventListener("click", () => { state.page--; render(); });
    one("[data-td-next]").addEventListener("click", () => { state.page++; render(); });
    one("[data-td-copy]").addEventListener("click", async () => {
        if (state.busy || !current()?.rows.length) return;
        try { await navigator.clipboard.writeText(exportText()); one("[data-td-status]").textContent = "Весь набор скопирован."; }
        catch { setError("Не удалось скопировать результат."); }
    });
    one("[data-td-download]").addEventListener("click", () => {
        if (state.busy || !current()?.rows.length) return;
        const isJson = state.format === "json";
        const blob = new Blob([exportText()], {type: isJson ? "application/json;charset=utf-8" : "text/csv;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = "test-data." + (isJson ? "json" : "csv");
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    one("[data-td-new]").addEventListener("click", () => {
        if (state.busy) return;
        state[state.tab] = null;
        state.page = 0;
        if (state.tab === "generator") {
            state.dirty = false;
            generatorForm.reset();
            passwordToggle();
            one("[data-td-status]").textContent = "Настройте поля и сгенерируйте новый набор.";
        } else {
            checksForm.reset();
            showCheckSettings();
            one("[data-td-status]").textContent = "Укажите требования и подготовьте проверки.";
        }
        setError(""); render();
    });
    passwordToggle();
    showCheckSettings();
    ready = true;
    one("[data-td-status]").textContent = "Настройте поля и нажмите «Сгенерировать».";
    render();
})();
