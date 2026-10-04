const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {compare} = require("../static/js/json_compare_worker.js");

class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false;
        this.disabled = false; this.dataset = {}; this.children = [];
        this.handlers = {}; this.nodes = {}; this.attributes = {};
        this.classList = {toggle() {}};
    }
    addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
    async fire(name, extra = {}) {
        for (const callback of this.handlers[name] || []) await callback({target: this, preventDefault() {}, ...extra});
    }
    querySelector(selector) { return this.nodes[selector]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    click() { this.clicked = true; }
}

function harness() {
    const panel = new Element(), analyzer = new Element(), materialLink = new Element();
    panel.dataset.workerUrl = "/static/js/json_compare_worker.js";
    panel.hidden = true;
    const selectors = ["run", "status", "report", "summary", "counts", "list", "page", "prev", "next", "copy", "download"];
    const nodes = Object.fromEntries(selectors.map(name => [name, new Element()]));
    for (const [name, element] of Object.entries(nodes)) panel.nodes[`[data-compare-${name}]`] = element;
    nodes.report.hidden = true;
    const input = {left: new Element(), right: new Element()};
    const side = {left: new Element(), right: new Element()};
    const files = {left: new Element(), right: new Element()};
    for (const name of ["left", "right"]) {
        panel.nodes[`[data-compare-input="${name}"]`] = input[name];
        panel.nodes[`[data-compare-side-status="${name}"]`] = side[name];
        panel.nodes[`[data-compare-file="${name}"]`] = files[name];
    }
    const tabs = [new Element(), new Element()];
    tabs[0].dataset.jsonLabTab = "analyzer";
    tabs[1].dataset.jsonLabTab = "compare";
    const links = [], workers = [];
    class Worker {
        constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
        postMessage(payload) { this.payload = payload; }
        terminate() { this.terminated = true; }
        respond(data) { this.onmessage({data: {id: this.payload.id, ok: true, result: data}}); }
        fail(error) { this.onmessage({data: {id: this.payload.id, ok: false, error}}); }
    }
    const clipboard = {text: null, async writeText(value) { this.text = value; }};
    const doc = {
        querySelector(selector) { return {"[data-json-compare]": panel, "[data-json-analyzer]": analyzer,
            "[data-json-analyzer-link]": materialLink}[selector]; },
        querySelectorAll() { return tabs; },
        createElement(tag) { const element = new Element(); if (tag === "a") links.push(element); return element; },
    };
    const urls = [], timers = new Map();
    let timerId = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "static/js/json_compare.js"), "utf8"), {
        document: doc, Worker, TextDecoder, TextEncoder, Blob,
        navigator: {clipboard},
        URL: {createObjectURL(blob) { urls.push(blob); return "blob:report"; }, revokeObjectURL() {}},
        window: {
            setTimeout(callback, ms) { const id = ++timerId; timers.set(id, {callback, ms}); return id; },
            clearTimeout(id) { timers.delete(id); },
        },
    });
    const fireTimer = (id) => { const item = timers.get(id); timers.delete(id); item.callback(); };
    return {...nodes, panel, analyzer, materialLink, input, side, files, tabs, workers, clipboard, links, urls, timers, fireTimer};
}

test("tabs preserve analyzer state; comparison paginates only the view and exports all changes", async () => {
    const h = harness();
    h.input.left.value = "{}";
    h.input.right.value = `{${Array.from({length: 12}, (_, i) => `"k${i}":${i}`).join(",")}}`;
    await h.tabs[1].fire("click");
    assert.equal(h.analyzer.hidden, true);
    assert.equal(h.panel.hidden, false);
    assert.equal(h.materialLink.hidden, true);
    await h.run.fire("click");
    assert.equal(h.run.disabled, true);
    assert.equal([...h.timers.values()][0].ms, 10000);
    const job = h.workers[0];
    assert.equal(job.url, "/static/js/json_compare_worker.js");
    job.respond(compare(job.payload.left, job.payload.right));
    assert.equal(h.timers.size, 0);
    assert.equal(h.report.hidden, false);
    assert.equal(h.list.children.length, 8);
    assert.equal(h.page.textContent, "1 / 2");
    await h.next.fire("click");
    assert.equal(h.list.children.length, 4);
    await h.copy.fire("click");
    assert.equal(JSON.parse(h.clipboard.text).changes.length, 12);
    await h.download.fire("click");
    assert.equal(JSON.parse(await h.urls[0].text()).changes.length, 12);
    assert.equal(h.links[0].download, "json-comparison.json");
    await h.tabs[0].fire("click");
    assert.equal(h.analyzer.hidden, false);
    assert.equal(h.materialLink.hidden, false);
    assert.equal(h.input.right.value, job.payload.right);
});

test("editing cancels a worker and stale completion cannot restore the report", async () => {
    const h = harness();
    h.input.left.value = "{}";
    h.input.right.value = "{}";
    await h.run.fire("click");
    const old = h.workers[0];
    h.input.right.value = '{"changed":1}';
    await h.input.right.fire("input");
    assert.equal(old.terminated, true);
    assert.equal(h.timers.size, 0);
    old.respond(compare("{}", "{}"));
    assert.equal(h.report.hidden, true);
    assert.equal(h.copy.disabled, true);
    await h.run.fire("click");
    h.workers[1].respond(compare("{}", '{"changed":1}'));
    assert.equal(h.report.hidden, false);
    h.input.left.value = '{"now":true}';
    await h.input.left.fire("input");
    assert.equal(h.report.hidden, true);
    assert.equal(h.download.disabled, true);
});

test("side errors show position and an outdated file read does not overwrite typed text", async () => {
    const h = harness();
    h.input.left.value = "{}";
    h.input.right.value = "{}";
    await h.run.fire("click");
    h.workers[0].fail({side: "right", message: "Повтор ключа", line: 2, column: 9});
    assert.equal(h.timers.size, 0);
    assert.match(h.status.textContent, /Изменённый JSON.*Строка 2, столбец 9/);
    assert.equal(h.report.hidden, true);

    let resolve;
    const pending = new Promise(done => { resolve = done; });
    h.files.left.files = [{name: "old.json", size: 2, arrayBuffer: () => pending}];
    const reading = h.files.left.fire("change");
    h.input.left.value = '{"typed":true}';
    await h.input.left.fire("input");
    resolve(new TextEncoder().encode("{}").buffer);
    await reading;
    assert.equal(h.input.left.value, '{"typed":true}');
    assert.equal(h.report.hidden, true);
});

test("ten-second timeout terminates work, rejects a late response and allows retry", async () => {
    const h = harness();
    h.input.left.value = "{}";
    h.input.right.value = '{"x":1}';
    await h.run.fire("click");
    const old = h.workers[0];
    const [id, timer] = [...h.timers][0];
    assert.equal(timer.ms, 10000);
    h.fireTimer(id);
    assert.equal(old.terminated, true);
    assert.equal(h.run.disabled, false);
    assert.equal(h.report.hidden, true);
    assert.equal(h.copy.disabled, true);
    assert.match(h.status.textContent, /10 секунд.*не сформирован/);
    old.respond(compare("{}", '{"x":1}'));
    assert.equal(h.report.hidden, true);
    await h.run.fire("click");
    h.workers[1].respond(compare("{}", '{"x":1}'));
    assert.equal(h.report.hidden, false);
    assert.equal(h.timers.size, 0);
});

test("compare editors share analyzer geometry and have one responsive divider", () => {
    const css = fs.readFileSync(path.join(__dirname, "../static/css/app.css"), "utf8");
    const template = fs.readFileSync(path.join(__dirname, "../templates/materials/json_tool.html"), "utf8");
    assert.equal((template.match(/class="json-grid(?: json-compare-grid)?"/g) || []).length, 2);
    assert.equal((template.match(/class="json-pane(?: json-output-pane)?"/g) || []).length, 4);
    assert.match(css, /\.json-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\.json-pane\s*\{[^}]*grid-template-rows:\s*58px var\(--qa-code-min\) 40px/);
    assert.doesNotMatch(css, /\.json-compare-grid \.json-pane\s*\{[^}]*grid-template-rows:/);
    const dividerRules = [...css.matchAll(/\.json-compare-grid \.json-pane \+ \.json-pane\s*\{([^}]+)\}/g)]
        .map(match => match[1]);
    assert.equal(dividerRules.length, 2);
    assert.match(dividerRules[0], /border-left:\s*1px solid var\(--line\)/);
    assert.match(dividerRules[1], /border-top:\s*1px solid var\(--line\)/);
    assert.match(dividerRules[1], /border-left:\s*0/);
    assert.match(css, /\.json-compare-grid \.base64-file-label\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/);
    assert.ok(/\.json-toolbar\s*\{[^}]*min-height:\s*var\(--json-lab-intro-height\);\s*margin:\s*0 0 var\(--qa-gap\)/.test(css),
        "analyzer controls start without an extra top margin and reserve the shared intro height");
    assert.ok(/\[data-json-compare\] > \.lead\s*\{[^}]*min-height:\s*var\(--json-lab-intro-height\);\s*margin:\s*0 0 var\(--qa-gap\)/.test(css),
        "compare description reserves the same intro height while retaining its text");
    assert.ok(/\.json-compare-grid\s*\{\s*margin-top:\s*0;\s*\}/.test(css),
        "compare editor has no extra gap after the shared intro row");
    const narrowStart = css.indexOf("@media (max-width: 850px) {");
    const narrowEnd = css.indexOf("@media (pointer: coarse)", narrowStart);
    const narrow = css.slice(narrowStart, narrowEnd);
    assert.notEqual(narrowStart, -1);
    assert.match(narrow, /\.json-grid\s*\{\s*grid-template-columns:\s*1fr/);
    assert.match(narrow, /\.json-compare-grid \.json-pane \+ \.json-pane\s*\{[^}]*border-top:\s*1px solid var\(--line\);\s*border-left:\s*0/);
});
