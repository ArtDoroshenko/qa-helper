(() => {
    "use strict";

    const suggestionFields = Object.freeze({
        module: {max: 60, singleLine: true, required: true},
        action: {max: 70, singleLine: true, required: true},
        symptom: {max: 100, singleLine: true, required: true},
    });
    const reportFields = Object.freeze({
        title: {max: 240, singleLine: true, required: true},
        steps: {max: 8000, required: true},
        actual: {max: 4000, required: true},
        expected: {max: 4000, required: true},
        environment: {max: 2000},
        issue: {max: 2048, singleLine: true},
    });
    const maxSteps = 50;
    const maxStepLength = 500;
    const disallowedControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

    function tooLong(text, max) {
        let length = 0;
        for (const character of text) {
            if (++length > max) return true;
        }
        return false;
    }

    function readFields(raw, rules) {
        const values = {};
        const errors = {};
        for (const [name, rule] of Object.entries(rules)) {
            const text = (raw[name] ?? "").replace(/\r\n?/g, "\n");
            const trimmed = text.trim();
            const value = rule.singleLine ? trimmed : text;
            values[name] = trimmed ? value : "";
            if (disallowedControls.test(text)) {
                errors[name] = "Удалите управляющие символы.";
            } else if (rule.required && !trimmed) {
                errors[name] = "Заполните поле.";
            } else if (rule.singleLine && value.includes("\n")) {
                errors[name] = "Используйте одну строку.";
            } else if (tooLong(value, rule.max)) {
                errors[name] = "Не больше " + rule.max + " символов.";
            }
        }
        return {values, errors};
    }

    function suggestTitle(raw) {
        const {values, errors} = readFields(raw, suggestionFields);
        if (Object.keys(errors).length) return {errors};
        return {title: "[" + values.module + "] " + values.action + ": " + values.symptom, errors};
    }

    function literalInline(text) {
        let length = 1;
        for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
        const fence = "`".repeat(length);
        return fence + " " + text + " " + fence;
    }

    function literalBlock(text) {
        let length = 3;
        for (const match of text.matchAll(/~+/g)) length = Math.max(length, match[0].length + 1);
        const fence = "~".repeat(length);
        return fence + "text\n" + text + (text.endsWith("\n") ? "" : "\n") + fence;
    }

    function isIssueUrl(value) {
        if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return false;
        try {
            const url = new URL(value);
            return !!url.hostname && !url.username && !url.password;
        } catch {
            return false;
        }
    }

    function buildReport(raw) {
        const {values, errors} = readFields(raw, reportFields);
        const steps = errors.steps ? [] : values.steps.split("\n").map(line => line.trim()).filter(Boolean);
        if (steps.length > maxSteps) {
            errors.steps = "Не больше " + maxSteps + " шагов.";
        } else if (steps.some(step => tooLong(step, maxStepLength))) {
            errors.steps = "Не больше " + maxStepLength + " символов в одном шаге.";
        }
        if (!errors.issue && values.issue && !isIssueUrl(values.issue)) {
            errors.issue = "Укажите полный адрес http:// или https:// без логина и пароля.";
        }
        if (Object.keys(errors).length) return {errors};

        // Literal Markdown keeps user text out of HTML, link, and block syntax.
        const sections = [
            "# " + literalInline(values.title),
            "## Шаги воспроизведения\n\n" + steps.map((step, i) => (i + 1) + ". " + literalInline(step)).join("\n"),
            "## Фактический результат\n\n" + literalBlock(values.actual),
            "## Ожидаемый результат\n\n" + literalBlock(values.expected),
        ];
        if (values.environment) sections.push("## Окружение\n\n" + literalBlock(values.environment));
        if (values.issue) sections.push("## Ссылка на задачу\n\n" + literalInline(values.issue));
        return {markdown: sections.join("\n\n") + "\n", errors};
    }

    const api = {suggestTitle, buildReport};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else globalThis.QABugReport = api;
})();
