(() => {
    "use strict";
    const panel = document.querySelector("[data-json-compare]");
    if (!panel) return;
    const analyzer = document.querySelector("[data-json-analyzer]");
    const materialLink = document.querySelector("[data-json-analyzer-link]");
    const tabs = [...document.querySelectorAll("[data-json-lab-tab]")];
    const input = {
        left: panel.querySelector('[data-compare-input="left"]'),
        right: panel.querySelector('[data-compare-input="right"]'),
    };
    const sideStatus = {
        left: panel.querySelector('[data-compare-side-status="left"]'),
        right: panel.querySelector('[data-compare-side-status="right"]'),
    };
    const run = panel.querySelector("[data-compare-run]");
    const status = panel.querySelector("[data-compare-status]");
    const reportPanel = panel.querySelector("[data-compare-report]");
    const summary = panel.querySelector("[data-compare-summary]");
    const counts = panel.querySelector("[data-compare-counts]");
    const list = panel.querySelector("[data-compare-list]");
    const pageLabel = panel.querySelector("[data-compare-page]");
    const prev = panel.querySelector("[data-compare-prev]");
    const next = panel.querySelector("[data-compare-next]");
    const copy = panel.querySelector("[data-compare-copy]");
    const download = panel.querySelector("[data-compare-download]");
    const pageSize = 8;
    const fileLimit = 2 * 1024 * 1024;
    const timeoutMs = 10000;
    const fileEpoch = {left: 0, right: 0};
    const filePending = {left: false, right: false};
    let revision = 0;
    let worker = null;
    let result = null;
    let page = 0;
    let busy = false;
    let timer = null;

    function clearTimer() {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
    }

    function showTab(name) {
        const comparing = name === "compare";
        analyzer.hidden = comparing;
        panel.hidden = !comparing;
        materialLink.hidden = comparing;
        tabs.forEach((tab) => {
            const selected = tab.dataset.jsonLabTab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => showTab(tab.dataset.jsonLabTab));
        tab.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[target].focus();
            showTab(tabs[target].dataset.jsonLabTab);
        });
    });

    function sync() {
        run.disabled = busy || filePending.left || filePending.right;
        copy.disabled = !result;
        download.disabled = !result;
    }
    function feedback(message, error = false) {
        status.textContent = message;
        status.classList.toggle("error", error);
    }
    function invalidate() {
        revision++;
        clearTimer();
        worker?.terminate();
        worker = null;
        busy = false;
        result = null;
        page = 0;
        reportPanel.hidden = true;
        list.replaceChildren();
        feedback("Данные изменены. Запустите сравнение заново.");
        sync();
    }
    for (const side of ["left", "right"]) {
        input[side].addEventListener("input", () => {
            fileEpoch[side]++;
            filePending[side] = false;
            sideStatus[side].textContent = "Изменён · до 2 МиБ UTF-8";
            invalidate();
        });
        panel.querySelector(`[data-compare-file="${side}"]`).addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const epoch = ++fileEpoch[side];
            filePending[side] = true;
            invalidate();
            sideStatus[side].textContent = "Читаем файл…";
            feedback("Читаем файл…");
            try {
                if (!/\.json$/i.test(file.name)) throw new Error("Выберите файл с расширением .json.");
                if (file.size > fileLimit) throw new Error("Файл превышает 2 МиБ UTF-8.");
                const bytes = await file.arrayBuffer();
                if (epoch !== fileEpoch[side]) return;
                let value;
                try { value = new TextDecoder("utf-8", {fatal: true}).decode(bytes).replace(/^\uFEFF/, ""); }
                catch (error) { throw new Error("Требуется корректный UTF-8."); }
                if (new TextEncoder().encode(value).length > fileLimit) throw new Error("Файл превышает 2 МиБ UTF-8.");
                if (epoch !== fileEpoch[side]) return;
                input[side].value = value;
                invalidate();
                sideStatus[side].textContent = `${file.name} · готов к сравнению`;
                feedback("Файл прочитан. Запустите сравнение.");
            } catch (error) {
                if (epoch === fileEpoch[side]) {
                    sideStatus[side].textContent = error.message || "Не удалось прочитать файл.";
                    feedback(`${side === "left" ? "Исходный" : "Изменённый"} JSON: ${sideStatus[side].textContent}`, true);
                }
            } finally {
                if (epoch === fileEpoch[side]) filePending[side] = false;
                event.target.value = "";
                sync();
            }
        });
    }

    function valueBlock(label, value) {
        const wrapper = document.createElement("div");
        wrapper.className = "json-compare-value";
        const heading = document.createElement("span");
        heading.textContent = label;
        const code = document.createElement("pre");
        code.textContent = value.present ? value.json : "Отсутствует";
        if (!value.present) code.className = "json-compare-missing";
        wrapper.append(heading, code);
        return wrapper;
    }
    function renderPage() {
        const changes = result.changes;
        const totalPages = Math.max(1, Math.ceil(changes.length / pageSize));
        list.replaceChildren();
        for (const change of changes.slice(page * pageSize, (page + 1) * pageSize)) {
            const card = document.createElement("article");
            card.className = `json-compare-card json-compare-${change.type}`;
            const top = document.createElement("div");
            top.className = "json-compare-card-head";
            const path = document.createElement("code");
            path.textContent = change.path;
            const kind = document.createElement("span");
            kind.textContent = {added: "Добавлено", removed: "Удалено", changed: "Изменено"}[change.type];
            top.append(path, kind);
            const values = document.createElement("div");
            values.className = "json-compare-values";
            values.append(valueBlock("До", change.before), valueBlock("После", change.after));
            card.append(top, values);
            list.append(card);
        }
        if (!changes.length) {
            const empty = document.createElement("p");
            empty.className = "json-compare-empty";
            empty.textContent = "Отличий нет.";
            list.append(empty);
        }
        pageLabel.textContent = `${page + 1} / ${totalPages}`;
        prev.disabled = page === 0;
        next.disabled = page + 1 >= totalPages;
    }
    function showResult(data) {
        result = data;
        page = 0;
        summary.textContent = data.equal ? "Документы равны" : "Документы различаются";
        counts.textContent = `Добавлено: ${data.counts.added} · удалено: ${data.counts.removed} · изменено: ${data.counts.changed}`;
        sideStatus.left.textContent = "JSON корректен";
        sideStatus.right.textContent = "JSON корректен";
        renderPage();
        reportPanel.hidden = false;
        feedback(data.equal ? "Документы равны." : `Найдено отличий: ${data.changes.length}.`);
        sync();
    }
    function showError(error) {
        const side = error.side === "left" ? "Исходный JSON" : error.side === "right" ? "Изменённый JSON" : "Сравнение JSON";
        const position = error.line == null ? "" : ` Строка ${error.line}, столбец ${error.column}.`;
        const message = `${side}: ${error.message}${position}`;
        if (error.side) sideStatus[error.side].textContent = `${error.message}${position}`;
        feedback(message, true);
    }
    run.addEventListener("click", () => {
        if (run.disabled) return;
        invalidate();
        const current = revision;
        busy = true;
        sync();
        feedback("Сравниваем…");
        try {
            const job = new Worker(panel.dataset.workerUrl);
            worker = job;
            timer = window.setTimeout(() => {
                if (current !== revision || job !== worker) return;
                job.terminate();
                worker = null;
                timer = null;
                busy = false;
                showError({message: "Время сравнения превысило 10 секунд. Отчёт не сформирован."});
                sync();
            }, timeoutMs);
            job.onmessage = ({data}) => {
                if (current !== revision || job !== worker || data.id !== current) return;
                clearTimer();
                job.terminate();
                worker = null;
                busy = false;
                if (data.ok) showResult(data.result);
                else { showError(data.error); sync(); }
            };
            job.onerror = () => {
                if (current !== revision || job !== worker) return;
                clearTimer();
                job.terminate();
                worker = null;
                busy = false;
                showError({message: "Не удалось запустить обработку в браузере."});
                sync();
            };
            job.postMessage({id: current, left: input.left.value, right: input.right.value});
        } catch (error) {
            clearTimer();
            worker?.terminate();
            worker = null;
            busy = false;
            showError({message: "Браузер не поддерживает обработку в отдельном потоке."});
            sync();
        }
    });
    prev.addEventListener("click", () => { if (result && page > 0) { page--; renderPage(); } });
    next.addEventListener("click", () => {
        if (result && (page + 1) * pageSize < result.changes.length) { page++; renderPage(); }
    });
    copy.addEventListener("click", async () => {
        if (!result) return;
        const current = revision;
        try {
            await navigator.clipboard.writeText(result.report);
            if (current === revision) feedback("Полный отчёт скопирован.");
        } catch (error) {
            if (current === revision) feedback("Не удалось скопировать отчёт. Проверьте доступ к буферу обмена.", true);
        }
    });
    download.addEventListener("click", () => {
        if (!result) return;
        const url = URL.createObjectURL(new Blob([result.report], {type: "application/json;charset=utf-8"}));
        const link = document.createElement("a");
        link.href = url;
        link.download = "json-comparison.json";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        feedback("Полный отчёт подготовлен.");
    });
    sync();
})();
