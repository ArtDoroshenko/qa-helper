const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false; this.disabled = false;
        this.files = []; this.dataset = {}; this.handlers = {}; this.attributes = {};
        this.classList = {add() {}, remove() {}};
    }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) { for (const handler of this.handlers[name] || []) await handler({target: this, preventDefault() {}}); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    focus() {}
    select() {}
}

function harness() {
    const template = fs.readFileSync(path.join(__dirname, "../templates/materials/base64_tool.html"), "utf8");
    const script = template.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1]
        .replace(/\{\{\s*form\.([a-z_]+)\.id_for_label\s*\}\}/g, (_, name) => `id_${name}`);
    assert.ok(script);
    const elements = Object.fromEntries(["text", "file", "operation", "as_data_url", "output_name", "output", "status",
        "copy", "download", "preview", "meta", "file-name", "drop", "clear", "source-title", "data-url", "text-source", "file-source", "submit"]
        .map(name => [name, new Element()]));
    const form = new Element(); form.dataset.initialMode = "text";
    const modes = [new Element(), new Element()];
    modes[0].dataset.base64Mode = "text";
    modes[1].dataset.base64Mode = "file";
    modes[0].setAttribute("aria-pressed", "true");
    modes[1].setAttribute("aria-pressed", "false");
    form.querySelectorAll = selector => selector === "[data-base64-mode]" ? modes : [];
    form.querySelector = selector => ({
        "[data-base64-text-source]": elements["text-source"],
        "[data-base64-file-source]": elements["file-source"],
        "[data-base64-source-title]": elements["source-title"],
        "[data-base64-data-url]": elements["data-url"],
        "[data-base64-output]": elements.output,
        "[data-base64-result-meta]": elements.meta,
        "[data-base64-status]": elements.status,
        "[data-base64-copy]": elements.copy,
        "[data-base64-preview]": elements.preview,
        "[data-base64-file-name]": elements["file-name"],
        "[data-base64-drop]": elements.drop,
        "[data-base64-clear]": elements.clear,
        "[name='output_name']": elements.output_name,
        ".base64-submit": elements.submit,
    })[selector];
    const ids = {"base64-tool-form": form, "id_text": elements.text, "id_file": elements.file,
        "id_operation": elements.operation, "id_as_data_url": elements.as_data_url,
        "base64-download-button": elements.download};
    elements.operation.value = "encode";
    elements.output.value = "old result";
    elements.meta.textContent = "Результат готов";
    elements.preview.hidden = false;
    const clipboard = {async writeText() {}};
    const window = new Element();
    vm.runInNewContext(script, {
        document: {getElementById: id => ids[id], execCommand: () => false},
        navigator: {clipboard}, Event: class Event {}, window,
    });
    return {...elements, form, modes, clipboard, window};
}

test("Base64 keeps the existing result until input changes, then disables stale copy and download", async () => {
    const h = harness();
    assert.equal(h.output.value, "old result");
    assert.equal(h.download.disabled, false);
    h.text.value = "changed";
    await h.text.fire("input");
    assert.equal(h.output.value, "");
    assert.equal(h.copy.disabled, true);
    assert.equal(h.download.disabled, true);
    assert.equal(h.preview.hidden, true);
    assert.equal(h.meta.textContent, "UTF-8 · текст или файл");
    h.output.value = "next result";
    h.download.disabled = false;
    await h.modes[1].fire("click");
    assert.equal(h.output.value, "");
    assert.equal(h.download.disabled, true);
    h.file.files = [{name: "input.txt"}];
    await h.file.fire("change");
    assert.equal(h["file-name"].textContent, "input.txt");
    await h.form.fire("submit");
    assert.equal(h.status.textContent, "Обрабатываем…");
    assert.equal(h.submit.disabled, true);
    await h.window.fire("pageshow");
    assert.equal(h.submit.disabled, false);
});
