(() => {
    "use strict";
    const root = document.querySelector("[data-td-files]");
    const core = globalThis.QATestFilesCore;
    if (!root || !core) return;

    const one = selector => root.querySelector(selector);
    const form = one("[data-tf-form]");
    const status = one("[data-tf-status]");
    const results = one("[data-tf-results]");
    const run = one("[data-tf-run]");
    const cancel = one("[data-tf-cancel]");
    const reset = one("[data-tf-reset]");
    const urls = new Map();
    let revision = 0, busy = false, awaitingRelease = false, pendingMessage = "";
    let files = [], activeCanvas = null;
    const pause = () => new Promise(resolve => setTimeout(resolve, 0));

    function message(value, error = false) {
        status.textContent = value;
        status.classList.toggle("error", error);
    }
    function releaseUrls() {
        for (const [url, timer] of urls) {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
        }
        urls.clear();
    }
    function syncControls() {
        run.disabled = busy;
        cancel.hidden = !busy || awaitingRelease;
        form.querySelectorAll("input, select").forEach(control => { control.disabled = busy && !awaitingRelease; });
    }
    function showMode() {
        const mode = one("[data-tf-mode]").value;
        root.querySelectorAll("[data-tf-panel]").forEach(panel => { panel.hidden = panel.dataset.tfPanel !== mode; });
    }
    function invalidate(value) {
        revision++;
        if (activeCanvas && !busy) {
            activeCanvas.width = 0;
            activeCanvas.height = 0;
            activeCanvas = null;
        }
        files = [];
        results.replaceChildren();
        releaseUrls();
        awaitingRelease = busy;
        pendingMessage = busy ? value : "";
        syncControls();
        message(busy ? `${value} Ожидаем завершения предыдущего кодирования; новый запуск пока недоступен.` : value);
    }
    function input() {
        showMode();
        invalidate("Параметры изменены. Создайте новый набор образцов.");
    }
    function imageOptions(plan) {
        const canvas = document.createElement("canvas");
        canvas.width = plan.width;
        canvas.height = plan.height;
        const context = canvas.getContext("2d", {alpha: false});
        if (!context) {
            canvas.width = 0;
            canvas.height = 0;
            throw new Error("Браузер не смог создать холст изображения.");
        }
        try {
            const dark = plan.background === "dark";
            context.fillStyle = dark ? "#203047" : "#f6f9fc";
            context.fillRect(0, 0, plan.width, plan.height);
            if (plan.pattern === "grid") {
                context.strokeStyle = dark ? "#7790b0" : "#9bb3d2";
                context.lineWidth = 1;
                const step = 64;
                context.beginPath();
                for (let x = step; x < plan.width; x += step) { context.moveTo(x + .5, 0); context.lineTo(x + .5, plan.height); }
                for (let y = step; y < plan.height; y += step) { context.moveTo(0, y + .5); context.lineTo(plan.width, y + .5); }
                context.stroke();
            }
            return canvas;
        } catch (error) {
            canvas.width = 0;
            canvas.height = 0;
            throw error;
        }
    }
    async function encodeImage(plan, token) {
        const canvas = imageOptions(plan);
        activeCanvas = canvas;
        let blob;
        try {
            blob = await new Promise((resolve, reject) => {
                try { canvas.toBlob(resolve, plan.mime, plan.format === "jpeg" ? .85 : undefined); }
                catch (error) { reject(error); }
            });
        } finally {
            canvas.width = 0;
            canvas.height = 0;
            if (activeCanvas === canvas) activeCanvas = null;
        }
        if (!blob) throw new Error("Браузер не смог закодировать изображение.");
        if (token !== revision) throw new Error("Создание отменено.");
        core.verifyBlob(blob, plan.name);
        if (blob.type !== plan.mime) throw new Error(`Кодировщик вернул ${blob.type || "неизвестный MIME"} вместо ${plan.mime}.`);
        if (typeof createImageBitmap !== "function") throw new Error("Браузер не поддерживает проверку геометрии изображения.");
        const bitmap = await createImageBitmap(blob);
        const geometry = {width: bitmap.width, height: bitmap.height};
        bitmap.close?.();
        if (geometry.width !== plan.width || geometry.height !== plan.height) {
            throw new Error("Фактическая геометрия изображения не совпала с заданной.");
        }
        return {blob, geometry};
    }
    function plan() {
        const base = one("[data-tf-base]").value;
        const mode = one("[data-tf-mode]").value;
        if (mode === "exact") return {mode, value: core.planExact({base, size: one("[data-tf-size]").value,
            unit: one("[data-tf-unit]").value, format: one("[data-tf-format]").value,
            triple: one("[data-tf-triple]").checked})};
        if (mode === "image") return {mode, value: core.planImage({base,
            width: one("[data-tf-width]").value, height: one("[data-tf-height]").value,
            format: one("[data-tf-image-format]").value, pattern: one("[data-tf-pattern]").value,
            background: one("[data-tf-background]").value})};
        if (mode === "negative") return {mode, value: core.planNegative({base, kind: one("[data-tf-negative]").value})};
        if (mode === "names") return {mode, value: core.planNames(base)};
        throw new Error("Выберите сценарий создания файлов.");
    }
    async function generate(job, token) {
        await pause();
        if (token !== revision) throw new Error("Создание отменено.");
        if (job.mode === "exact") return core.makeExact(job.value);
        if (job.mode === "names") {
            const blob = new Blob([new Uint8Array(32).fill(65)], {type: "text/plain"});
            return job.value.map(item => ({...item, blob, mime: blob.type, note: "32 ASCII-байта A · без BOM"}));
        }
        if (job.mode === "image") {
            const {blob, geometry} = await encodeImage(job.value, token);
            return [{name: job.value.name, blob, mime: blob.type, geometry,
                note: `${job.value.pattern === "grid" ? "Тестовая сетка" : "Однотонный фон"}${job.value.format === "jpeg" ? " · JPEG quality 0,85" : ""}`}];
        }
        if (job.value.kind === "empty") {
            const blob = new Blob([], {type: "application/octet-stream"});
            return [{name: job.value.name, blob, mime: blob.type, note: job.value.note}];
        }
        const image = core.planImage({base: "negative-source", width: "1", height: "1", format: "png",
            pattern: "plain", background: "light"});
        const {blob} = await encodeImage(image, token);
        if (blob.size <= 24) throw new Error("PNG слишком короткий для усечения до 24 байт.");
        const result = job.value.kind === "truncated" ? blob.slice(0, 24, "image/png") : blob;
        return [{name: job.value.name, blob: result, mime: result.type, note: job.value.note}];
    }
    function download(file) {
        if (!files.includes(file) || busy) return;
        let url;
        const link = document.createElement("a");
        try {
            url = URL.createObjectURL(file.blob);
            link.href = url;
            link.download = file.name;
            document.body.append(link);
            link.click();
            const timer = setTimeout(() => {
                if (urls.delete(url)) URL.revokeObjectURL(url);
            }, 1000);
            urls.set(url, timer);
        } catch (error) {
            if (url) URL.revokeObjectURL(url);
            message("Не удалось начать скачивание.", true);
        } finally { link.remove(); }
    }
    function renderFiles() {
        results.replaceChildren();
        for (const file of files) {
            const row = document.createElement("div");
            row.className = "tf-file";
            const copy = document.createElement("div");
            copy.className = "tf-file-copy";
            const title = document.createElement("strong");
            title.textContent = file.name;
            const meta = document.createElement("small");
            meta.textContent = `${file.blob.size.toLocaleString("ru-RU")} байт · ${file.mime}`
                + (file.geometry ? ` · ${file.geometry.width} × ${file.geometry.height} px` : "");
            const note = document.createElement("span");
            note.textContent = file.note;
            copy.append(title, meta, note);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "secondary-action";
            button.textContent = "Скачать";
            button.setAttribute("aria-label", `Скачать ${file.name}`);
            button.addEventListener("click", () => download(file));
            row.append(copy, button);
            results.append(row);
        }
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy) {
            if (awaitingRelease) message("Ожидаем завершения предыдущего кодирования; новый запуск пока недоступен.");
            return;
        }
        let job;
        try { job = plan(); }
        catch (error) { invalidate(""); message(error.message, true); return; }
        const token = ++revision;
        files = [];
        results.replaceChildren();
        releaseUrls();
        busy = true;
        awaitingRelease = false;
        pendingMessage = "";
        syncControls();
        message("Создаём файлы в браузере…");
        try {
            const created = await generate(job, token);
            if (token !== revision) return;
            for (const file of created) core.verifyBlob(file.blob, file.name);
            core.checkSizes(created.map(file => file.blob.size));
            files = created;
            renderFiles();
            message(`Готово: ${files.length} ${files.length === 1 ? "файл" : "файла"}. Размеры указаны по фактическим байтам.`);
        } catch (error) {
            if (token !== revision) return;
            files = [];
            results.replaceChildren();
            message(error.message || "Не удалось создать файл.", true);
        } finally {
            busy = false;
            awaitingRelease = false;
            syncControls();
            if (token !== revision) {
                message(`${pendingMessage || "Создание отменено."} Предыдущее кодирование завершилось; можно создать файлы.`);
                pendingMessage = "";
            }
        }
    });
    form.addEventListener("input", input);
    form.addEventListener("change", input);
    cancel.addEventListener("click", () => {
        if (busy && !awaitingRelease) invalidate("Создание отменено. Уже начатое кодирование изображения может завершиться в браузере, но результат не появится.");
    });
    reset.addEventListener("click", () => { form.reset(); showMode(); invalidate("Параметры сброшены. Выберите сценарий и создайте файлы."); });
    window.addEventListener("pagehide", releaseUrls);
    showMode();
})();
