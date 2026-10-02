const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

class Element {
    constructor() {
        this.nodes = {}; this.handlers = {}; this.children = [];
        this.dataset = {}; this.value = ""; this.textContent = "";
        this.hidden = false; this.disabled = false; this.checked = false;
        this.classList = {toggle() {}};
    }
    querySelector(selector) { return this.nodes[selector]; }
    querySelectorAll(selector) { return this.nodes[selector] || []; }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) {
        for (const handler of this.handlers[name] || []) await handler({target: this, preventDefault() {}});
    }
    setAttribute() {}
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    focus() {}
}

function harness() {
    const root = new Element(), generator = new Element(), checks = new Element();
    const selectors = ["error", "table", "code", "pagination", "page", "prev", "next", "copy",
        "download", "save-actions", "delete", "save-new", "open-save", "generate", "build-checks",
        "origin", "meta", "status", "save-panel", "save-cancel", "new", "delete-form",
        "password-length", "length", "range", "phone"];
    const elements = Object.fromEntries(selectors.map(name => [name, new Element()]));
    for (const [name, element] of Object.entries(elements)) root.nodes[`[data-td-${name}]`] = element;
    root.nodes["[data-td-generator]"] = generator;
    root.nodes["[data-td-checks]"] = checks;
    root.dataset = {generateUrl: "generate", checksUrl: "checks", saveUrl: "save", deleteTemplate: "/delete/0/"};
    const fields = ["name", "phone"].map(value => {
        const input = new Element(); input.value = value; input.checked = true; return input;
    });
    root.nodes['[name="fields"]'] = fields;
    root.nodes['[name="fields"]:checked'] = fields;
    root.nodes['[data-td-generator] input, [data-td-generator] select, [data-td-checks] input, [data-td-checks] select'] = [];
    for (const name of ["count", "locale", "password_length"]) generator.nodes[`[name="${name}"]`] = new Element();
    generator.nodes['[name="fields"][value="password"]'] = {checked: false};
    generator.nodes['[name="csrfmiddlewaretoken"]'] = {value: "token"};
    for (const name of ["type", "required", "trim", "min_length", "max_length", "min", "max", "phone_locale"])
        checks.nodes[`[name="${name}"]`] = new Element();
    checks.nodes["[data-td-check-type]"] = checks.nodes['[name="type"]'];
    elements["save-panel"].nodes['[name="title"]'] = new Element();
    const formats = ["table", "json", "csv"].map(value => {
        const button = new Element(); button.dataset.tdFormat = value; return button;
    });
    root.nodes["[data-td-format]"] = formats;
    const tabs = ["generator", "checks"].map(value => {
        const button = new Element(); button.dataset.tdTab = value; return button;
    });
    const rows = Array.from({length: 12}, (_, index) => ({
        name: index === 0 ? "=1+1" : `Name ${index}`,
        phone: "+79991234567",
    }));
    const initial = {settings: {fields: ["name", "phone"], count: 12, locale: "ru_RU", password_length: 12}, rows};
    const data = {"td-initial-data": initial, "td-field-groups": [["Личные данные", [["name", "ФИО"], ["phone", "Телефон"]]]]};
    const document = {
        querySelector: selector => selector === "[data-td-tool]" ? root : null,
        querySelectorAll: selector => selector === "[data-td-tab]" ? tabs : [],
        getElementById: id => ({textContent: JSON.stringify(data[id])}),
        createElement: () => new Element(),
    };
    const requests = [], copies = [], queue = [];
    const quota = new Element(); quota.textContent = "0 / 10";
    document.querySelector = selector => ({"[data-td-tool]": root, "[data-td-quota]": quota})[selector] || null;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "test_data.js"), "utf8"), {
        document, navigator: {clipboard: {writeText: async value => copies.push(value)}},
        fetch: (...args) => { requests.push(args); return queue.shift() || Promise.reject(new Error("Unexpected fetch")); },
    });
    return {elements, formats, requests, copies, rows, queue, quota};
}

test("format switches keep the same twelve rows without regenerating and CSV preserves raw values", async () => {
    const {elements, formats, requests, copies, rows} = harness();
    const table = elements.table.children[0];
    assert.equal(table.children[1].children.length, 10);
    await formats[2].fire("click");
    assert.equal(requests.length, 0);
    assert.match(elements.code.textContent, /"=1\+1","\+79991234567"/);
    assert.match(elements.code.textContent, /"Name 11","\+79991234567"/);
    await elements.copy.fire("click");
    assert.equal(copies[0], elements.code.textContent);
    await formats[1].fire("click");
    assert.equal(JSON.parse(elements.code.textContent).length, rows.length);
    assert.equal(requests.length, 0);
});

test("new dataset cannot clear a result while its save request is pending", async () => {
    const h = harness();
    await h.elements["open-save"].fire("click");
    h.elements["save-panel"].nodes['[name="title"]'].value = "Saved";
    let finish;
    h.queue.push(new Promise(resolve => { finish = resolve; }));
    const saving = h.elements["save-panel"].fire("submit");
    assert.equal(h.elements.new.disabled, true);
    await h.elements.new.fire("click");
    finish({ok: true, json: async () => ({ok: true, id: 7, title: "Saved"})});
    await saving;
    assert.equal(h.requests.length, 1);
    assert.equal(h.elements.error.hidden, true);
    assert.equal(h.elements.origin.textContent, "Сохранённый набор: Saved");
    assert.equal(h.quota.textContent, "1 / 10");
});
