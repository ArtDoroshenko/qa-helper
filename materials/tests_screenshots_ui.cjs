const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

class Element {
    constructor() {
        this.listeners = {};
        this.dataset = {};
        this.classList = {toggle() {}};
        this.files = [];
        this.hidden = false;
        this.disabled = false;
        this.value = "";
        this.attributes = {};
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    fire(name) { this.listeners[name]?.(); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this[name]; }
}

function harness() {
    const nodes = new Map();
    const get = selector => {
        if (!nodes.has(selector)) nodes.set(selector, new Element());
        return nodes.get(selector);
    };
    const access = name => get("[data-sc-" + name + "]");
    const root = new Element();
    const modes = ["diff", "overlay"].map(scMode => Object.assign(new Element(), {dataset: {scMode}}));
    root.querySelector = get;
    root.querySelectorAll = () => modes;
    root.dataset.workerUrl = "/static/js/screenshots_worker.js";
    access("result").hidden = true;
    access("threshold").value = "0";
    access("weight").value = "50";
    access("run").disabled = true;
    access("save").disabled = true;
    const posts = [];
    const downloads = [];
    const revoked = [];
    const blobs = new Map();
    const window = new Element();
    let liveWorker;
    window.setTimeout = callback => callback();
    const document = {
        querySelector: () => root,
        createElement: tag => ({
            click() {
                assert.equal(tag, "a");
                downloads.push({filename: this.download, blob: blobs.get(this.href)});
            },
        }),
    };
    class Worker {
        constructor(url) {
            assert.equal(url, root.dataset.workerUrl);
            assert.equal(liveWorker, undefined);
            liveWorker = this;
        }
        postMessage(message) { posts.push(message); }
        terminate() { liveWorker = undefined; }
    }
    const URL = {
        createObjectURL(blob) {
            const url = "blob:" + (blobs.size + 1);
            blobs.set(url, blob);
            return url;
        },
        revokeObjectURL(url) { revoked.push(url); },
    };
    vm.runInNewContext(readFileSync(join(__dirname, "../static/js/screenshots.js"), "utf8"), {document, window, Worker, URL});
    function choose(side, name) {
        const input = get('[data-sc-file="' + side + '"]');
        input.files = [{name, size: 125}];
        input.fire("change");
    }
    function reply(id, result, type = "done") {
        liveWorker.onmessage({data: {id, type, result}});
    }
    function inspected(id, width = 2, height = 3) {
        reply(id, {width, height, thumbnail: new Blob(["thumbnail"])});
    }
    return {access, modes, choose, inspected, reply, posts, downloads, revoked, window};
}

test("file inspection is serial and incompatible oriented sizes show both geometries", () => {
    const h = harness();
    h.choose("left", "left.jpg");
    h.choose("right", "right.png");
    assert.equal(h.posts.length, 1);
    h.inspected(h.posts[0].id, 3, 2);
    assert.equal(h.posts.length, 2);
    h.inspected(h.posts[1].id, 2, 3);
    assert.match(h.access("status").textContent, /3 × 2.*2 × 3/);
    assert.equal(h.access("run").disabled, true);
    assert.equal(h.access("save").disabled, true);
});

test("changing a mode and replacing an input suppress stale PNGs and keep a single physical job", () => {
    const h = harness();
    h.choose("left", "left.png");
    h.inspected(h.posts.at(-1).id);
    h.choose("right", "right.jpg");
    h.inspected(h.posts.at(-1).id);
    assert.equal(h.access("run").disabled, false);
    h.access("run").fire("click");
    const diff = h.posts.at(-1);
    h.modes[1].fire("click");
    assert.equal(h.posts.at(-1).type, "cancel");
    assert.equal(h.posts.at(-1).id, diff.id);
    assert.equal(h.posts.filter(post => post.type === "compare").length, 1);
    assert.equal(h.access("save").disabled, true);
    const stale = {width: 2, height: 3, changed: 1, png: new Blob(["stale"], {type: "image/png"})};
    h.reply(diff.id, stale);
    const overlay = h.posts.at(-1);
    assert.equal(overlay.type, "compare");
    assert.equal(overlay.mode, "overlay");
    const png = new Blob(["current"], {type: "image/png"});
    h.reply(overlay.id, {...stale, png});
    assert.match(h.access("count").textContent, /1 из 6.*16,67/);
    h.access("save").fire("click");
    assert.deepEqual(h.downloads, [{filename: "screenshot-overlay.png", blob: png}]);
    assert.equal(h.revoked.length, 1);
    const input = h.access("weight");
    input.value = "67";
    input.fire("input");
    assert.equal(h.access("save").disabled, true);
    assert.equal(h.access("output").hidden, true);
    input.fire("change");
    const revised = h.posts.at(-1);
    assert.equal(revised.weight, 67);
    h.choose("right", "replacement.png");
    assert.equal(h.posts.at(-1).type, "cancel");
    assert.equal(h.posts.at(-1).id, revised.id);
    h.reply(revised.id, stale);
    assert.equal(h.posts.at(-1).type, "inspect");
    h.access("save").fire("click");
    assert.equal(h.downloads.length, 1);
    assert.equal(h.access("result").hidden, true);
    h.window.fire("pagehide");
    assert.ok(h.revoked.length >= 4);
});
