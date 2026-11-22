(() => {
    "use strict";

    const root = document.querySelector("[data-screenshots]");
    if (!root) return;
    const find = selector => root.querySelector(selector);
    const sides = ["left", "right"];
    const entries = {left: null, right: null};
    const slots = Object.fromEntries(sides.map(side => [side, {
        input: find('[data-sc-file="' + side + '"]'),
        meta: find('[data-sc-meta="' + side + '"]'),
        thumbnail: find('[data-sc-thumb="' + side + '"]'),
        label: find('[data-sc-label="' + side + '"]'),
    }]));
    const run = find("[data-sc-run]");
    const cancel = find("[data-sc-cancel]");
    const demo = find("[data-sc-demo]");
    const status = find("[data-sc-status]");
    const resultPanel = find("[data-sc-result]");
    const image = find("[data-sc-output]");
    const summary = find("[data-sc-count]");
    const dims = find("[data-sc-dims]");
    const download = find("[data-sc-save]");
    const modes = [...root.querySelectorAll("[data-sc-mode]")];
    const threshold = find("[data-sc-threshold]");
    const weight = find("[data-sc-weight]");
    const number = new Intl.NumberFormat("ru");
    const percent = new Intl.NumberFormat("ru", {maximumFractionDigits: 2});
    const downloadUrls = new Set();
    let worker = null;
    let active = null;
    let sequence = 0;
    let wantsCompare = false;
    let mode = "diff";
    let result = null;

    function feedback(message, error = false) {
        status.textContent = message;
        status.classList.toggle("sc-error", error);
    }

    const geometry = ({width, height}) => width + " × " + height + " px";
    const ready = () => sides.every(side => entries[side]?.info);
    const matches = () => ready() && entries.left.info.width === entries.right.info.width
        && entries.left.info.height === entries.right.info.height;

    function controls() {
        run.disabled = !!active || !matches();
        demo.disabled = !!active;
        cancel.hidden = !active;
        cancel.disabled = !!active?.discard;
        download.disabled = !result;
    }

    function clearResult() {
        image.hidden = true;
        image.removeAttribute("src");
        if (result) URL.revokeObjectURL(result.url);
        result = null;
        summary.textContent = "";
        dims.textContent = "";
        controls();
    }

    function drawSlot(side) {
        const entry = entries[side];
        const slot = slots[side];
        slot.label.textContent = entry ? "Заменить файл" : "Выбрать файл";
        slot.thumbnail.hidden = !entry?.url;
        if (entry?.url) slot.thumbnail.src = entry.url;
        else slot.thumbnail.removeAttribute("src");
        if (!entry) {
            slot.meta.textContent = "Файл не выбран";
        } else if (entry.info) {
            slot.meta.textContent = entry.file.name + " · " + geometry(entry.info) + " · "
                + number.format(entry.file.size) + " байт";
        } else {
            slot.meta.textContent = entry.file.name + " · " + (entry.error || "ожидает проверки");
        }
        slot.meta.classList.toggle("sc-error", !!entry?.error);
    }

    function replace(side, file) {
        if (entries[side]?.url) URL.revokeObjectURL(entries[side].url);
        entries[side] = file ? {file} : null;
        drawSlot(side);
    }

    function pairFeedback() {
        if (sides.some(side => entries[side]?.error)) {
            feedback("Замените файл, который не удалось открыть.", true);
        } else if (ready() && !matches()) {
            feedback("Нужны снимки одинакового размера. Эталон: " + geometry(entries.left.info)
                + ", фактический: " + geometry(entries.right.info) + ".", true);
        } else if (matches()) {
            feedback("Снимки готовы. Нажмите «Сравнить».");
        } else {
            feedback("Выберите оба изображения или загрузите пример.");
        }
    }

    function cancelActive() {
        if (!active || active.discard) return;
        active.discard = true;
        worker.postMessage({id: active.id, type: "cancel"});
        controls();
    }

    function failWorker() {
        const job = active;
        active = null;
        worker?.terminate();
        worker = null;
        wantsCompare = false;
        if (job?.type === "inspect" && entries[job.side] === job.entry) {
            job.entry.error = "не удалось запустить обработку";
            drawSlot(job.side);
        }
        feedback("Не удалось запустить обработку снимков в браузере.", true);
        controls();
    }

    function start(type, payload, extra = {}) {
        active = {id: ++sequence, type, ...extra};
        try {
            if (!worker) {
                worker = new Worker(root.dataset.workerUrl);
                worker.onmessage = receive;
                worker.onerror = failWorker;
                worker.onmessageerror = failWorker;
            }
            worker.postMessage({id: active.id, type, ...payload});
        } catch {
            failWorker();
        }
        controls();
    }

    function pump() {
        if (active) return;
        for (const side of sides) {
            const entry = entries[side];
            if (entry && !entry.info && !entry.error) {
                feedback("Проверяем снимок…");
                start("inspect", {file: entry.file}, {side, entry});
                return;
            }
        }
        if (wantsCompare && matches()) {
            wantsCompare = false;
            feedback("Проверяем размеры снимков…");
            start("compare", {
                left: entries.left.file, right: entries.right.file, mode,
                threshold: Number(threshold.value), weight: Number(weight.value),
            }, {mode});
        }
        controls();
    }

    function showResult(data, view) {
        const total = data.width * data.height;
        const share = data.changed * 100 / total;
        const ratio = share > 0 && share < 0.01 ? "< 0,01" : percent.format(share);
        const prefix = data.changed ? "" : "Различий при этом пороге нет · ";
        summary.textContent = prefix + number.format(data.changed) + " из " + number.format(total)
            + " изменено (" + ratio + " %)";
        dims.textContent = geometry(data);
        result = {png: data.png, url: URL.createObjectURL(data.png), mode: view};
        image.src = result.url;
        image.hidden = false;
        feedback("Результат готов.");
    }

    function receive({data}) {
        const job = active;
        if (!job || job.id !== data.id) return;
        if (data.type === "progress") {
            if (!job.discard) feedback(data.message);
            return;
        }
        active = null;
        if (!job.discard) {
            if (job.type === "inspect" && entries[job.side] === job.entry) {
                if (data.type === "done") {
                    const {thumbnail, ...info} = data.result;
                    job.entry.info = info;
                    job.entry.url = URL.createObjectURL(thumbnail);
                } else {
                    job.entry.error = data.message || "проверка прервана";
                }
                drawSlot(job.side);
                pairFeedback();
            } else if (data.type === "done" && job.type === "compare") {
                showResult(data.result, job.mode);
            } else if (data.type === "done" && job.type === "demo") {
                replace("left", new File([data.result.files[0]], "etalon.png", {type: "image/png"}));
                replace("right", new File([data.result.files[1]], "fakticheskiy.png", {type: "image/png"}));
            } else if (data.type === "error") {
                feedback(data.message, true);
            }
        }
        pump();
    }

    function requestCompare() {
        if (!matches()) return;
        clearResult();
        if (active?.type === "compare") cancelActive();
        resultPanel.hidden = false;
        wantsCompare = true;
        pump();
    }

    for (const side of sides) {
        const {input} = slots[side];
        input.addEventListener("change", () => {
            const file = input.files[0];
            input.value = "";
            if (!file) return;
            replace(side, file);
            wantsCompare = false;
            resultPanel.hidden = true;
            clearResult();
            if (active && (active.type !== "inspect" || active.side === side)) cancelActive();
            if (active?.discard) feedback("Ждём завершения предыдущей операции…");
            pump();
        });
    }

    run.addEventListener("click", requestCompare);
    cancel.addEventListener("click", () => {
        wantsCompare = false;
        for (const side of sides) {
            if (entries[side] && !entries[side].info && !entries[side].error) replace(side, null);
        }
        clearResult();
        cancelActive();
        feedback("Операция отменена.");
    });
    demo.addEventListener("click", () => {
        if (active) return;
        wantsCompare = false;
        resultPanel.hidden = true;
        clearResult();
        feedback("Готовим пример пары…");
        start("demo", {});
    });

    for (const button of modes) {
        button.addEventListener("click", () => {
            if (mode === button.dataset.scMode) return;
            mode = button.dataset.scMode;
            for (const item of modes) item.setAttribute("aria-pressed", String(item === button));
            find("[data-sc-diff]").hidden = mode !== "diff";
            find("[data-sc-overlay]").hidden = mode !== "overlay";
            requestCompare();
        });
    }

    for (const [input, label, suffix] of [
        [threshold, find("[data-sc-threshold-value]"), ""],
        [weight, find("[data-sc-weight-value]"), "%"],
    ]) {
        input.addEventListener("input", () => {
            label.textContent = input.value + suffix;
            wantsCompare = false;
            clearResult();
            if (active?.type === "compare") cancelActive();
            feedback("Параметр изменён. Отпустите ползунок для пересчёта.");
        });
        input.addEventListener("change", requestCompare);
    }

    download.addEventListener("click", () => {
        if (!result || active) return;
        const url = URL.createObjectURL(result.png);
        downloadUrls.add(url);
        const link = document.createElement("a");
        link.href = url;
        link.download = result.mode === "diff" ? "screenshot-diff.png" : "screenshot-overlay.png";
        link.click();
        window.setTimeout(() => {
            URL.revokeObjectURL(url);
            downloadUrls.delete(url);
        }, 1000);
    });

    window.addEventListener("pagehide", () => {
        worker?.terminate();
        worker = null;
        active = null;
        wantsCompare = false;
        resultPanel.hidden = true;
        clearResult();
        for (const side of sides) replace(side, null);
        for (const url of downloadUrls) URL.revokeObjectURL(url);
        downloadUrls.clear();
        pairFeedback();
    });
})();
