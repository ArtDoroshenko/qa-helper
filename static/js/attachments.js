(() => {
    const form = document.querySelector("[data-attachment-upload]");
    if (!form) return;
    const input = form.querySelector('input[type="file"]');
    const button = form.querySelector("[data-attachment-submit]");
    const status = form.querySelector("[data-attachment-status]");
    const toggle = document.querySelector("[data-attachment-toggle]");
    const cancel = form.querySelector("[data-attachment-cancel]");
    const show = (open) => {
        form.hidden = !open;
        toggle?.setAttribute("aria-expanded", String(open));
    };
    toggle?.addEventListener("click", () => { show(form.hidden); if (!form.hidden) input.focus(); });
    cancel?.addEventListener("click", () => { input.value = ""; show(false); update(); toggle?.focus(); });
    const update = () => {
        const file = input.files[0];
        const tooLarge = Boolean(file && file.size > 2 * 1024 * 1024);
        button.disabled = !file || tooLarge;
        status.classList.toggle("danger-text", tooLarge);
        status.textContent = !file ? "Выберите файл для этой заметки."
            : tooLarge ? "Файл больше 2 МиБ. Выберите другой."
            : file.name + " · " + (file.size / 1024).toLocaleString("ru-RU", {maximumFractionDigits: 1}) + " КБ";
    };
    input.addEventListener("change", update);
    form.addEventListener("submit", (event) => {
        update();
        if (button.disabled) event.preventDefault();
    });
    update();
})();
