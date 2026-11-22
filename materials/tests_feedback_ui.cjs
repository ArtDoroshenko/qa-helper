const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

class Element {
    constructor() {
        this.disabled = true;
        this.listeners = {};
        this.classList = {toggle() {}};
        this.focuses = 0;
    }
    addEventListener(event, listener) { this.listeners[event] = listener; }
    fire(event, details = {}) { return this.listeners[event]?.(details); }
    focus() { this.focuses++; }
}

function harness({supportsDialog = true} = {}) {
    const dialog = new Element();
    const form = new Element();
    const trigger = new Element();
    const send = new Element();
    const close = new Element();
    const status = new Element();
    const kind = Object.assign(new Element(), {value: "idea", disabled: false});
    const message = Object.assign(new Element(), {value: "Черновик из поля", disabled: false});
    const fields = {kind, message};
    form.elements = {namedItem: name => fields[name]};
    form.action = "http://example.test/feedback/";
    let resets = 0;
    form.reset = () => {
        resets++;
        kind.value = "bug";
        message.value = "";
    };
    dialog.open = false;
    if (supportsDialog) dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.fire("close"); };
    dialog.querySelector = selector => ({
        form, "[data-feedback-send]": send, "[data-feedback-close]": close, "[data-feedback-status]": status,
    })[selector];
    const requests = [];
    const replies = [];
    class BrowserFormData {
        constructor(source) {
            assert.equal(source, form);
            assert.equal(kind.disabled, false);
            assert.equal(message.disabled, false);
        }
        *[Symbol.iterator]() {
            yield ["csrfmiddlewaretoken", "csrf-fixture"];
            yield ["page", "json_tool"];
            yield ["kind", kind.value];
            yield ["message", message.value];
        }
    }
    const script = readFileSync(join(__dirname, "../static/js/feedback.js"), "utf8");
    vm.runInNewContext(script, {
        URLSearchParams, FormData: BrowserFormData,
        document: {
            getElementById: id => id === "feedback-dialog" ? dialog : null,
            querySelectorAll: () => [trigger],
        },
        fetch: async (url, options) => {
            requests.push({url, options});
            return replies.shift();
        },
    });
    const submit = () => form.fire("submit", {preventDefault() { return true; }});
    return {dialog, trigger, send, close, status, kind, message, requests, replies, submit, resets: () => resets};
}

test("dialog is enabled only when available and restores focus after either close path", () => {
    const unsupported = harness({supportsDialog: false});
    assert.equal(unsupported.trigger.disabled, true);
    assert.equal(unsupported.send.disabled, true);
    const h = harness();
    assert.equal(h.dialog.open, false);
    assert.equal(h.trigger.disabled, false);
    h.trigger.fire("click");
    assert.equal(h.dialog.open, true);
    assert.equal(h.kind.focuses, 1);
    h.close.fire("click");
    assert.equal(h.dialog.open, false);
    assert.equal(h.trigger.focuses, 1);
    h.trigger.fire("click");
    h.dialog.close(); // The browser dispatches the same close event after Escape.
    assert.equal(h.trigger.focuses, 2);
});

test("feedback posts clear field names and CSRF to the same origin, keeps the draft on failure and resets on success", async () => {
    const h = harness();
    h.trigger.fire("click");
    for (const statusCode of [429, 503]) {
        h.replies.push({ok: false, status: statusCode, json: async () => ({ok: false, error: "Попробуйте позже."})});
        await h.submit();
        assert.equal(h.kind.value, "idea");
        assert.equal(h.message.value, "Черновик из поля");
        assert.equal(h.resets(), 0);
        assert.equal(h.status.textContent, "Попробуйте позже.");
        assert.equal(h.dialog.open, true);
    }
    const {url, options} = h.requests[0];
    assert.equal(url, "http://example.test/feedback/");
    assert.equal(options.method, "POST");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.referrerPolicy, "same-origin");
    assert.ok(options.body instanceof URLSearchParams);
    assert.deepEqual(Object.fromEntries(options.body), {
        csrfmiddlewaretoken: "csrf-fixture", page: "json_tool", kind: "idea", message: "Черновик из поля",
    });

    let finish;
    h.replies.push(new Promise(resolve => { finish = resolve; }));
    const pending = h.submit();
    assert.equal(h.send.disabled, true);
    await h.submit();
    assert.equal(h.requests.length, 3);
    finish({ok: true, json: async () => ({ok: true})});
    await pending;
    assert.equal(h.resets(), 1);
    assert.equal(h.message.value, "");
    assert.equal(h.status.textContent, "Сообщение отправлено.");
    assert.equal(h.dialog.open, true);
    assert.equal(h.send.disabled, false);
});
