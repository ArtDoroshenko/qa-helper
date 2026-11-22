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
}

function harness() {
    const root = new Element(), generator = new Element(), checks = new Element();
    const files = new Element(), limit = new Element();
    for (const name of ["error", "table", "code", "pagination", "page", "prev", "next", "copy",
        "download", "generate", "build-checks", "new", "title", "meta", "status",
        "password-length", "length", "range", "phone"]) {
        root.nodes[`[data-td-${name}]`] = new Element();
    }
    root.nodes["[data-td-generator]"] = generator;
    root.nodes["[data-td-checks]"] = checks;
    root.nodes['[data-td-generator] input, [data-td-generator] select, [data-td-checks] input, [data-td-checks] select'] = [];
    generator.action = "/tools/test-data/generate/";
    checks.action = "/tools/test-data/checks/";
    const field = new Element(); field.value = "name"; field.checked = true;
    root.nodes['[name="fields"]:checked'] = [field];
    for (const [name, value] of [["count", "2"], ["locale", "ru_RU"], ["password_length", "12"]]) {
        generator.nodes[`[name="${name}"]`] = new Element();
        generator.nodes[`[name="${name}"]`].value = value;
    }
    generator.nodes['[name="fields"][value="password"]'] = {checked: false};
    generator.nodes['[name="csrfmiddlewaretoken"]'] = {value: "token"};
    for (const name of ["type", "required", "trim", "phone_locale", "min_length", "max_length", "min", "max"])
        checks.nodes[`[name="${name}"]`] = new Element();
    checks.nodes["[data-td-check-type]"] = checks.nodes['[name="type"]'];
    checks.nodes['[name="type"]'].value = "text";
    checks.reset = () => { checks.nodes['[name="type"]'].value = "text"; };
    generator.reset = () => { generator.nodes['[name="count"]'].value = "5"; };
    const formats = ["table", "json", "csv"].map(name => {
        const item = new Element(); item.dataset.tdFormat = name; return item;
    });
    root.nodes["[data-td-format]"] = formats;
    const tabs = ["generator", "checks", "files"].map(name => {
        const item = new Element(); item.dataset.tdTab = name; return item;
    });
    const document = {
        querySelector(selector) { return ({"[data-td-tool]": root, "[data-td-files]": files,
            "[data-td-limit]": limit})[selector] || null; },
        querySelectorAll(selector) { return selector === "[data-td-tab]" ? tabs : []; },
        getElementById() { return {textContent: JSON.stringify([["Личные данные", [["name", "ФИО"]]]])}; },
        createElement() { return new Element(); },
    };
    const requests = [], copied = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "static/js/test_data_public.js"), "utf8"), {
        document, navigator: {clipboard: {writeText: async value => copied.push(value)}},
        fetch: async (url, options) => {
            requests.push({url, options});
            if (url === checks.action) {
                return {ok: true, json: async () => ({ok: true, rows: [{value: "2", expected: "Допустить"}]})};
            }
            return {ok: true, json: async () => ({ok: true, settings: {fields: ["name"]},
                rows: [{name: "=1+1"}, {name: "QA"}], size_bytes: 40})};
        },
    });
    return {root, generator, checks, files, tabs, formats, requests, copied};
}

test("public generator keeps result in page memory and exports CSV without save requests", async () => {
    const h = harness();
    await h.generator.fire("submit");
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, "/tools/test-data/generate/");
    assert.equal(JSON.parse(h.requests[0].options.body).settings.count, "2");
    await h.formats[2].fire("click");
    await h.root.querySelector("[data-td-copy]").fire("click");
    assert.match(h.copied[0], /"=1\+1"/);
    await h.tabs[2].fire("click");
    assert.equal(h.files.hidden, false);
    await h.tabs[0].fire("click");
    assert.equal(h.root.hidden, false);
    assert.equal(h.requests.length, 1);
});

test("starting new checks clears only the active mode and its export", async () => {
    const h = harness();
    const control = name => h.root.querySelector("[data-td-" + name + "]");
    await h.generator.fire("submit");
    await h.tabs[1].fire("click");
    h.checks.querySelector('[name="type"]').value = "number";
    await h.checks.fire("submit");
    assert.equal(h.requests.at(-1).url, "/tools/test-data/checks/");
    assert.equal(control("new").textContent, "Новые проверки");
    assert.equal(control("copy").disabled, false);
    await control("new").fire("click");
    assert.equal(h.checks.querySelector('[name="type"]').value, "text");
    assert.equal(control("copy").disabled, true);
    assert.equal(control("download").disabled, true);
    assert.equal(control("table").children.length, 0);
    await h.tabs[0].fire("click");
    assert.equal(control("copy").disabled, false);
    assert.equal(h.generator.querySelector('[name="count"]').value, "2");
    assert.equal(h.requests.length, 2);
});
