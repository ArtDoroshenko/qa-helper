const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const core = require("../static/js/bug_report_core.js");

const report = {
    title: "Корзина не открывается",
    steps: "Открыть каталог\nНажать «Корзина»",
    actual: "Показывается пустая страница.",
    expected: "Отображается список товаров.",
};

test("suggested title uses only the three explicit fields and trims their edges", () => {
    const draft = {module: " Корзина ", action: " Нажать «Купить» ", symptom: " Список пуст ",
        title: "Мой заголовок", expected: "Нерелевантный текст"};
    assert.deepEqual(core.suggestTitle(draft), {title: "[Корзина] Нажать «Купить»: Список пуст", errors: {}});
    assert.deepEqual(core.suggestTitle({...draft, symptom: " \t "}), {errors: {symptom: "Заполните поле."}});
    assert.match(core.suggestTitle({...draft, module: "я".repeat(61)}).errors.module, /60 символов/);
});

test("report requires the four fields and limits text, step count and step size", () => {
    assert.deepEqual(Object.keys(core.buildReport({title: " ", steps: "\r\n\t ", actual: "", expected: ""}).errors),
        ["title", "steps", "actual", "expected"]);
    assert.equal(core.buildReport({...report, title: "🙂".repeat(240)}).errors.title, undefined);
    assert.match(core.buildReport({...report, title: "🙂".repeat(241)}).errors.title, /240 символов/);
    assert.match(core.buildReport({...report, steps: Array(51).fill("Проверить").join("\n")}).errors.steps, /50 шагов/);
    assert.match(core.buildReport({...report, steps: "я".repeat(501)}).errors.steps, /500 символов/);
    assert.match(core.buildReport({...report, actual: "я".repeat(4001)}).errors.actual, /4000 символов/);
    assert.match(core.buildReport({...report, expected: "Новая\u0000строка"}).errors.expected, /управляющие/);
});

test("Markdown keeps Cyrillic and line breaks, numbers non-empty steps and includes optional sections", () => {
    const actual = "  Пустая страница\r\n\r\nПоказано уведомление\r\n";
    const {markdown, errors} = core.buildReport({
        ...report, steps: "  Открыть каталог\r\n\r\n \t\n Нажать «Корзина»  ",
        actual, environment: "Firefox\nВерсия 3.2", issue: " https://tracker.example/QA-17 ",
    });
    assert.deepEqual(errors, {});
    assert.equal(markdown, [
        "# ` Корзина не открывается `",
        "",
        "## Шаги воспроизведения",
        "",
        "1. ` Открыть каталог `",
        "2. ` Нажать «Корзина» `",
        "",
        "## Фактический результат",
        "",
        "~~~text",
        "  Пустая страница",
        "",
        "Показано уведомление",
        "~~~",
        "",
        "## Ожидаемый результат",
        "",
        "~~~text",
        "Отображается список товаров.",
        "~~~",
        "",
        "## Окружение",
        "",
        "~~~text",
        "Firefox",
        "Версия 3.2",
        "~~~",
        "",
        "## Ссылка на задачу",
        "",
        "` https://tracker.example/QA-17 `",
        "",
    ].join("\n"));
    assert.doesNotMatch(core.buildReport({...report, environment: "  "}).markdown, /Окружение|Ссылка на задачу/);
});

test("user Markdown syntax stays literal and the issue field accepts only plain HTTP(S) addresses", () => {
    const {markdown} = core.buildReport({
        ...report,
        title: "``код`` и [пример](https://example.test)",
        steps: "Проверить <strong>надпись</strong>",
        actual: "~~~\n## Текст ответа\n<strong>пример</strong>",
        issue: "https://tracker.example/QA-17",
    });
    assert.ok(markdown.startsWith("# ``` ``код`` и [пример](https://example.test) ```\n"));
    assert.ok(markdown.includes("1. ` Проверить <strong>надпись</strong> `\n"));
    assert.ok(markdown.includes("~~~~text\n~~~\n## Текст ответа\n<strong>пример</strong>\n~~~~\n"));
    assert.ok(markdown.endsWith("` https://tracker.example/QA-17 `\n"));
    for (const issue of ["file:///example.txt", "javascript:example", "https://name:secret@tracker.example", "tracker.example/17"]) {
        const rejected = core.buildReport({...report, issue});
        assert.match(rejected.errors.issue, /полный адрес/);
        assert.equal(rejected.markdown, undefined);
    }
});

class Element {
    constructor() {
        this.value = "";
        this.hidden = true;
        this.dataset = {};
        this.listeners = {};
        this.attributes = {};
        this.classList = {toggle() {}};
    }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    fire(event) { return this.listeners[event]?.(); }
    focus() { this.focused = true; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
}

function uiHarness() {
    const names = ["module", "action", "symptom", "title", "steps", "actual", "expected", "environment", "issue"];
    const fields = Object.fromEntries(names.map(name => [name, Object.assign(new Element(), {dataset: {brField: name}})]));
    const errors = Object.fromEntries(names.map(name => [name, Object.assign(new Element(), {dataset: {brError: name}})]));
    const controls = Object.fromEntries(["suggest", "build", "reset", "preview", "status", "copy", "download"]
        .map(name => [name, new Element()]));
    controls.copy.disabled = true;
    controls.download.disabled = true;
    const root = {
        querySelector(selector) { return controls[selector.slice(9, -1)]; },
        querySelectorAll(selector) { return Object.values(selector === "[data-br-field]" ? fields : errors); },
    };
    const files = new Map();
    const downloads = [], copied = [], revoked = [], timers = [];
    const document = {
        querySelector: () => root,
        body: {append() {}},
        createElement: () => ({
            click() { downloads.push({name: this.download, blob: files.get(this.href)}); },
            remove() {},
        }),
    };
    const clipboard = {async writeText(value) { copied.push(value); }};
    const window = Object.assign(new Element(), {setTimeout(callback) { timers.push(callback); }});
    const URL = {
        createObjectURL(blob) { const url = "blob:" + (files.size + 1); files.set(url, blob); return url; },
        revokeObjectURL(url) { revoked.push(url); },
    };
    vm.runInNewContext(readFileSync(join(__dirname, "../static/js/bug_report.js"), "utf8"), {
        QABugReport: core, document, navigator: {clipboard}, window, URL, Blob,
    });
    function enter(name, value) {
        fields[name].value = value;
        fields[name].fire("input");
    }
    return {fields, errors, controls, enter, downloads, copied, revoked, timers, clipboard, window};
}

test("only an explicit suggestion replaces the title and missing fields are accessible", () => {
    const h = uiHarness();
    h.controls.build.fire("click");
    assert.equal(h.fields.title.attributes["aria-invalid"], "true");
    assert.equal(h.fields.title.focused, true);
    assert.equal(h.errors.steps.hidden, false);
    assert.equal(h.controls.download.disabled, true);

    h.enter("title", "Ручная редакция");
    h.enter("module", "Корзина");
    h.enter("action", "Удалить товар");
    h.enter("symptom", "Позиция остаётся");
    assert.equal(h.fields.title.value, "Ручная редакция");
    assert.equal(h.fields.title.attributes["aria-invalid"], undefined);
    h.controls.suggest.fire("click");
    assert.equal(h.fields.title.value, "[Корзина] Удалить товар: Позиция остаётся");
    h.enter("symptom", "Другая формулировка");
    assert.equal(h.fields.title.value, "[Корзина] Удалить товар: Позиция остаётся");
});

test("copy and UTF-8 download use the current report and edits and reset disable stale exports", async () => {
    const h = uiHarness();
    for (const [name, value] of Object.entries(report)) h.enter(name, value);
    h.controls.build.fire("click");
    const current = h.controls.preview.value;
    assert.match(current, /Корзина не открывается/);
    assert.equal(h.controls.copy.disabled, false);
    await h.controls.copy.fire("click");
    assert.deepEqual(h.copied, [current]);
    h.controls.download.fire("click");
    assert.equal(h.downloads[0].name, "bug-report.md");
    assert.equal(h.downloads[0].blob.type, "text/markdown;charset=utf-8");
    assert.equal(await h.downloads[0].blob.text(), current);
    h.timers.pop()();
    assert.deepEqual(h.revoked, ["blob:1"]);

    let finish;
    h.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
    const copying = h.controls.copy.fire("click");
    h.enter("actual", "Теперь другой результат");
    assert.equal(h.controls.preview.value, "");
    assert.equal(h.controls.copy.disabled, true);
    assert.equal(h.controls.download.disabled, true);
    h.controls.download.fire("click");
    assert.equal(h.downloads.length, 1);
    finish();
    await copying;
    assert.match(h.controls.status.textContent, /Соберите отчёт заново/);

    h.controls.build.fire("click");
    assert.match(h.controls.preview.value, /другой результат/);
    h.controls.reset.fire("click");
    assert.ok(Object.values(h.fields).every(field => field.value === ""));
    assert.equal(h.controls.preview.value, "");
    assert.equal(h.controls.download.disabled, true);
});
