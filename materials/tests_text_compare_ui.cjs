const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const core = require("../static/js/text_compare_core.js");

class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false; this.disabled = false;
        this.checked = false; this.files = []; this.dataset = {}; this.children = [];
        this.handlers = {}; this.classList = {toggle() {}};
    }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) { for (const handler of this.handlers[name] || []) await handler({target: this}); }
    replaceChildren(...items) { this.children = items; }
    append(...items) { this.children.push(...items); }
    click() { this.clicked = true; }
}

function harness() {
    const root = new Element(), elements = {}, workers = [], blobs = [], links = [];
    root.dataset.workerUrl = "/static/js/text_compare_worker.js";
    for (const selector of [
        '[data-text-input="left"]', '[data-text-input="right"]',
        '[data-text-side-status="left"]', '[data-text-side-status="right"]',
        '[data-text-file="left"]', '[data-text-file="right"]',
        "[data-text-ignore-case]", "[data-text-ignore-trailing]", "[data-text-run]",
        "[data-text-feedback]", "[data-text-report]", "[data-text-summary]",
        "[data-text-position]", "[data-text-change]", "[data-text-prev]",
        "[data-text-next]", "[data-text-copy]", "[data-text-download]",
    ]) elements[selector] = new Element();
    root.querySelector = selector => elements[selector];
    class Worker {
        constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
        postMessage(payload) { this.payload = payload; }
        terminate() { this.terminated = true; }
        respond() { this.onmessage({data: {ok: true, result: core.compare(this.payload.left, this.payload.right, this.payload.options)}}); }
    }
    const clipboard = {value: "", async writeText(value) { this.value = value; }};
    const doc = {
        querySelector(selector) { return selector === "[data-text-tool]" ? root : null; },
        createElement(tag) { const item = new Element(); item.tag = tag; if (tag === "a") links.push(item); return item; },
        createTextNode(value) { return {type: "text", value}; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/text_compare.js"), "utf8"), {
        document: doc, globalThis: {QATextCompareCore: core}, Worker, TextDecoder,
        navigator: {clipboard}, Blob,
        URL: {createObjectURL(blob) { blobs.push(blob); return "blob:report"; }, revokeObjectURL() {}},
        window: {setTimeout() {}},
    });
    const get = name => elements[`[data-text-${name}]`];
    return {get, elements, workers, blobs, links, clipboard};
}

test("stale worker answer cannot restore result; one card is visible and export stays complete", async () => {
    const h = harness(), left = h.get('input="left"'), right = h.get('input="right"');
    left.value = "a\nb\nc"; right.value = "x\ny\nz";
    await h.get("run").fire("click");
    const old = h.workers[0];
    right.value = "x\ny\nnew";
    await right.fire("input");
    assert.equal(old.terminated, true);
    old.respond();
    assert.equal(h.get("report").hidden, true);
    await h.get("run").fire("click");
    h.workers[1].respond();
    assert.equal(h.get("report").hidden, false);
    assert.equal(h.get("change").children.length, 3);
    assert.equal(h.get("position").textContent, "1 из 3");
    await h.get("copy").fire("click");
    assert.match(h.clipboard.value, /Строка 3 → 3:/);
    await h.get("download").fire("click");
    assert.equal(await h.blobs[0].text(), h.clipboard.value);
    assert.equal(h.links[0].download, "text-comparison.txt");
    await h.get("next").fire("click");
    assert.equal(h.get("position").textContent, "2 из 3");
});

test("modified fragments use text nodes and mark instead of HTML insertion", async () => {
    const h = harness();
    h.get('input="left"').value = "<b>old</b>";
    h.get('input="right"').value = "<b>new</b>";
    await h.get("run").fire("click");
    h.workers[0].respond();
    const rows = h.get("change").children.slice(1);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].children[1].tag, "pre");
    assert.equal(rows[0].children[1].children[1].tag, "mark");
    assert.equal(rows[0].children[1].children[0].value, "<b>");
});

test("independent file reads accept UTF-8 and cancel only an outdated side", async () => {
    const h = harness(), leftFile = h.get('file="left"'), rightFile = h.get('file="right"');
    let resolveLeft;
    const pending = new Promise(done => { resolveLeft = done; });
    leftFile.files = [{name: "old.txt", size: 1, arrayBuffer: () => pending}];
    const leftLoad = leftFile.fire("change");
    rightFile.files = [{name: "new.txt", size: 1, arrayBuffer: async () => Uint8Array.of(66).buffer}];
    await rightFile.fire("change");
    assert.equal(h.get("run").disabled, true);
    resolveLeft(Uint8Array.of(65).buffer);
    await leftLoad;
    assert.equal(h.get('input="left"').value, "A");
    assert.equal(h.get('input="right"').value, "B");
    assert.equal(h.get("run").disabled, false);
    leftFile.files = [{name: "bad.txt", size: 2, arrayBuffer: async () => Uint8Array.of(0xff, 0xff).buffer}];
    await leftFile.fire("change");
    assert.match(h.get("feedback").textContent, /UTF-8/);
    assert.equal(h.get('input="left"').value, "A");
});
