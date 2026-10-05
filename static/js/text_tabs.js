(() => {
    "use strict";
    const root = document.querySelector("[data-text-tool]");
    if (!root) return;
    const tabs = [...root.querySelectorAll("[data-text-tab]")];
    const panels = [...root.querySelectorAll("[data-text-panel]")];
    if (!tabs.length || tabs.length !== panels.length) return;
    const names = tabs.map(tab => tab.dataset.textTab);
    function select(name) {
        if (!names.includes(name)) return;
        for (const tab of tabs) {
            const active = tab.dataset.textTab === name;
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
        }
        for (const panel of panels) panel.hidden = panel.dataset.textPanel !== name;
        try { localStorage.setItem("qa-helper-text-tab", name); } catch (error) {}
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => select(tab.dataset.textTab));
        tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[target].focus(); select(tabs[target].dataset.textTab);
        });
    });
    let saved = null;
    try { saved = localStorage.getItem("qa-helper-text-tab"); } catch (error) {}
    select(names.includes(saved) ? saved : "spelling");
})();
