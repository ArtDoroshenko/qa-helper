(() => {
    "use strict";
    const root = document.querySelector("[data-text-tool]");
    if (!root || !globalThis.QATextCompareCore) return;
    const core = globalThis.QATextCompareCore;
    const by = selector => root.querySelector(selector);
    const left = by('[data-text-input="left"]'), right = by('[data-text-input="right"]');
    const caseOption = by("[data-text-ignore-case]"), trailingOption = by("[data-text-ignore-trailing]");
    const run = by("[data-text-run]"), feedback = by("[data-text-feedback]");
    const reportPanel = by("[data-text-report]"), summary = by("[data-text-summary]");
    const position = by("[data-text-position]"), changePanel = by("[data-text-change]");
    const previous = by("[data-text-prev]"), next = by("[data-text-next]");
    const copy = by("[data-text-copy]"), download = by("[data-text-download]");
    let revision = 0, worker = null, result = null, reportText = "", selected = 0;
    const fileTokens = {left: 0, right: 0};
    const loading = {left: false, right: false};

    const options = () => ({ignoreCase: caseOption.checked, ignoreTrailing: trailingOption.checked});
    const status = (message, error = false) => {
        feedback.textContent = message;
        feedback.classList.toggle("error", error);
    };
    function invalidate(message = "Данные изменены. Сравните текст снова.") {
        revision++;
        if (worker) { worker.terminate(); worker = null; }
        result = null;
        reportText = "";
        reportPanel.hidden = true;
        run.disabled = loading.left || loading.right;
        status(message);
    }
    for (const side of ["left", "right"]) {
        const element = side === "left" ? left : right;
        element.addEventListener("input", () => {
            fileTokens[side]++;
            loading[side] = false;
            by(`[data-text-side-status="${side}"]`).textContent = "До 2 МиБ UTF-8 · 20 000 строк";
            invalidate();
        });
    }
    [caseOption, trailingOption].forEach(element => element.addEventListener("change", () => invalidate()));

    async function readFile(file, side, token) {
        const sideStatus = by(`[data-text-side-status="${side}"]`);
        if (!file) return;
        if (file.size > core.MAX_BYTES) throw new Error("Файл должен быть не больше 2 МиБ UTF-8.");
        const buffer = await file.arrayBuffer();
        if (token !== fileTokens[side]) return;
        let value;
        try { value = new TextDecoder("utf-8", {fatal: true}).decode(buffer); }
        catch (error) { throw new Error("Файл должен быть в UTF-8."); }
        core.prepare(value);
        if (token !== fileTokens[side]) return;
        const field = side === "left" ? left : right;
        field.value = value;
        sideStatus.textContent = `${file.name} · ${file.size} байт`;
        invalidate();
        status("Файл загружен. Нажмите «Сравнить текст».");
    }
    for (const side of ["left", "right"]) {
        by(`[data-text-file="${side}"]`).addEventListener("change", async event => {
            const token = ++fileTokens[side];
            loading[side] = true;
            invalidate("Загружаем файл…");
            try { await readFile(event.target.files[0], side, token); }
            catch (error) { if (token === fileTokens[side]) status(error.message || "Не удалось прочитать файл.", true); }
            if (token === fileTokens[side]) {
                loading[side] = false;
                run.disabled = loading.left || loading.right;
            }
            event.target.value = "";
        });
    }

    const text = (tag, content, className = "") => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = content;
        return element;
    };
    function highlighted(parts) {
        const line = document.createElement("pre");
        line.append(document.createTextNode(parts[0]));
        if (parts[1]) line.append(text("mark", parts[1]));
        line.append(document.createTextNode(parts[2]));
        return line;
    }
    function renderChange() {
        changePanel.replaceChildren();
        if (!result.changes.length) {
            changePanel.append(text("p", "Отличий нет."));
            position.textContent = "0 из 0";
            previous.disabled = true;
            next.disabled = true;
            return;
        }
        const item = result.changes[selected];
        const labels = {added: "Добавлена строка", removed: "Удалена строка", modified: "Изменена строка"};
        changePanel.append(text("h3", `${labels[item.kind]} · ${selected + 1} из ${result.changes.length}`));
        for (const [side, marker] of [["left", "−"], ["right", "+"]]) {
            const number = item[`${side}Number`], value = item[`${side}Text`];
            if (number === null) continue;
            const row = document.createElement("div");
            row.className = `text-change-row text-${side}`;
            row.append(text("span", `${marker} ${side === "left" ? "Исходная" : "Изменённая"} строка ${number}`));
            row.append(item.fragments ? highlighted(item.fragments[side]) : text("pre", value));
            changePanel.append(row);
        }
        position.textContent = `${selected + 1} из ${result.changes.length}`;
        previous.disabled = selected === 0;
        next.disabled = selected === result.changes.length - 1;
    }
    previous.addEventListener("click", () => { if (result && selected > 0) { selected--; renderChange(); } });
    next.addEventListener("click", () => { if (result && selected + 1 < result.changes.length) { selected++; renderChange(); } });

    run.addEventListener("click", () => {
        if (loading.left || loading.right) return;
        invalidate("Проверяем входные данные…");
        const token = revision, currentOptions = options();
        try {
            if (left.value === "" && right.value === "") throw new Error("Введите текст хотя бы на одной стороне.");
            core.prepare(left.value, currentOptions);
            core.prepare(right.value, currentOptions);
            worker = new Worker(root.dataset.workerUrl);
            run.disabled = true;
            status("Сравниваем строки…");
            worker.onmessage = event => {
                if (token !== revision) return;
                worker.terminate(); worker = null;
                run.disabled = false;
                if (!event.data.ok) { status(event.data.error, true); return; }
                result = event.data.result;
                reportText = core.report(result, currentOptions);
                selected = 0;
                summary.textContent = `Добавлено: ${result.counts.added} · удалено: ${result.counts.removed} · изменено: ${result.counts.modified}`;
                reportPanel.hidden = false;
                renderChange();
                status(result.changes.length ? `Найдено отличий: ${result.changes.length}.` : "Тексты совпадают по выбранным правилам.");
            };
            worker.onerror = () => {
                if (token !== revision) return;
                worker.terminate(); worker = null;
                run.disabled = false;
                status("Не удалось сравнить текст. Повторите попытку.", true);
            };
            worker.postMessage({left: left.value, right: right.value, options: currentOptions});
        } catch (error) {
            if (worker) { worker.terminate(); worker = null; }
            run.disabled = false;
            status(error.message || "Не удалось сравнить текст.", true);
        }
    });
    copy.addEventListener("click", async () => {
        if (!result) return;
        const token = revision;
        try {
            await navigator.clipboard.writeText(reportText);
            if (token === revision) status("Полный отчёт скопирован.");
        } catch (error) { if (token === revision) status("Не удалось скопировать отчёт.", true); }
    });
    download.addEventListener("click", () => {
        if (!result) return;
        const url = URL.createObjectURL(new Blob([reportText], {type: "text/plain;charset=utf-8"}));
        const link = document.createElement("a");
        link.href = url;
        link.download = "text-comparison.txt";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
})();
