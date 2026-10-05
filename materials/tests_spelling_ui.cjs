const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const core = require("../static/js/spelling_core.js");

class Element {
    constructor(tag = "div") {
        this.tag = tag; this.value = ""; this.textContent = ""; this.hidden = false;
        this.disabled = false; this.children = []; this.handlers = {}; this.attributes = {};
        this.classList = {toggle() {}}; this.focused = false;
    }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name) { for (const handler of this.handlers[name] || []) await handler({target: this}); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    append(...children) {
        for (const child of children) {
            if (child.tag === "fragment") this.append(...child.children);
            else { child.parent = this; this.children.push(child); }
        }
    }
    replaceWith(node) {
        const siblings = this.parent.children, index = siblings.indexOf(this);
        node.parent = this.parent;
        siblings.splice(index, 1, node);
    }
    querySelector(selector) { return selector === "button" ? this.children.find(child => child.tag === "button") : null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
}

function harness(engine, inputValue = "<b>Превет</b> превет") {
    const root = new Element(), elements = {}, clipboard = {value: null, async writeText(value) { this.value = value; }};
    const stats = {created: 0, sourceBatchSizes: [], sourceReplacements: 0};
    const names = "input source output counter check build edit copy status result-status choices suggestions choice-title context undo-bar example close keep unselect skip-all undo reset";
    for (const name of names.split(" ")) elements[name] = new Element();
    root.querySelector = selector => elements[selector.match(/^\[data-spelling-(.+)\]$/)[1]];
    elements.input.value = inputValue;
    const appendSource = elements.source.append.bind(elements.source);
    elements.source.append = (...children) => {
        stats.sourceBatchSizes.push(children.reduce((size, child) => size + (child.tag === "fragment" ? child.children.length : 1), 0));
        appendSource(...children);
    };
    const replaceSource = elements.source.replaceChildren.bind(elements.source);
    elements.source.replaceChildren = (...children) => { stats.sourceReplacements++; replaceSource(...children); };
    const doc = {
        createElement(tag) { stats.created++; return new Element(tag); },
        createDocumentFragment() { return new Element("fragment"); },
        createTextNode(value) { return {tag: "text", value}; },
    };
    const globals = {QASpellingCore: core};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/spelling_ui.js"), "utf8"), {
        globalThis: globals, document: doc, navigator: {clipboard}, AbortController, setTimeout,
    });
    const mounted = globals.QASpellingUI.mount(root, engine);
    return {e: elements, clipboard, mounted, stats};
}

const issues = [
    {id: 3, start: 3, end: 9, value: "Превет", suggestions: ["Привет"]},
    {id: 14, start: 14, end: 20, value: "превет", suggestions: ["привет"]},
];
const checked = {issues, checkedCount: 2, skippedCount: 0, uncheckedCount: 0};
const engine = {async check() { return checked; }, async suggest(issue) { return {suggestions: issue.value[0] === "П" ? ["Привет"] : ["привет"]}; }};

test("UI needs a real engine and the public page loads the spelling integration", () => {
    assert.throws(() => harness(null), /движок/);
    const publicTemplate = fs.readFileSync(path.join(__dirname, "../templates/materials/text_tool.html"), "utf8");
    assert.match(publicTemplate, /materials\/_spelling_panel\.html/);
    assert.match(publicTemplate, /js\/spelling_engine\.js/);
});

test("source view uses text nodes; selected replacement is local and copy is plain text", async () => {
    const h = harness(engine), e = h.e;
    await e.check.fire("click");
    assert.equal(e.input.hidden, true);
    assert.equal(e.source.hidden, false);
    assert.equal(e.source.children[0].value, "<b>");
    const buttons = e.source.children.filter(child => child.tag === "button");
    assert.equal(buttons.length, 2);
    await buttons[0].fire("click");
    assert.equal(e.suggestions.children[0].focused, true);
    await e.suggestions.children[0].fire("click");
    await e.build.fire("click");
    assert.equal(h.mounted.session.output, "<b>Привет</b> превет");
    assert.equal(e.copy.disabled, false);
    await e.copy.fire("click");
    assert.equal(h.clipboard.value, "<b>Привет</b> превет");
    assert.equal(e.output.children[0].value, "<b>");
    assert.equal(e.output.children[1].tag, "button");
    assert.match(e.output.children[1].attributes["aria-label"], /Отменить замену/);
});

test("new choice makes formed result stale; undo leaves pending choice unapplied", async () => {
    const h = harness(engine), e = h.e;
    await e.check.fire("click");
    await e.source.children.filter(child => child.tag === "button")[0].fire("click");
    await e.suggestions.children[0].fire("click");
    await e.build.fire("click");
    await e.source.children.filter(child => child.tag === "button")[1].fire("click");
    await e.suggestions.children[0].fire("click");
    assert.equal(e.copy.disabled, true);
    assert.match(e["result-status"].textContent, /обновления/);
    await e.undo.fire("click");
    assert.equal(h.mounted.session.output, "<b>Превет</b> превет");
    assert.equal(e.copy.disabled, true);
    await e.build.fire("click");
    assert.equal(h.mounted.session.output, "<b>Превет</b> привет");
});

test("editing cancels pending check and old response cannot restore remarks", async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({check() { return pending; }, suggest: engine.suggest}), e = h.e;
    const running = e.check.fire("click");
    e.input.value = "другой текст";
    await e.input.fire("input");
    finish(checked);
    await running;
    assert.equal(h.mounted.session, null);
    assert.equal(e.source.hidden, true);
    assert.equal(e.input.value, "другой текст");
    e.input.value = "😀".repeat(20001);
    await e.input.fire("input");
    assert.equal(e.check.disabled, true);
    assert.equal(e.input.value.length, 40002);
});

test("many issues render in batches and a choice updates only existing issue nodes", async () => {
    const count = 3000, source = "x ".repeat(count);
    const many = Array.from({length: count}, (_, index) => ({
        id: index * 2, start: index * 2, end: index * 2 + 1, value: "x", suggestions: [], language: "en",
    }));
    const h = harness({
        async check() { return {issues: many, checkedCount: count, skippedCount: 0, uncheckedCount: 0}; },
        async suggest() { return {suggestions: ["y"]}; },
    }, source);
    await h.e.check.fire("click");
    const buttons = h.e.source.children.filter(child => child.tag === "button");
    assert.equal(buttons.length, count);
    assert.ok(h.stats.sourceBatchSizes.length > 1);
    assert.ok(Math.max(...h.stats.sourceBatchSizes) <= 201);
    const created = h.stats.created, replacements = h.stats.sourceReplacements;
    await buttons[0].fire("click");
    await h.e.suggestions.children[0].fire("click");
    assert.equal(h.stats.created, created + 1); // Only the suggestion button was created.
    assert.equal(h.stats.sourceReplacements, replacements);
    assert.equal(h.e.source.children[1], buttons[0]);
    assert.equal(h.e.source.children[3], buttons[1]);
    await h.e.build.fire("click");
    await h.e.undo.fire("click");
    assert.equal(h.stats.sourceReplacements, replacements);
    assert.equal(h.e.source.children[1], buttons[0]);
    await buttons[1].fire("click");
    await h.e["skip-all"].fire("click");
    assert.equal(h.stats.sourceReplacements, replacements);
    assert.equal(h.e.source.children[1], buttons[0]);
    assert.equal(h.e.source.children[3], buttons[1]);
    assert.match(buttons[count - 1].className, /spelling-skip/);
});

test("partial result is inert; a new choice stays stale and reset cancels rendering", async () => {
    const count = 101, source = "x ".repeat(count);
    const many = Array.from({length: count}, (_, index) => ({
        id: index * 2, start: index * 2, end: index * 2 + 1, value: "x", suggestions: ["y"], language: "en",
    }));
    const h = harness({
        async check() { return {issues: many, checkedCount: count, skippedCount: 0, uncheckedCount: 0}; },
        async suggest() { return {suggestions: ["y"]}; },
    }, source);
    await h.e.check.fire("click");
    for (const issue of h.mounted.session.issues) h.mounted.session.decide(issue.id, {type: "replace", replacement: "y"});
    const running = h.e.build.fire("click");
    assert.equal(h.e.output.hidden, true);
    assert.equal(h.e["undo-bar"].hidden, true);
    assert.equal(h.e.build.disabled, true);
    assert.equal(h.e.copy.disabled, true);
    await h.e.output.children.find(child => child.tag === "button").fire("click");
    await h.e.undo.fire("click");
    assert.equal(h.mounted.session.output, "y ".repeat(count));
    await running;
    assert.equal(h.e.output.hidden, false);
    assert.equal(h.e["undo-bar"].hidden, false);
    const changing = h.e.build.fire("click");
    assert.equal(h.e.output.hidden, true);
    await h.e.source.children[1].fire("click");
    await h.e.keep.fire("click");
    await changing;
    assert.equal(h.mounted.session.stale, true);
    assert.equal(h.e.copy.disabled, true);
    assert.match(h.e.status.textContent, /требует обновления/);
    const interrupted = h.e.build.fire("click");
    assert.equal(h.e.output.hidden, true);
    await h.e.reset.fire("click");
    await interrupted;
    assert.equal(h.mounted.session.output, source);
    assert.equal(h.e.output.hidden, false);
    assert.equal(h.e.output.children.length, 1);
    assert.equal(h.e.output.children[0].value, source);
});

test("checking again during a batched result leaves the new session usable", async () => {
    const count = 101, source = "x ".repeat(count);
    const many = Array.from({length: count}, (_, index) => ({
        id: index * 2, start: index * 2, end: index * 2 + 1, value: "x", suggestions: ["y"], language: "en",
    }));
    const h = harness({
        async check() { return {issues: many, checkedCount: count, skippedCount: 0, uncheckedCount: 0}; },
        async suggest() { return {suggestions: ["y"]}; },
    }, source);
    await h.e.check.fire("click");
    for (const issue of h.mounted.session.issues) h.mounted.session.decide(issue.id, {type: "replace", replacement: "y"});
    const oldBuild = h.e.build.fire("click");
    assert.equal(h.e.output.hidden, true);
    await h.e.check.fire("click");
    await oldBuild;
    assert.equal(h.e.output.hidden, false);
    assert.equal(h.e.output.textContent, "Результат появится после формирования.");
    assert.equal(h.e.build.disabled, false);
    assert.equal(h.e["undo-bar"].hidden, true);
    await h.e.build.fire("click");
    assert.equal(h.mounted.session.output, source);
    assert.equal(h.e.copy.disabled, false);
    assert.equal(h.e["result-status"].textContent, "Результат сформирован");
});
