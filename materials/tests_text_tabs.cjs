const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

class Element {
    constructor(name, type) { this.dataset = {[type]: name}; this.hidden = false; this.tabIndex = 0; this.handlers = {}; this.attributes = {}; }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    fire(name, key) { for (const handler of this.handlers[name] || []) handler({key, preventDefault() {}}); }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
}

function harness(saved) {
    const tabs = [new Element("spelling", "textTab"), new Element("compare", "textTab")];
    const panels = [new Element("spelling", "textPanel"), new Element("compare", "textPanel")];
    const state = {value: saved, writes: []};
    const root = {querySelectorAll(selector) { return selector === "[data-text-tab]" ? tabs : panels; }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/text_tabs.js"), "utf8"), {
        document: {querySelector(selector) { return selector === "[data-text-tool]" ? root : null; }},
        localStorage: {getItem() { return state.value; }, setItem(_key, value) { state.writes.push(value); state.value = value; }},
    });
    return {tabs, panels, state};
}

test("spelling starts first, switching keeps panels intact and stores only tab choice", () => {
    const h = harness(null);
    assert.equal(h.panels[0].hidden, false);
    assert.equal(h.panels[1].hidden, true);
    h.tabs[1].fire("click");
    assert.equal(h.panels[0].hidden, true);
    assert.equal(h.panels[1].hidden, false);
    assert.deepEqual(h.state.writes, ["spelling", "compare"]);
    h.tabs[1].fire("keydown", "ArrowLeft");
    assert.equal(h.tabs[0].focused, true);
    assert.equal(h.panels[0].hidden, false);
});

test("saved compare preference opens compare without processing text", () => {
    const h = harness("compare");
    assert.equal(h.panels[1].hidden, false);
    assert.equal(h.tabs[1].attributes["aria-selected"], "true");
});
