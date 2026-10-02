const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const scripts = path.join(__dirname, "..", "static", "js");
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const response = (body, ok = true) => ({ok, json: async () => body});
class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false;
        this.disabled = false; this.dataset = {}; this.children = [];
        this.handlers = {}; this.files = []; this.nodes = {};
        this.classList = {toggle() {}};
    }
    addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
    async fire(name) {
        const event = {target: this, preventDefault() {}};
        for (const callback of this.handlers[name] || []) await callback(event);
    }
    querySelector(selector) { return this.nodes[selector]; }
    querySelectorAll(selector) { return this.nodes[selector] || []; }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    focus() {}
    setCustomValidity() {}
    reportValidity() {}
}
function harness() {
    const form = new Element();
    const selectors = ["source", "output", "status", "copy", "download", "save", "save-new", "process", "material-id", "indent", "sort", "clear", "file"];
    const elements = Object.fromEntries(selectors.map(name => [name, new Element()]));
    for (const [name, element] of Object.entries(elements)) form.nodes["[data-json-" + name + "]"] = element;
    const format = new Element(); format.dataset.jsonOperation = "format";
    const minify = new Element(); minify.dataset.jsonOperation = "minify";
    form.nodes["[data-json-operation]"] = [format, minify];
    form.nodes['[data-json-operation][aria-pressed="true"]'] = format;
    form.nodes['[name="csrfmiddlewaretoken"]'] = {value: "token"};
    form.dataset = {processUrl: "process", saveUrl: "save", downloadUrl: "download"};
    elements.indent.value = "2";
    elements.source.value = "{}";
    const panel = new Element();
    const title = new Element(), confirm = new Element(), heading = new Element(), cancel = new Element();
    Object.assign(panel.nodes, {"[data-json-title]": title, "[data-json-save-confirm]": confirm, "[data-json-save-heading]": heading, "[data-json-save-cancel]": cancel});
    panel.hidden = true;
    const notice = new Element(); notice.nodes["[data-json-saved-message]"] = new Element(); notice.hidden = true;
    const queue = [], requests = [], links = [];
    const doc = {
        querySelector(selector) { return {"[data-json-tool]": form, "[data-json-save-panel]": panel, "[data-json-saved-notice]": notice}[selector]; },
        getElementById() { return null; },
        createTextNode(textContent) { return {textContent}; },
        createElement(tag) {
            const element = new Element();
            element.click = () => links.push(element);
            return element;
        },
    };
    class Data {
        constructor() { this.values = new Map(); }
        set(key, value) { this.values.set(key, value); }
        get(key) { return this.values.get(key); }
    }
    const clipboard = {writeText: async () => {}};
    vm.runInNewContext(fs.readFileSync(path.join(scripts, "json.js"), "utf8"), {
        document: doc, FormData: Data, AbortController, TextDecoder,
        navigator: {clipboard}, URL: {createObjectURL: () => "blob:test", revokeObjectURL() {}},
        window: {setTimeout: callback => callback()},
        fetch: async (url, options) => {
            requests.push({url, data: options.body});
            const item = queue.shift();
            if (!item) throw new Error("Unexpected fetch");
            return item instanceof Error ? Promise.reject(item) : item;
        },
    });
    const process = async (value = "{}") => {
        queue.push(response({ok: true, result: value}));
        await form.fire("submit");
    };
    return {...elements, form, panel, title, confirm, cancel, heading, notice, queue, requests, links, clipboard, process};
}

test("processing failure clears the previous result and disables actions", async () => {
    const h = harness(); await h.process('{"ok":true}');
    assert.equal(h.save.disabled, false);
    h.queue.push(response({ok: false, error: "Invalid JSON"}, false));
    await h.form.fire("submit");
    assert.equal(h.output.children.length, 0);
    assert.equal(h.copy.disabled, true);
    assert.equal(h.download.disabled, true);
    assert.equal(h.save.disabled, true);
    assert.equal(h.status.textContent, "Invalid JSON");
});

test("save panel is explicit; first save enables update and blank save-as-new", async () => {
    const h = harness(); await h.process();
    assert.equal(h.panel.hidden, true);
    await h.save.fire("click");
    assert.equal(h.panel.hidden, false);
    h.title.value = "First"; await h.title.fire("input");
    h.queue.push(response({ok: true, id: 7, title: "First", result: "{}", created: true}));
    await h.panel.fire("submit");
    assert.equal(h.panel.hidden, true);
    assert.equal(h.notice.hidden, false);
    assert.equal(h.save.textContent, "Сохранить изменения");
    assert.equal(h["save-new"].hidden, false);
    await h.panel.fire("submit");
    assert.equal(h.requests.length, 2);
    await h["save-new"].fire("click");
    assert.equal(h.title.value, "");
    await h.panel.fire("submit");
    assert.equal(h.requests.length, 2);
    h.title.value = "Copy"; await h.title.fire("input");
    h.queue.push(response({ok: true, id: 8, title: "Copy", result: "{}", created: true}));
    await h.panel.fire("submit");
    assert.equal(h.requests.at(-1).data.get("save_as_new"), "on");
});

test("double submission is serialized; stale save retains its created ID", async () => {
    const h = harness(); await h.process(); await h.save.fire("click");
    h.title.value = "First";
    const pending = deferred(); h.queue.push(pending.promise);
    const saving = h.panel.fire("submit");
    await h.panel.fire("submit");
    assert.equal(h.requests.length, 2);
    assert.equal(h.confirm.disabled, true);
    h.source.value = '{"changed":true}'; await h.source.fire("input");
    pending.resolve(response({ok: true, id: 9, title: "First", result: "{}", created: true}));
    await saving;
    assert.equal(h["material-id"].value, 9);
    assert.equal(h.save.disabled, true);
    assert.equal(h.notice.hidden, true);
    await h.process('{"changed":true}');
    await h.save.fire("click");
    h.queue.push(response({ok: true, id: 9, title: "First", result: '{"changed":true}', created: false}));
    await h.panel.fire("submit");
    assert.equal(h.requests.at(-1).data.get("material_id"), 9);
    assert.equal(h.requests.at(-1).data.get("save_as_new"), undefined);
});

test("title edits reject stale save confirmation without discarding ID", async () => {
    const h = harness(); await h.process(); await h.save.fire("click");
    h.title.value = "Old";
    const pending = deferred(); h.queue.push(pending.promise);
    const saving = h.panel.fire("submit");
    h.title.value = "New"; await h.title.fire("input");
    pending.resolve(response({ok: true, id: 4, title: "Old", result: "{}", created: true}));
    await saving;
    assert.equal(h["material-id"].value, 4);
    assert.equal(h.title.value, "New");
    assert.equal(h.notice.hidden, true);
    assert.equal(h.panel.hidden, false);
});

test("stale process response cannot restore invalidated output", async () => {
    const h = harness(); const pending = deferred(); h.queue.push(pending.promise);
    const processing = h.form.fire("submit");
    await h.source.fire("input");
    pending.resolve(response({ok: true, result: '{"old":1}'}));
    await processing;
    assert.equal(h.output.children.length, 0);
    assert.equal(h.save.disabled, true);
});

test("download checks freshness after blob await, including title changes", async () => {
    for (const changed of ["source", "title"]) {
        const h = harness(); await h.process();
        const blob = deferred();
        h.queue.push({ok: true, blob: () => blob.promise});
        const downloading = h.download.fire("click");
        await Promise.resolve(); await Promise.resolve();
        await h[changed].fire("input");
        blob.resolve({});
        await downloading;
        assert.equal(h.links.length, 0);
    }
});

test("copy, download and save failures give honest errors and unlock controls", async () => {
    const h = harness(); await h.process();
    h.clipboard.writeText = async () => { throw new Error("denied"); };
    await h.copy.fire("click");
    assert.match(h.status.textContent, /Не удалось скопировать/);
    h.queue.push(new Error("network download"));
    await h.download.fire("click");
    assert.equal(h.status.textContent, "network download");
    await h.save.fire("click"); h.title.value = "Name";
    h.queue.push(new Error("network save"));
    await h.panel.fire("submit");
    assert.equal(h.status.textContent, "network save");
    assert.equal(h.confirm.disabled, false);
});

test("file decoding is fatal UTF-8 and enforces extension", async () => {
    const h = harness(); await h.process();
    h.file.files = [{name: "bad.json", size: 2, arrayBuffer: async () => Uint8Array.of(0xff, 0xfe).buffer}];
    await h.file.fire("change");
    assert.match(h.status.textContent, /UTF-8/);
    assert.equal(h.source.value, "{}");
    assert.equal(h.save.disabled, true);
    h.file.files = [{name: "bad.txt", size: 2, arrayBuffer: () => { throw Error("must not read"); }}];
    await h.file.fire("change");
    assert.match(h.status.textContent, /расширением/);
});

test("file races cannot replace a newer file or manual edit", async () => {
    const h = harness(); const old = deferred();
    h.file.files = [{name: "old.json", size: 2, arrayBuffer: () => old.promise}];
    const oldReading = h.file.fire("change");
    h.file.files = [{name: "new.json", size: 2, arrayBuffer: async () => new TextEncoder().encode('{"new":1}').buffer}];
    await h.file.fire("change");
    old.resolve(new TextEncoder().encode('{"old":1}').buffer);
    await oldReading;
    assert.equal(h.source.value, '{"new":1}');
    const another = deferred();
    h.file.files = [{name: "read.json", size: 2, arrayBuffer: () => another.promise}];
    const reading = h.file.fire("change");
    h.source.value = "manual"; await h.source.fire("input");
    another.resolve(new TextEncoder().encode("{}").buffer);
    await reading;
    assert.equal(h.source.value, "manual");
});

test("attachment selection shows name/size and blocks files above 10 MiB", async () => {
    const form = new Element(), input = new Element(), button = new Element(), status = new Element();
    const toggle = new Element(), cancel = new Element();
    form.hidden = true;
    let expanded;
    toggle.setAttribute = (name, value) => { if (name === "aria-expanded") expanded = value; };
    Object.assign(form.nodes, {'input[type="file"]': input, "[data-attachment-submit]": button,
        "[data-attachment-status]": status, "[data-attachment-cancel]": cancel});
    vm.runInNewContext(fs.readFileSync(path.join(scripts, "attachments.js"), "utf8"), {
        document: {querySelector: selector => selector === "[data-attachment-upload]" ? form : toggle},
    });
    await toggle.fire("click");
    assert.equal(form.hidden, false); assert.equal(expanded, "true");
    input.files = [{name: "report.txt", size: 1024}]; await input.fire("change");
    assert.equal(button.disabled, false); assert.match(status.textContent, /report.txt.*1 КБ/);
    input.files = [{name: "large.txt", size: 10 * 1024 * 1024 + 1}]; await input.fire("change");
    assert.equal(button.disabled, true);
    let prevented = false;
    form.handlers.submit[0]({preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    // Browsers clear FileList when the file input value is reset.
    let inputValue;
    Object.defineProperty(input, "value", {get: () => inputValue, set(value) { inputValue = value; if (!value) this.files = []; }});
    await cancel.fire("click");
    assert.equal(form.hidden, true); assert.equal(expanded, "false");
    assert.equal(input.value, ""); assert.equal(button.disabled, true);
});

test("dirty note retains beforeunload warning for native bookmark/attachment navigation", async () => {
    const form = new Element(), status = new Element(), state = new Element(), time = new Element();
    status.nodes = {"[data-save-state]": state, "[data-last-saved]": time};
    const window = {clearTimeout() {}, setTimeout() {}, addEventListener(name, callback) { this[name] = callback; }};
    vm.runInNewContext(fs.readFileSync(path.join(scripts, "notes.js"), "utf8"), {
        document: {querySelector: selector => selector === "[data-note-autosave]" ? form : status}, window,
    });
    await form.fire("input");
    let prevented = false;
    const event = {preventDefault() { prevented = true; }};
    window.beforeunload(event);
    assert.equal(prevented, true);
    assert.equal(event.returnValue, "");
});
