const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const core = require("../static/js/test_files_core.js");

class Element {
    constructor(tag = "div") {
        this.tag = tag; this.nodes = {}; this.handlers = {}; this.children = [];
        this.dataset = {}; this.value = ""; this.textContent = ""; this.hidden = false;
        this.disabled = false; this.checked = false; this.attributes = {};
        this.classList = {toggle() {}};
    }
    querySelector(selector) { return this.nodes[selector]; }
    querySelectorAll(selector) { return this.nodes[selector] || []; }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) { for (const handler of this.handlers[name] || []) await handler({target: this, preventDefault() {}}); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    click() {}
    remove() {}
}

function harness() {
    const root = new Element(), form = new Element("form");
    const names = "mode base size unit format triple width height image-format pattern background negative run cancel reset status results";
    const e = Object.fromEntries(names.split(" ").map(name => [name, new Element()]));
    for (const [name, element] of Object.entries(e)) root.nodes[`[data-tf-${name}]`] = element;
    root.nodes["[data-tf-form]"] = form;
    const panels = ["exact", "image", "negative", "names"].map(mode => {
        const panel = new Element(); panel.dataset.tfPanel = mode; return panel;
    });
    root.nodes["[data-tf-panel]"] = panels;
    form.nodes["input, select"] = Object.values(e).filter(item => item !== e.run && item !== e.cancel
        && item !== e.reset && item !== e.status && item !== e.results);
    const defaults = {mode: "exact", base: "upload-sample", size: "1024", unit: "1", format: "bin",
        width: "800", height: "600", "image-format": "png", pattern: "grid", background: "light", negative: "empty"};
    for (const [name, value] of Object.entries(defaults)) e[name].value = value;
    e.triple.checked = true;
    form.reset = () => { for (const [name, value] of Object.entries(defaults)) e[name].value = value; e.triple.checked = true; };

    const pendingCanvas = [], encoded = new WeakMap(), canvases = [], qualities = [], created = [], revoked = [], links = [];
    let holdCanvas = false, nullCanvas = false, wrongMime = false, wrongGeometry = false, closedBitmaps = 0;
    const makeCanvas = () => {
        const canvas = {
            width: 0, height: 0,
            getContext() { return {fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}}; },
            toBlob(callback, mime, quality) {
                qualities.push(quality);
                const blob = nullCanvas ? null : new Blob([new Uint8Array(64)], {type: wrongMime ? "image/png" : mime});
                if (!blob) { setTimeout(() => callback(null), 0); return; }
                encoded.set(blob, {width: this.width, height: this.height});
                if (holdCanvas) pendingCanvas.push(() => callback(blob));
                else setTimeout(() => callback(blob), 0);
            },
        };
        canvases.push(canvas);
        return canvas;
    };
    const document = {
        querySelector(selector) { return selector === "[data-td-files]" ? root : null; },
        createElement(tag) {
            if (tag === "canvas") return makeCanvas();
            const element = new Element(tag);
            if (tag === "a") { element.click = () => links.push({name: element.download, url: element.href}); }
            return element;
        },
        body: {append() {}},
    };
    const window = {handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; }};
    const timers = new Map(); let timerId = 0;
    const fakeSetTimeout = (callback, delay) => {
        if (delay !== 1000) return setTimeout(callback, delay);
        const id = ++timerId; timers.set(id, callback); return id;
    };
    const fakeClearTimeout = id => { if (timers.has(id)) timers.delete(id); else clearTimeout(id); };
    const URL = {
        createObjectURL(blob) { created.push(blob); return `blob:local-${created.length}`; },
        revokeObjectURL(url) { revoked.push(url); },
    };
    const globals = {QATestFilesCore: core};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/test_files.js"), "utf8"), {
        document, window, globalThis: globals, URL, Blob, Uint8Array,
        async createImageBitmap(blob) {
            const geometry = encoded.get(blob);
            return {...geometry, width: geometry.width + Number(wrongGeometry), close() { closedBitmaps++; }};
        },
        setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
        fetch() { throw new Error("File generation must not use fetch"); },
    });
    return {e, form, panels, canvases, qualities, pendingCanvas, created, revoked, links, timers, window,
        set holdCanvas(value) { holdCanvas = value; }, get closedBitmaps() { return closedBitmaps; },
        set nullCanvas(value) { nullCanvas = value; }, set wrongMime(value) { wrongMime = value; },
        set wrongGeometry(value) { wrongGeometry = value; },
        finishCanvas() { pendingCanvas.shift()?.(); },
        flushRevoke() { for (const callback of timers.values()) callback(); timers.clear(); },
    };
}

test("exact files show real byte sizes and download URLs are released", async () => {
    const h = harness();
    await h.form.fire("submit");
    assert.equal(h.e.results.children.length, 3);
    assert.deepEqual(h.e.results.children.map(row => row.children[0].children[1].textContent.replace(/\s/gu, " ").match(/[\d ]+ байт/u)[0].trim()),
        ["1 023 байт", "1 024 байт", "1 025 байт"]);
    await h.e.results.children[0].children[1].fire("click");
    assert.equal(h.created.length, 1);
    assert.equal(h.links[0].name, "upload-sample-L-minus-1.bin");
    h.flushRevoke();
    assert.deepEqual(h.revoked, ["blob:local-1"]);
    await h.e.results.children[1].children[1].fire("click");
    h.window.handlers.pagehide();
    assert.deepEqual(h.revoked, ["blob:local-1", "blob:local-2"]);
    await h.e.reset.fire("click");
    assert.equal(h.e.results.children.length, 0);
});

test("image mode shows encoded MIME, measured bytes and decoded geometry", async () => {
    const h = harness();
    h.e.mode.value = "image"; h.e["image-format"].value = "jpeg";
    await h.form.fire("change");
    assert.equal(h.panels[1].hidden, false);
    await h.form.fire("submit");
    const row = h.e.results.children[0], meta = row.children[0].children[1].textContent;
    assert.match(meta, /64 байт · image\/jpeg · 800 × 600 px/u);
    assert.equal(h.qualities[0], .85);
    assert.equal(h.closedBitmaps, 1);
    assert.equal(h.canvases[0].width, 0);
    assert.equal(h.created.length, 0);
});

test("encoding failures never publish a file and release canvas resources", async () => {
    const h = harness();
    h.e.mode.value = "image"; await h.form.fire("change");
    h.nullCanvas = true;
    await h.form.fire("submit");
    assert.match(h.e.status.textContent, /не смог закодировать/u);
    assert.equal(h.e.results.children.length, 0);
    assert.equal(h.canvases[0].width, 0);
    assert.equal(h.e.run.disabled, false);
    h.nullCanvas = false; h.wrongMime = true; h.e["image-format"].value = "jpeg";
    await h.form.fire("change");
    await h.form.fire("submit");
    assert.match(h.e.status.textContent, /вместо image\/jpeg/u);
    assert.equal(h.e.results.children.length, 0);
    h.wrongMime = false; h.wrongGeometry = true;
    await h.form.fire("submit");
    assert.match(h.e.status.textContent, /геометрия/u);
    assert.equal(h.e.results.children.length, 0);
    assert.equal(h.closedBitmaps, 1);
});

test("negative samples are honestly labelled and keep actual MIME", async () => {
    const h = harness();
    h.e.mode.value = "negative"; await h.form.fire("change");
    await h.form.fire("submit");
    assert.match(h.e.results.children[0].children[0].children[1].textContent, /0 байт/u);
    h.e.negative.value = "truncated"; await h.form.fire("change");
    await h.form.fire("submit");
    assert.match(h.e.results.children[0].children[0].children[1].textContent, /24 байт · image\/png/u);
    assert.match(h.e.results.children[0].children[0].children[2].textContent, /усечённый/u);
    h.e.negative.value = "mismatch"; await h.form.fire("change");
    await h.form.fire("submit");
    assert.match(h.e.results.children[0].children[0].children[0].textContent, /\.jpg$/u);
    assert.match(h.e.results.children[0].children[0].children[1].textContent, /image\/png/u);
});

test("cancel, edit, and reset keep one physical canvas job until its callback", async () => {
    for (const action of ["cancel", "edit", "reset"]) {
        const h = harness();
        h.e.mode.value = "image"; await h.form.fire("change");
        h.holdCanvas = true;
        const oldJob = h.form.fire("submit");
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(h.pendingCanvas.length, 1);
        if (action === "cancel") await h.e.cancel.fire("click");
        else if (action === "reset") await h.e.reset.fire("click");
        else { h.e.mode.value = "exact"; await h.form.fire("change"); }
        assert.equal(h.canvases[0].width, 800);
        assert.equal(h.e.run.disabled, true);
        assert.equal(h.e.cancel.hidden, true);
        await h.form.fire("submit");
        assert.equal(h.canvases.length, 1);
        assert.equal(h.pendingCanvas.length, 1);
        assert.equal(h.e.results.children.length, 0);
        h.finishCanvas();
        await oldJob;
        assert.equal(h.canvases[0].width, 0);
        assert.equal(h.e.run.disabled, false);
        assert.match(h.e.status.textContent, /можно создать файлы/u);
        h.holdCanvas = false;
        h.e.mode.value = "exact"; await h.form.fire("change");
        await h.form.fire("submit");
        assert.equal(h.e.results.children.length, 3);
        assert.match(h.e.results.children[0].children[0].children[0].textContent, /\.bin$/u);
        assert.equal(h.created.length, 0);
        h.window.handlers.pagehide();
    }
});

test("invalid dimensions fail before canvas allocation and names stay 32-byte ASCII", async () => {
    const h = harness();
    h.e.mode.value = "image"; await h.form.fire("change");
    h.e.width.value = "4096"; h.e.height.value = "4096";
    await h.form.fire("submit");
    assert.match(h.e.status.textContent, /8 000 000/u);
    assert.equal(h.canvases.length, 0);
    h.e.mode.value = "names"; await h.form.fire("change");
    await h.form.fire("submit");
    assert.equal(h.e.results.children.length, 4);
    assert.ok(h.e.results.children.every(row => /32 байта? · text\/plain/u.test(row.children[0].children[1].textContent)));
});

test("invalid image fields do not block exact mode after switching", async () => {
    const template = fs.readFileSync(path.join(__dirname, "../templates/materials/test_data_tool.html"), "utf8");
    assert.match(template, /<form data-tf-form novalidate>/u);
    const h = harness();
    h.e.mode.value = "image"; h.e.width.value = "4097";
    await h.form.fire("change");
    h.e.mode.value = "exact";
    await h.form.fire("change");
    await h.form.fire("submit");
    assert.equal(h.e.results.children.length, 3);
    assert.equal(h.canvases.length, 0);
});

test("parameter edit or reset clears old files and rejects stale callbacks", async () => {
    const h = harness();
    await h.form.fire("submit");
    assert.equal(h.e.results.children.length, 3);
    h.e.size.value = "0"; await h.form.fire("input");
    assert.equal(h.e.results.children.length, 0);
    await h.form.fire("submit");
    assert.equal(h.e.results.children.length, 2);
    await h.e.reset.fire("click");
    assert.equal(h.e.results.children.length, 0);
    assert.equal(h.e.size.value, "1024");
});
