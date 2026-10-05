(() => {
    "use strict";
    const root = document.querySelector(".base64-page");
    if (!root || !globalThis.QAConverterCore) return;
    const core = globalThis.QAConverterCore;
    const tabs = [...root.querySelectorAll("[data-converter-tab]")];
    const panels = Object.fromEntries([...root.querySelectorAll("[data-converter-panel]")]
        .map(panel => [panel.dataset.converterPanel, panel]));
    const find = (name, selector) => panels[name].querySelector(selector);
    const feedback = (element, message, tone = "") => {
        element.textContent = message;
        element.classList.toggle("error", tone === "error");
        element.classList.toggle("success", tone === "success");
    };
    const downloadText = (value, name, type) => {
        const url = URL.createObjectURL(new Blob([value], {type}));
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    async function copyText(value, status, current) {
        try {
            await navigator.clipboard.writeText(value);
            if (current()) feedback(status, "Скопировано.", "success");
        } catch (error) {
            if (current()) feedback(status, "Не удалось скопировать. Проверьте доступ к буферу обмена.", "error");
        }
    }
    function showTab(name) {
        for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
        tabs.forEach(tab => {
            const selected = tab.dataset.converterTab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => showTab(tab.dataset.converterTab));
        tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[target].focus();
            showTab(tabs[target].dataset.converterTab);
        });
    });

    function setupDate() {
        const direction = find("date", "[data-date-direction]");
        const unit = find("date", "[data-date-unit]");
        const zone = find("date", "[data-date-zone]");
        const source = find("date", "[data-date-source]");
        const label = find("date", "[data-date-label]");
        const hint = find("date", "[data-date-hint]");
        const output = find("date", "[data-date-output]");
        const meta = find("date", "[data-date-meta]");
        const status = find("date", "[data-date-status]");
        const copy = find("date", "[data-date-copy]");
        const run = find("date", "[data-date-run]");
        let revision = 0, value = null;
        const labels = () => {
            const reverse = direction.value === "to-stamp";
            label.textContent = reverse ? "Дата и время" : `Timestamp в ${unit.value === "s" ? "секундах" : "миллисекундах"}`;
            hint.textContent = reverse ? "ГГГГ-ММ-ДД ЧЧ:ММ:СС · выбранный пояс"
                : `${unit.value === "s" ? "Секунды" : "Миллисекунды"} с 01.01.1970 UTC`;
            source.placeholder = reverse ? "2026-10-02 12:30:00" : unit.value === "s" ? "1790899200" : "1790899200000";
        };
        const invalidate = () => {
            revision++;
            value = null;
            output.textContent = "Результат появится здесь";
            meta.textContent = "Дата · время · часовой пояс";
            copy.disabled = true;
            run.disabled = false;
            feedback(status, "Данные изменены. Запустите преобразование снова.");
        };
        for (const control of [direction, unit, zone]) control.addEventListener("change", () => { labels(); invalidate(); });
        source.addEventListener("input", invalidate);
        run.addEventListener("click", () => {
            invalidate();
            const current = revision;
            run.disabled = true;
            feedback(status, "Обработка…");
            window.setTimeout(() => {
                if (current !== revision) return;
                try {
                    const result = core.convertDate(source.value, direction.value, unit.value, zone.value);
                    if (current !== revision) return;
                    value = result.output;
                    output.textContent = value;
                    meta.textContent = result.meta;
                    copy.disabled = false;
                    feedback(status, "Преобразовано.", "success");
                } catch (error) { if (current === revision) feedback(status, error.message, "error"); }
                finally { if (current === revision) run.disabled = false; }
            }, 0);
        });
        copy.addEventListener("click", () => { if (value !== null) { const current = revision; copyText(value, status, () => current === revision); } });
        labels();
    }

    function setupUrl() {
        const operation = find("url", "[data-url-operation]");
        const mode = find("url", "[data-url-mode]");
        const source = find("url", "[data-url-source]");
        const output = find("url", "[data-url-output]");
        const status = find("url", "[data-url-status]");
        const run = find("url", "[data-url-run]");
        const copy = find("url", "[data-url-copy]");
        const download = find("url", "[data-url-download]");
        let revision = 0, value = null;
        const invalidate = () => {
            revision++;
            value = null;
            output.textContent = "Результат появится здесь";
            copy.disabled = true;
            download.disabled = true;
            run.disabled = false;
            feedback(status, "Данные изменены. Запустите преобразование снова.");
        };
        source.addEventListener("input", invalidate);
        for (const control of [operation, mode]) control.addEventListener("change", invalidate);
        run.addEventListener("click", () => {
            invalidate();
            const current = revision;
            run.disabled = true;
            feedback(status, "Обработка…");
            window.setTimeout(() => {
                if (current !== revision) return;
                try {
                    value = core.convertUrl(source.value, operation.value, mode.value);
                    output.textContent = value;
                    copy.disabled = false;
                    download.disabled = false;
                    feedback(status, "Выполнен один шаг преобразования.", "success");
                } catch (error) { if (current === revision) feedback(status, error.message, "error"); }
                finally { if (current === revision) run.disabled = false; }
            }, 0);
        });
        copy.addEventListener("click", () => { if (value !== null) { const current = revision; copyText(value, status, () => current === revision); } });
        download.addEventListener("click", () => { if (value !== null) downloadText(value, "url-result.txt", "text/plain;charset=utf-8"); });
    }

    function setupJwt() {
        const source = find("jwt", "[data-jwt-source]");
        const run = find("jwt", "[data-jwt-run]");
        const status = find("jwt", "[data-jwt-status]");
        const resultPanel = find("jwt", "[data-jwt-result]");
        const header = find("jwt", "[data-jwt-header]");
        const payload = find("jwt", "[data-jwt-payload]");
        const dates = find("jwt", "[data-jwt-dates]");
        const expiry = find("jwt", "[data-jwt-expiry]");
        let revision = 0, value = null;
        const invalidate = () => {
            revision++;
            value = null;
            resultPanel.hidden = true;
            header.textContent = "";
            payload.textContent = "";
            dates.replaceChildren();
            run.disabled = false;
            feedback(status, "Токен изменён. Декодируйте снова.");
        };
        source.addEventListener("input", invalidate);
        run.addEventListener("click", () => {
            invalidate();
            const current = revision;
            run.disabled = true;
            feedback(status, "Декодируем…");
            window.setTimeout(() => {
                if (current !== revision) return;
                try {
                    value = core.decodeJwt(source.value);
                    header.textContent = value.header;
                    payload.textContent = value.payload;
                    expiry.textContent = value.expiry;
                    for (const item of value.dates) {
                        const row = document.createElement("div"), name = document.createElement("dt"), date = document.createElement("dd");
                        name.textContent = item.name;
                        date.textContent = item.text;
                        row.append(name, date);
                        dates.append(row);
                    }
                    resultPanel.hidden = false;
                    feedback(status, "Декодировано локально · подпись не проверена.", "success");
                } catch (error) { if (current === revision) feedback(status, error.message, "error"); }
                finally { if (current === revision) run.disabled = false; }
            }, 0);
        });
        for (const [field, button] of [["header", "[data-jwt-header-copy]"], ["payload", "[data-jwt-payload-copy]"]]) {
            find("jwt", button).addEventListener("click", () => {
                if (value !== null) { const current = revision; copyText(value[field], status, () => current === revision); }
            });
        }
        find("jwt", "[data-jwt-download]").addEventListener("click", () => {
            if (value !== null) downloadText(value.download, "jwt-decoded.json", "application/json;charset=utf-8");
        });
    }

    function setupHash() {
        const panel = panels.hash;
        const modes = [...panel.querySelectorAll("[data-hash-mode]")];
        const source = find("hash", "[data-hash-source]");
        const filePanel = find("hash", "[data-hash-file-panel]");
        const fileInput = find("hash", "[data-hash-file]");
        const fileName = find("hash", "[data-hash-filename]");
        const algorithm = find("hash", "[data-hash-algorithm]");
        const expected = find("hash", "[data-hash-expected]");
        const output = find("hash", "[data-hash-output]");
        const meta = find("hash", "[data-hash-meta]");
        const match = find("hash", "[data-hash-match]");
        const status = find("hash", "[data-hash-status]");
        const run = find("hash", "[data-hash-run]");
        const copy = find("hash", "[data-hash-copy]");
        let mode = "text", revision = 0, worker = null, value = null;
        const invalidate = () => {
            revision++;
            worker?.terminate();
            worker = null;
            value = null;
            output.textContent = "Результат появится здесь";
            meta.textContent = `${algorithm.value} · hex`;
            copy.disabled = true;
            run.disabled = false;
            feedback(match, "");
            feedback(status, "Данные изменены. Вычислите хеш снова.");
        };
        modes.forEach(button => button.addEventListener("click", () => {
            mode = button.dataset.hashMode;
            modes.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
            source.hidden = mode === "file";
            filePanel.hidden = mode !== "file";
            invalidate();
        }));
        source.addEventListener("input", invalidate);
        fileInput.addEventListener("change", () => {
            fileName.textContent = fileInput.files?.[0] ? `${fileInput.files[0].name} · ${fileInput.files[0].size} байт` : "Файл не выбран · до 20 МиБ";
            invalidate();
        });
        algorithm.addEventListener("change", invalidate);
        expected.addEventListener("input", invalidate);
        run.addEventListener("click", async () => {
            invalidate();
            const current = revision;
            run.disabled = true;
            try {
                const wanted = core.validateExpectedHex(expected.value, algorithm.value);
                let buffer;
                if (mode === "file") {
                    const file = fileInput.files?.[0];
                    if (!file) throw new Error("Выберите файл.");
                    core.validateHashFileSize(file.size);
                    feedback(status, "Читаем файл…");
                    buffer = await file.arrayBuffer();
                    if (current !== revision) return;
                    core.validateHashFileSize(buffer.byteLength);
                } else {
                    if (!source.value) throw new Error("Введите текст или выберите файл.");
                    buffer = new TextEncoder().encode(source.value).buffer;
                }
                if (current !== revision) return;
                feedback(status, "Вычисляем хеш…");
                const job = new Worker(panel.dataset.workerUrl);
                worker = job;
                job.onmessage = ({data}) => {
                    if (current !== revision || job !== worker || data.id !== current) return;
                    job.terminate();
                    worker = null;
                    run.disabled = false;
                    if (!data.ok) { feedback(status, data.error, "error"); return; }
                    value = data.digest;
                    output.textContent = value;
                    meta.textContent = `${algorithm.value} · ${data.size} байт`;
                    copy.disabled = false;
                    if (wanted) feedback(match, wanted === value ? "Хеши совпадают" : "Хеши не совпадают", wanted === value ? "success" : "error");
                    feedback(status, "Хеш вычислен.", "success");
                };
                job.onerror = () => {
                    if (current !== revision || job !== worker) return;
                    job.terminate();
                    worker = null;
                    run.disabled = false;
                    feedback(status, "Не удалось вычислить хеш в браузере.", "error");
                };
                job.postMessage({id: current, mode, algorithm: algorithm.value, buffer}, [buffer]);
            } catch (error) {
                if (current === revision) {
                    worker?.terminate();
                    worker = null;
                    run.disabled = false;
                    feedback(status, error.message || "Не удалось вычислить хеш.", "error");
                }
            }
        });
        copy.addEventListener("click", () => { if (value !== null) { const current = revision; copyText(value, status, () => current === revision); } });
    }

    setupDate();
    setupUrl();
    setupJwt();
    setupHash();
})();
