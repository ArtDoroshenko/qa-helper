const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const core = require("../static/js/text_compare_core.js");

test("insertions, removals and changed lines retain original line numbers and full export", () => {
    const result = core.compare("header\nold\nkeep\nremove\nend", "header\nnew\nkeep\nend\nadded");
    assert.deepEqual(result.counts, {added: 1, removed: 1, modified: 1});
    assert.deepEqual(result.changes.map(item => [item.kind, item.leftNumber, item.rightNumber]), [
        ["modified", 2, 2], ["removed", 4, null], ["added", null, 5],
    ]);
    assert.match(core.report(result), /Строка 4: remove/);
    assert.match(core.report(result), /Строка 5: added/);
});

test("independent case/trailing options, CRLF and Unicode case leave source untouched", () => {
    const left = "ПрИвЕт  \r\nend", right = "привет\nend";
    assert.equal(core.compare(left, right).counts.modified, 1);
    assert.equal(core.compare(left, right, {ignoreCase: true}).counts.modified, 1);
    assert.equal(core.compare(left, right, {ignoreTrailing: true}).counts.modified, 1);
    assert.equal(core.compare(left, right, {ignoreCase: true, ignoreTrailing: true}).changes.length, 0);
    assert.equal(left, "ПрИвЕт  \r\nend");
    assert.deepEqual(core.compare("a\r\nb", "a\nb").counts, {added: 0, removed: 0, modified: 0});
});

test("one empty side is allowed, two empty sides fail, literal HTML remains data", () => {
    assert.deepEqual(core.compare("", "<img src=x>\nnext").counts, {added: 2, removed: 0, modified: 0});
    assert.deepEqual(core.compare("old", "").counts, {added: 0, removed: 1, modified: 0});
    assert.throws(() => core.compare("", ""), /хотя бы на одной/);
    assert.match(core.report(core.compare("", "<img src=x>")), /<img src=x>/);
});

test("UTF-8 byte and logical-line boundaries are enforced without truncation", () => {
    assert.equal(core.prepare("я".repeat(core.MAX_BYTES / 2)).lines.length, 1);
    assert.throws(() => core.prepare("я".repeat(core.MAX_BYTES / 2 + 1)), /2 МиБ/);
    assert.equal(core.prepare("x\n".repeat(core.MAX_LINES - 1)).lines.length, core.MAX_LINES);
    assert.throws(() => core.prepare("x\n".repeat(core.MAX_LINES)), /20 000/);
});

test("many repeated lines finish with bounded alignment and complete differences", () => {
    const left = Array(20000).fill("same").join("\n");
    const right = Array(20000).fill("other").join("\n");
    const result = core.compare(left, right);
    assert.equal(result.changes.length, 20000);
    assert.equal(result.counts.modified, 20000);
});

test("worker returns a complete success or error", () => {
    const messages = [];
    const self = {postMessage(message) { messages.push(message); }};
    const context = {self, TextEncoder, importScripts() { context.QATextCompareCore = core; self.QATextCompareCore = core; }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/text_compare_worker.js"), "utf8"), context);
    self.onmessage({data: {left: "a", right: "b", options: {}}});
    assert.equal(messages[0].ok, true);
    assert.equal(messages[0].result.changes[0].kind, "modified");
    self.onmessage({data: {left: "", right: "", options: {}}});
    assert.equal(messages[1].ok, false);
    assert.equal(Object.hasOwn(messages[1], "result"), false);
});
