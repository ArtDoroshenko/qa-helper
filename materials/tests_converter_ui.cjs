const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const core = require("../static/js/converter_core.js");

class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false; this.disabled = false;
        this.dataset = {}; this.files = []; this.nodes = {}; this.children = [];
        this.handlers = {}; this.attributes = {}; this.classList = {toggle() {}};
    }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name, extra = {}) {
        for (const handler of this.handlers[name] || []) await handler({target: this, preventDefault() {}, ...extra});
    }
    querySelector(selector) { return this.nodes[selector]; }
    querySelectorAll(selector) { return this.nodes[selector] || []; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    replaceChildren(...items) { this.children = items; }
    append(...items) { this.children.push(...items); }
    click() { this.clicked = true; }
}

function harness() {
    const root = new Element(), panels = {}, tabs = [], elements = {}, workers = [], links = [], blobs = [];
    const make = (mode, names) => {
        const panel = new Element(); panel.dataset.converterPanel = mode;
        panels[mode] = panel;
        for (const name of names.split(" ")) {
            const element = new Element();
            panel.nodes[`[data-${name}]`] = element;
            elements[name] = element;
        }
        return panel;
    };
    make("base64", "");
    make("date", "date-direction date-unit date-zone date-source date-label date-hint date-output date-meta date-status date-copy date-run");
    make("url", "url-operation url-mode url-source url-output url-status url-run url-copy url-download");
    make("jwt", "jwt-source jwt-run jwt-status jwt-result jwt-header jwt-payload jwt-dates jwt-expiry jwt-header-copy jwt-payload-copy jwt-download");
    make("hash", "hash-source hash-file-panel hash-file hash-filename hash-algorithm hash-expected hash-output hash-meta hash-match hash-status hash-run hash-copy");
    panels.hash.dataset.workerUrl = "/static/js/converter_hash_worker.js";
    const modes = [new Element(), new Element()];
    modes[0].dataset.hashMode = "text"; modes[1].dataset.hashMode = "file";
    panels.hash.nodes["[data-hash-mode]"] = modes;
    for (const name of ["base64", "date", "url", "jwt", "hash"]) {
        const tab = new Element(); tab.dataset.converterTab = name; tabs.push(tab);
    }
    root.nodes["[data-converter-tab]"] = tabs;
    root.nodes["[data-converter-panel]"] = Object.values(panels);
    elements["date-direction"].value = "to-date";
    elements["date-unit"].value = "s";
    elements["date-zone"].value = "UTC";
    elements["url-operation"].value = "encode";
    elements["url-mode"].value = "percent";
    elements["hash-algorithm"].value = "SHA-256";
    const timers = new Map(); let timerId = 0;
    class Worker {
        constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
        postMessage(payload, transfer) { this.payload = payload; this.transfer = transfer; }
        terminate() { this.terminated = true; }
        respond(digest, size) { this.onmessage({data: {id: this.payload.id, ok: true, digest, size}}); }
    }
    const clipboard = {text: null, async writeText(value) { this.text = value; }};
    const doc = {
        querySelector(selector) { return selector === ".base64-page" ? root : null; },
        createElement(tag) { const element = new Element(); if (tag === "a") links.push(element); return element; },
    };
    const context = {
        document: doc, Worker, TextEncoder, Blob, QAConverterCore: core,
        navigator: {clipboard},
        URL: {createObjectURL(blob) { blobs.push(blob); return "blob:test"; }, revokeObjectURL() {}},
        window: {
            setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/converter.js"), "utf8"), context);
    const fireTimer = async (delay) => {
        const item = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(item, `missing timer ${delay}`);
        timers.delete(item[0]);
        item[1].callback();
        await Promise.resolve();
    };
    return {root, panels, tabs, elements, modes, workers, links, blobs, clipboard, timers, fireTimer};
}

test("tabs keep independent inputs; date change cancels pending work and DST error clears result", async () => {
    const h = harness(), e = h.elements;
    await h.tabs[1].fire("click");
    assert.equal(h.panels.date.hidden, false);
    assert.equal(h.panels.base64.hidden, true);
    e["date-source"].value = "0";
    await e["date-run"].fire("click");
    e["date-source"].value = "1";
    await e["date-source"].fire("input");
    await h.fireTimer(0);
    assert.equal(e["date-copy"].disabled, true);
    await e["date-run"].fire("click");
    await h.fireTimer(0);
    assert.match(e["date-output"].textContent, /1970-01-01 00:00:01/);
    await e["date-copy"].fire("click");
    assert.match(h.clipboard.text, /1970-01-01T00:00:01/);
    e["date-direction"].value = "to-stamp";
    await e["date-direction"].fire("change");
    e["date-zone"].value = "America/New_York";
    await e["date-zone"].fire("change");
    e["date-source"].value = "2026-03-08 02:30:00";
    await e["date-source"].fire("input");
    await e["date-run"].fire("click");
    await h.fireTimer(0);
    assert.match(e["date-status"].textContent, /не существует/);
    assert.equal(e["date-copy"].disabled, true);
    await h.tabs[2].fire("click");
    assert.equal(e["date-source"].value, "2026-03-08 02:30:00");
});

test("URL output is transient, one-pass, copied and downloaded in full", async () => {
    const h = harness(), e = h.elements;
    e["url-source"].value = "%2520";
    e["url-operation"].value = "decode";
    await e["url-run"].fire("click");
    await h.fireTimer(0);
    assert.equal(e["url-output"].textContent, "%20");
    await e["url-copy"].fire("click");
    assert.equal(h.clipboard.text, "%20");
    await e["url-download"].fire("click");
    assert.equal(await h.blobs[0].text(), "%20");
    assert.equal(h.links[0].download, "url-result.txt");
    e["url-source"].value = "%ZZ";
    await e["url-source"].fire("input");
    assert.equal(e["url-download"].disabled, true);
    await e["url-run"].fire("click");
    await h.fireTimer(0);
    assert.match(e["url-status"].textContent, /percent/);
    assert.equal(e["url-copy"].disabled, true);
});

test("JWT result hides on token edit and displays unverified warning independently", async () => {
    const h = harness(), e = h.elements;
    const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"QA"}').toString("base64url")}.`;
    e["jwt-source"].value = token;
    await e["jwt-run"].fire("click");
    await h.fireTimer(0);
    assert.equal(e["jwt-result"].hidden, false);
    assert.equal(e["jwt-expiry"].textContent, "exp отсутствует");
    assert.match(e["jwt-status"].textContent, /подпись не проверена/);
    await e["jwt-download"].fire("click");
    assert.deepEqual(JSON.parse(await h.blobs[0].text()).payload, {sub: "QA"});
    e["jwt-source"].value = "bad";
    await e["jwt-source"].fire("input");
    assert.equal(e["jwt-result"].hidden, true);
    await e["jwt-run"].fire("click");
    await h.fireTimer(0);
    assert.match(e["jwt-status"].textContent, /три сегмента/);
    assert.equal(e["jwt-result"].hidden, true);
});

test("hash file read and worker responses cannot restore stale output", async () => {
    const h = harness(), e = h.elements;
    await h.modes[1].fire("click");
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    e["hash-file"].files = [{name: "old.bin", size: 3, arrayBuffer: () => pending}];
    await e["hash-file"].fire("change");
    const running = e["hash-run"].fire("click");
    e["hash-file"].files = [{name: "new.bin", size: 3, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer}];
    await e["hash-file"].fire("change");
    resolve(Uint8Array.of(4, 5, 6).buffer);
    await running;
    assert.equal(h.workers.length, 0);
    await e["hash-run"].fire("click");
    assert.equal(h.workers.length, 1);
    const first = h.workers[0];
    assert.equal(first.payload.mode, "file");
    assert.equal(first.transfer[0], first.payload.buffer);
    await e["hash-expected"].fire("input");
    assert.equal(first.terminated, true);
    first.respond("abc", 3);
    assert.equal(e["hash-copy"].disabled, true);
    await e["hash-run"].fire("click");
    h.workers[1].respond("a".repeat(64), 3);
    assert.equal(e["hash-output"].textContent, "a".repeat(64));
    assert.equal(e["hash-copy"].disabled, false);
});
