(() => {
    "use strict";
    const page = document.querySelector("[data-text-tool]");
    const panel = page?.querySelector("[data-spelling-tool]");
    if (!page || !panel || !globalThis.QASpellingUI) return;
    let worker = null, sequence = 0;
    const pending = new Map();

    function stop(reason) {
        if (worker) worker.terminate();
        worker = null;
        for (const job of pending.values()) {
            clearTimeout(job.timer);
            job.signal?.removeEventListener("abort", job.abort);
            job.reject(reason);
        }
        pending.clear();
    }
    function ensureWorker() {
        if (worker) return worker;
        worker = new Worker(page.dataset.spellingWorkerUrl);
        worker.onmessage = event => {
            const {id, ok, result, error} = event.data || {};
            const job = pending.get(id);
            if (!job) return;
            pending.delete(id);
            clearTimeout(job.timer);
            job.signal?.removeEventListener("abort", job.abort);
            if (ok) job.resolve(result);
            else job.reject(new Error(error || "Не удалось проверить текст."));
        };
        worker.onerror = () => stop(new Error("Словарь не загрузился. Повторите проверку."));
        return worker;
    }
    function send(type, payload, signal, timeout) {
        if (signal?.aborted) return Promise.reject(new Error("Проверка отменена."));
        return new Promise((resolve, reject) => {
            let current;
            try { current = ensureWorker(); }
            catch (error) { reject(new Error("Не удалось запустить словарь в браузере.")); return; }
            const id = ++sequence;
            const abort = () => {
                if (type === "check") { stop(new Error("Проверка отменена.")); return; }
                const job = pending.get(id);
                if (!job) return;
                pending.delete(id);
                clearTimeout(job.timer);
                signal.removeEventListener("abort", abort);
                job.reject(new Error("Подбор вариантов отменён."));
            };
            const timer = setTimeout(() => stop(new Error("Словарь отвечает слишком долго. Повторите попытку.")), timeout);
            pending.set(id, {resolve, reject, timer, signal, abort});
            signal?.addEventListener("abort", abort, {once: true});
            try { current.postMessage({id, type, ...payload}); }
            catch (error) { stop(new Error("Не удалось передать текст словарю.")); }
        });
    }
    const engine = {
        check(text, {signal} = {}) { return send("check", {text}, signal, 30000); },
        suggest(issue, {signal} = {}) {
            return send("suggest", {language: issue.language, word: issue.value}, signal, 10000);
        },
    };
    globalThis.QASpellingUI.mount(panel, engine);
})();
