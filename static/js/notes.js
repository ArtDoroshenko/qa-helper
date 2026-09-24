(() => {
    const form = document.querySelector("[data-note-autosave]");
    const status = document.querySelector("[data-save-status]");
    const stateLabel = status?.querySelector("[data-save-state]");
    const lastSaved = status?.querySelector("[data-last-saved]");
    if (!form || !status || !stateLabel || !lastSaved) return;
    const autosaveDelay = Number(form.dataset.autosaveDelay) || 1500;

    let revision = 0;
    let savedRevision = 0;
    let timer;
    let saving = false;

    const setStatus = (state) => {
        status.className = `save-status ${state}`;
        stateLabel.textContent = status.dataset[`${state}Text`];
    };

    const queueSave = (delay = autosaveDelay) => {
        window.clearTimeout(timer);
        setStatus("saving");
        timer = window.setTimeout(save, delay);
    };

    const save = async () => {
        if (saving) return;
        saving = true;
        const savingRevision = revision;
        let retryLatest = false;
        setStatus("saving");

        try {
            const response = await fetch(form.action, {
                method: "POST",
                body: new FormData(form),
                headers: {"X-Requested-With": "XMLHttpRequest"},
            });
            const payload = await response.json();
            if (!response.ok) throw new Error("Save failed");
            lastSaved.textContent = payload.saved_at;
            lastSaved.dateTime = payload.updated_at;
            savedRevision = savingRevision;
            retryLatest = revision > savingRevision;
            if (!retryLatest) setStatus("saved");
        } catch (error) {
            retryLatest = revision > savingRevision;
            if (!retryLatest) setStatus("error");
        } finally {
            saving = false;
            if (retryLatest) queueSave(0);
        }
    };

    form.addEventListener("input", () => {
        revision += 1;
        queueSave();
    });

    window.addEventListener("beforeunload", (event) => {
        if (revision <= savedRevision) return;
        event.preventDefault();
        event.returnValue = "";
    });
})();
