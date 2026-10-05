const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

function harness() {
    const workers = [], timers = new Map(); let timerId = 0, engine;
    const panel = {}, page = {dataset: {spellingWorkerUrl: "/static/js/spelling_worker.js"},
        querySelector(selector) { return selector === "[data-spelling-tool]" ? panel : null; }};
    class Worker {
        constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
        postMessage(value) { this.sent = value; }
        terminate() { this.terminated = true; }
        respond(result) { this.respondTo(this.sent.id, result); }
        respondTo(id, result) { this.onmessage({data: {id, ok: true, result}}); }
    }
    const context = {
        document: {querySelector(selector) { return selector === "[data-text-tool]" ? page : null; }},
        globalThis: {QASpellingUI: {mount(_panel, value) { engine = value; }}}, Worker,
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/spelling_engine.js"), "utf8"), context);
    return {workers, timers, get engine() { return engine; }};
}

test("worker starts only on demand and abort drops stale work", async () => {
    const h = harness();
    assert.equal(h.workers.length, 0);
    const controller = new AbortController();
    const first = h.engine.check("Превет", {signal: controller.signal});
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].sent.type, "check");
    controller.abort();
    await assert.rejects(first, /отменена/);
    assert.equal(h.workers[0].terminated, true);
    h.workers[0].respond({issues: []});
    const second = h.engine.check("Привет");
    assert.equal(h.workers.length, 2);
    h.workers[1].respond({issues: [], uncheckedCount: 0, skippedCount: 0});
    assert.deepEqual(await second, {issues: [], uncheckedCount: 0, skippedCount: 0});
});

test("suggestions use the same worker and timeout reports failure", async () => {
    const h = harness();
    const check = h.engine.check("tehst");
    h.workers[0].respond({issues: []});
    await check;
    const suggest = h.engine.suggest({language: "en", value: "tehst"});
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].sent.type, "suggest");
    h.workers[0].respond({suggestions: ["test"]});
    assert.deepEqual(await suggest, {suggestions: ["test"]});
    const stalled = h.engine.check("word");
    [...h.timers.values()][0]();
    await assert.rejects(stalled, /слишком долго/);
    assert.equal(h.workers[0].terminated, true);
});

test("closing suggestions ignores their answer and reopens without reloading the worker", async () => {
    const h = harness();
    const controller = new AbortController();
    const closed = h.engine.suggest({language: "en", value: "tehst"}, {signal: controller.signal});
    const worker = h.workers[0], oldId = worker.sent.id;
    controller.abort();
    await assert.rejects(closed, /отменён/);
    assert.equal(worker.terminated, false);
    worker.respondTo(oldId, {suggestions: ["stale"]});
    const reopened = h.engine.suggest({language: "en", value: "tehst"});
    assert.equal(h.workers.length, 1);
    worker.respond({suggestions: ["test"]});
    assert.deepEqual(await reopened, {suggestions: ["test"]});
});
