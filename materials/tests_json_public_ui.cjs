const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

class Element {
    constructor() {
        this.listeners = {};
        this.dataset = {};
        this.children = [];
        this.classList = {toggle() {}};
        this.textContent = "";
        this.value = "";
        this.disabled = true;
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    fire(type, extra = {}) { return this.listeners[type]?.({preventDefault() {}, ...extra}); }
    setAttribute() {}
    replaceChildren() { this.children = []; this.textContent = ""; }
    append(child) { this.children.push(child); }
}

function harness(result) {
    const nodes = Object.fromEntries(["source", "output", "preview-note", "status", "copy", "download",
        "indent", "sort", "file", "clear"].map(name => [name, new Element()]));
    nodes.source.value = "{}";
    nodes.indent.value = "2";
    const form = new Element();
    form.action = "/tools/json/process/";
    const operations = ["format", "minify"].map(jsonOperation => Object.assign(new Element(), {dataset: {jsonOperation}}));
    form.querySelectorAll = () => operations;
    form.querySelector = selector => selector.startsWith("[name=") ? {value: "token"} : nodes[selector.slice(11, -1)];
    const copied = [], downloads = [], requests = [], revoked = [];
    const blobs = new Map();
    const document = {
        querySelector: selector => selector === "[data-json-tool]" ? form : null,
        querySelectorAll: () => [],
        createTextNode: textContent => ({textContent}),
        createElement: tag => tag === "a"
            ? {click() { downloads.push({filename: this.download, blob: blobs.get(this.href)}); }}
            : new Element(),
    };
    vm.runInNewContext(readFileSync(join(__dirname, "../static/js/json_public.js"), "utf8"), {
        document, AbortController, FormData, Blob,
        fetch: async (url, options) => {
            requests.push({url, options});
            return {ok: true, json: async () => ({ok: true, result})};
        },
        navigator: {clipboard: {writeText: async value => copied.push(value)}},
        URL: {
            createObjectURL(blob) { blobs.set("blob:1", blob); return "blob:1"; },
            revokeObjectURL(url) { revoked.push(url); },
        },
        setTimeout: callback => callback(),
    });
    return {nodes, form, operations, copied, downloads, requests, revoked};
}

test("large JSON preview stays bounded and exports the full result without a second request", async () => {
    const value = '"' + "a".repeat(8190) + '🙂 и хвост"';
    const h = harness(value);
    assert.ok(h.operations.every(button => !button.disabled));
    await h.form.fire("submit", {submitter: h.operations[1]});
    assert.equal(h.requests[0].url, "/tools/json/process/");
    assert.equal(h.requests[0].options.body.get("operation"), "minify");
    assert.equal(h.nodes.output.textContent, '"' + "a".repeat(8190));
    assert.match(h.nodes["preview-note"].textContent, /Предпросмотр сокращён/);
    await h.nodes.copy.fire("click");
    h.nodes.download.fire("click");
    assert.deepEqual(h.copied, [value]);
    assert.equal(h.downloads[0].filename, "result.json");
    assert.equal(await h.downloads[0].blob.text(), value);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.revoked, ["blob:1"]);
});

test("dense JSON gets bounded highlighting without losing the rest of the preview", async () => {
    const value = "[" + "0,".repeat(1000) + "0]";
    const h = harness(value);
    await h.form.fire("submit");
    assert.equal(h.nodes.output.children.filter(node => node.className).length, 512);
    assert.equal(h.nodes.output.children.map(node => node.textContent).join(""), value);
});
