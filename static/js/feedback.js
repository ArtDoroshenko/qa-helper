(() => {
    "use strict";

    const dialog = document.getElementById("feedback-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return;
    const form = dialog.querySelector("form");
    const kind = form.elements.namedItem("kind");
    const message = form.elements.namedItem("message");
    const send = dialog.querySelector("[data-feedback-send]");
    const close = dialog.querySelector("[data-feedback-close]");
    const status = dialog.querySelector("[data-feedback-status]");
    const triggers = document.querySelectorAll("[data-feedback-open]");
    const fallback = "Не удалось отправить сообщение. Попробуйте ещё раз.";
    let opener;
    let pending = false;

    function showStatus(text, error = false) {
        status.textContent = text;
        status.classList.toggle("is-error", error);
    }

    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
        if (!dialog.open) opener?.focus();
    });
    form.addEventListener("input", () => {
        if (!pending) showStatus("");
    });

    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending) return;
        pending = true;
        try {
            const data = new URLSearchParams(new FormData(form));
            send.disabled = true;
            kind.disabled = true;
            message.disabled = true;
            showStatus("Отправляем…");
            const response = await fetch(form.action, {
                method: "POST", mode: "same-origin", credentials: "same-origin",
                referrerPolicy: "same-origin", body: data,
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || result?.ok !== true) {
                showStatus(result?.error || fallback, true);
                return;
            }
            form.reset();
            showStatus("Сообщение отправлено.");
        } catch {
            showStatus(fallback, true);
        } finally {
            pending = false;
            send.disabled = false;
            kind.disabled = false;
            message.disabled = false;
        }
    });

    for (const trigger of triggers) {
        trigger.addEventListener("click", () => {
            if (dialog.open) return;
            opener = trigger;
            dialog.showModal();
            if (!kind.disabled) kind.focus();
            else close.focus();
        });
        trigger.disabled = false;
    }
    send.disabled = false;
})();
