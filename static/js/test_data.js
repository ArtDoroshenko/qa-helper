(() => {
    const root = document.querySelector("[data-td-tool]");
    if (!root) return;
    const one = (selector) => root.querySelector(selector);
    const all = (selector) => Array.from(root.querySelectorAll(selector));
    const generatorForm = one("[data-td-generator]");
    const checksForm = one("[data-td-checks]");
    const initial = JSON.parse(document.getElementById("td-initial-data").textContent);
    const groups = JSON.parse(document.getElementById("td-field-groups").textContent);
    const labels = Object.fromEntries(groups.flatMap(([, fields]) => fields));
    const csrf = generatorForm.querySelector('[name="csrfmiddlewaretoken"]').value;
    const state = {tab: "generator", format: "table", generator: initial,
        checks: null, dirty: false, busy: false, page: 0, sequence: 0};

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
        const result = current();
        const rows = result?.rows || [];
        const hasRows = rows.length > 0;
        generatorForm.hidden = state.tab !== "generator";
        checksForm.hidden = state.tab !== "checks";
        document.querySelectorAll("[data-td-tab]").forEach(button => {
            const active = button.dataset.tdTab === state.tab;
            button.setAttribute("aria-pressed", String(active));
            button.classList.toggle("active", active);
        });
        all("[data-td-format]").forEach(button => {
            const active = button.dataset.tdFormat === state.format;
            button.setAttribute("aria-pressed", String(active));
            button.classList.toggle("active", active);
        });
        one("[data-td-save-actions]").hidden = state.tab !== "generator";
        one("[data-td-delete]").hidden = state.tab !== "generator" || !state.generator?.id;
        one("[data-td-save-new]").hidden = !state.generator?.id;
        one("[data-td-open-save]").disabled = state.busy || !hasRows || state.dirty || !!state.generator?.id;
        one("[data-td-save-new]").disabled = state.busy || !hasRows || state.dirty;
        one("[data-td-new]").disabled = state.busy;
        one("[data-td-copy]").disabled = state.busy || !hasRows;
        one("[data-td-download]").disabled = state.busy || !hasRows;
        one("[data-td-generate]").disabled = state.busy;
        one("[data-td-build-checks]").disabled = state.busy;
        one("[data-td-origin]").textContent = state.tab === "checks" ? "Временный результат"
            : state.generator?.id ? "Сохранённый набор: " + state.generator.title : "Не сохранён";
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
        if (state.format === "table") renderTable(rows, fieldsFor());
        else one("[data-td-code]").textContent = hasRows ? exportText() : "";
        if (state.tab === "generator" && state.dirty && state.generator)
            one("[data-td-status]").textContent = "Настройки изменены. Старый результат доступен для просмотра; для сохранения сгенерируйте новый.";
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
        const version = ++state.sequence;
        setBusy(true);
        one("[data-td-status]").textContent = "Генерация…";
        try {
            const payload = await post(root.dataset.generateUrl, {settings: generatorSettings()});
            if (version !== state.sequence) return;
            state.generator = {settings: payload.settings, rows: payload.rows, proof: payload.proof};
            state.dirty = false;
            state.page = 0;
            one("[data-td-save-panel]").hidden = true;
            one("[data-td-status]").textContent = `Готово · ${payload.rows.length} записей · ${payload.size_bytes} байт`;
        } catch (error) { setError(error.message); one("[data-td-status]").textContent = "Предыдущий результат сохранён на экране."; }
        finally { setBusy(false); }
    });
    checksForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (state.busy) return;
        setError("");
        const version = ++state.sequence;
        setBusy(true);
        one("[data-td-status]").textContent = "Подготовка проверок…";
        try {
            const payload = await post(root.dataset.checksUrl, {settings: checksSettings()});
            if (version !== state.sequence) return;
            state.checks = {rows: payload.rows};
            state.page = 0;
            one("[data-td-status]").textContent = "Проверки готовы. Эти значения не сохраняются в материалах.";
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
    });
    generatorForm.addEventListener("input", () => { if (state.generator) state.dirty = true; render(); });
    generatorForm.addEventListener("change", () => { if (state.generator) state.dirty = true; render(); });
    const passwordToggle = () => {
        one("[data-td-password-length]").hidden = !generatorForm.querySelector('[name="fields"][value="password"]').checked;
    };
    generatorForm.addEventListener("change", passwordToggle);
    checksForm.querySelector("[data-td-check-type]").addEventListener("change", event => {
        const kind = event.target.value;
        one("[data-td-length]").hidden = kind !== "text";
        one("[data-td-range]").hidden = !["date", "number"].includes(kind);
        one("[data-td-phone]").hidden = kind !== "phone";
        if (kind === "date") { checksForm.querySelector('[name="min"]').value = "2000-01-01";
            checksForm.querySelector('[name="max"]').value = "2030-12-31"; }
        if (kind === "number") { checksForm.querySelector('[name="min"]').value = "0";
            checksForm.querySelector('[name="max"]').value = "100"; }
    });
    document.querySelectorAll("[data-td-tab]").forEach(button => button.addEventListener("click", () => {
        state.tab = button.dataset.tdTab; state.page = 0; setError(""); render();
    }));
    all("[data-td-format]").forEach(button => button.addEventListener("click", () => {
        state.format = button.dataset.tdFormat; state.page = 0; render();
    }));
    one("[data-td-prev]").addEventListener("click", () => { state.page--; render(); });
    one("[data-td-next]").addEventListener("click", () => { state.page++; render(); });
    one("[data-td-copy]").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(exportText()); one("[data-td-status]").textContent = "Весь набор скопирован."; }
        catch { setError("Не удалось скопировать результат."); }
    });
    one("[data-td-download]").addEventListener("click", () => {
        const isJson = state.format === "json";
        const blob = new Blob([exportText()], {type: isJson ? "application/json;charset=utf-8" : "text/csv;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = "test-data." + (isJson ? "json" : "csv");
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const openSave = () => {
        if (state.tab !== "generator" || !state.generator || state.dirty || state.busy) return;
        const panel = one("[data-td-save-panel]");
        panel.hidden = false;
        panel.querySelector('[name="title"]').value = "";
        panel.querySelector('[name="title"]').focus();
    };
    one("[data-td-open-save]").addEventListener("click", openSave);
    one("[data-td-save-new]").addEventListener("click", openSave);
    one("[data-td-save-cancel]").addEventListener("click", () => { one("[data-td-save-panel]").hidden = true; });
    one("[data-td-save-panel]").addEventListener("submit", async event => {
        event.preventDefault();
        if (!state.generator || state.dirty || state.busy) return;
        const title = one("[data-td-save-panel]").querySelector('[name="title"]').value.trim();
        if (!title) return;
        setError(""); setBusy(true);
        try {
            const payload = await post(root.dataset.saveUrl, {title, settings: state.generator.settings,
                rows: state.generator.rows, proof: state.generator.proof});
            state.generator.id = payload.id; state.generator.title = payload.title;
            one("[data-td-save-panel]").hidden = true;
            one("[data-td-delete-form]").action = root.dataset.deleteTemplate.replace("/0/", `/${payload.id}/`);
            const quota = document.querySelector("[data-td-quota]");
            quota.textContent = `${Number.parseInt(quota.textContent, 10) + 1} / 10`;
            one("[data-td-status]").textContent = "Набор сохранён в материалах.";
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
    });
    one("[data-td-new]").addEventListener("click", () => {
        if (state.busy) return;
        state.generator = null; state.dirty = false; state.page = 0;
        one("[data-td-save-panel]").hidden = true;
        one("[data-td-status]").textContent = "Настройте поля и сгенерируйте новый набор.";
        setError(""); render();
    });
    if (initial) {
        generatorForm.querySelector('[name="count"]').value = initial.settings.count;
        generatorForm.querySelector('[name="locale"]').value = initial.settings.locale;
        generatorForm.querySelector('[name="password_length"]').value = initial.settings.password_length;
        all('[name="fields"]').forEach(input => { input.checked = initial.settings.fields.includes(input.value); });
    }
    passwordToggle();
    render();
})();
