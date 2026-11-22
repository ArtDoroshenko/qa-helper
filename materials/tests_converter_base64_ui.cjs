const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {crc32, deflateSync} = require("node:zlib");
const screenshots = require("../static/js/screenshots_core.js");

class Element {
    constructor() {
        this.value = ""; this.textContent = ""; this.hidden = false; this.disabled = false;
        this.files = []; this.dataset = {}; this.handlers = {}; this.attributes = {};
        this.classList = {add() {}, remove() {}, toggle() {}};
    }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) { for (const handler of this.handlers[name] || []) await handler({target: this, preventDefault() {}}); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() {}
    select() {}
}

function harness({readMetadata = screenshots.readMetadata} = {}) {
    const script = fs.readFileSync(path.join(__dirname, "../static/js/base64.js"), "utf8");
    const elements = Object.fromEntries(["text", "file", "operation", "as_data_url", "output_name", "output", "status",
        "copy", "download", "preview", "meta", "file-name", "file-limit", "drop", "clear", "source-title", "data-url", "text-source", "file-source", "submit"]
        .map(name => [name, new Element()]));
    const form = new Element(); form.action = "/tools/base64/";
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
        "[data-base64-file-limit]": elements["file-limit"],
        "[data-base64-drop]": elements.drop,
        "[data-base64-clear]": elements.clear,
        "[name='output_name']": elements.output_name,
        ".base64-submit": elements.submit,
    })[selector];
    const ids = {"base64-tool-form": form, "id_text": elements.text, "id_file": elements.file,
        "id_operation": elements.operation, "id_as_data_url": elements.as_data_url,
        "base64-download-button": elements.download};
    elements.operation.value = "encode";
    elements.preview.hidden = true;
    const requests = [], responses = [], copied = [], downloads = [], urls = new Map(), revoked = [];
    const clipboard = {async writeText(text) { copied.push(text); }};
    const window = new Element();
    window.QAScreenshots = {readMetadata};
    window.setTimeout = callback => callback();
    vm.runInNewContext(script, {
        document: {
            getElementById: id => ids[id],
            createElement: () => ({click() { downloads.push({name: this.download, blob: urls.get(this.href)}); }}),
        },
        navigator: {clipboard}, Event: class Event {}, window, AbortController, TextDecoder,
        FormData: class FormData { constructor(element) { this.form = element; } },
        URL: {
            createObjectURL(blob) { const url = `blob:${urls.size}`; urls.set(url, blob); return url; },
            revokeObjectURL(url) { revoked.push(url); },
        },
        fetch(url, options) {
            requests.push({url, options});
            return Promise.resolve(responses.shift());
        },
    });
    return {...elements, form, modes, window, requests, responses, copied, downloads, revoked};
}

function pngBlob(width, height) {
    const chunk = (type, data = Buffer.alloc(0)) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const length = Buffer.alloc(4);
        const crc = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    return new Blob([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
        chunk("IEND"),
    ], {type: "image/png"});
}

function attachment(blob, headers) {
    return {ok: true, headers: new Headers(headers), blob: async () => blob};
}

test("Base64 previews 8 KiB and copies or downloads the one full response", async () => {
    const h = harness();
    const text = "x".repeat(8191) + "🙂tail";
    const blob = new Blob([text], {type: "text/plain"});
    h.responses.push(attachment(blob, {
        "X-QA-Result-Text": "1", "Content-Disposition": "attachment; filename*=utf-8''%D1%82%D0%B5%D1%81%D1%82.txt",
    }));
    await h.form.fire("submit");
    assert.equal(h.output.value, "x".repeat(8191));
    assert.match(h.meta.textContent, /8 КиБ/);
    assert.equal(h.copy.disabled, false);
    assert.equal(h.download.disabled, false);
    await h.copy.fire("click");
    await h.download.fire("click");
    assert.deepEqual(h.copied, [text]);
    assert.equal(h.downloads[0].name, "тест.txt");
    assert.equal(h.downloads[0].blob, blob);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.body.form, h.form);
    assert.equal(h.revoked.length, 1);
    for (const [control, event] of [[h.text, "input"], [h.as_data_url, "change"], [h.output_name, "input"]]) {
        h.status.textContent = "Предыдущий статус";
        await control.fire(event);
        assert.equal(h.status.textContent, "Данные изменены. Преобразуйте снова.");
        assert.equal(h.output.value, "");
        assert.equal(h.copy.disabled, true);
        assert.equal(h.download.disabled, true);
        assert.equal(h.preview.hidden, true);
        assert.equal(h.meta.textContent, "UTF-8 · текст или файл");
    }
});

test("Base64 preview URLs are released and a canceled response cannot replace a new input", async () => {
    const h = harness();
    h.operation.value = "decode";
    await h.operation.fire("change");
    assert.match(h["file-limit"].textContent, /запрос до 16 МиБ.*результат до 10 МиБ/i);
    const image = pngBlob(2, 2);
    h.responses.push(attachment(image, {"X-QA-Preview-Type": "image/png"}));
    await h.form.fire("submit");
    assert.equal(h.preview.hidden, false);
    assert.equal(h.copy.disabled, true);
    assert.equal(h.download.disabled, false);
    await h.modes[1].fire("click");
    assert.equal(h.output.value, "");
    assert.equal(h.download.disabled, true);
    assert.equal(h.preview.hidden, true);
    assert.equal(h.revoked.length, 1);
    h.file.files = [{name: "input.txt"}];
    await h.file.fire("change");
    assert.equal(h["file-name"].textContent, "input.txt");
    let finish;
    h.responses.push(new Promise(resolve => { finish = resolve; }));
    const pending = h.form.fire("submit");
    assert.equal(h.submit.disabled, true);
    await h.file.fire("change");
    assert.equal(h.requests.at(-1).options.signal.aborted, true);
    finish(attachment(image, {"X-QA-Preview-Type": "image/png"}));
    await pending;
    assert.equal(h.submit.disabled, false);
    assert.equal(h.preview.hidden, true);
    assert.equal(h.download.disabled, true);
});

test("Base64 validates raster previews before allocating a URL and keeps the attachment", async () => {
    const oversized = pngBlob(screenshots.limits.side + 1, 1);
    const invalid = pngBlob(2, 2).slice(0, 24, "image/png");
    for (const image of [oversized, invalid]) {
        const h = harness();
        h.operation.value = "decode";
        await h.operation.fire("change");
        h.responses.push(attachment(image, {"X-QA-Preview-Type": "image/png"}));
        await h.form.fire("submit");
        assert.equal(h.preview.hidden, true);
        assert.equal(h.preview.src, undefined);
        assert.equal(h.status.textContent, "Готово");
        assert.equal(h.download.disabled, false);
        await h.download.fire("click");
        assert.equal(h.downloads[0].blob, image);
    }
});

test("Base64 discards a pending image preview if the input changes", async () => {
    const image = pngBlob(2, 2);
    let started, finish;
    const reading = new Promise(resolve => { started = resolve; });
    const h = harness({
        readMetadata() {
            started();
            return new Promise(resolve => { finish = resolve; });
        },
    });
    h.operation.value = "decode";
    await h.operation.fire("change");
    h.responses.push(attachment(image, {"X-QA-Preview-Type": "image/png"}));
    const pending = h.form.fire("submit");
    await reading;
    assert.equal(h.preview.hidden, true);
    await h.text.fire("input");
    finish(await screenshots.readMetadata(image));
    await pending;
    assert.equal(h.preview.hidden, true);
    assert.equal(h.preview.src, undefined);
    assert.equal(h.download.disabled, true);
});
