const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {compare, MAX_BYTES, MAX_REPORT_BYTES} = require("../static/js/json_compare_worker.js");

test("object order and formatting do not matter; large and decimal numbers stay exact", () => {
    const equal = compare(
        '{ "n":9007199254740993, "exp":1e3, "zero":-0, "nested":{"a":1.00} }',
        '{"nested":{"a":1},"zero":0.0,"exp":1000.0,"n":9007199254740993.0}',
    );
    assert.equal(equal.equal, true);
    assert.deepEqual(equal.counts, {added: 0, removed: 0, changed: 0});
    const unequal = compare('{"n":9007199254740993}', '{"n":9007199254740992}');
    assert.equal(unequal.changes[0].path, '$["n"]');
    assert.equal(unequal.changes[0].before.json, "9007199254740993");
    assert.equal(unequal.changes[0].after.json, "9007199254740992");
});

test("types, missing values, null and array positions have distinct results", () => {
    const result = compare(
        '{"id":1,"removed":null,"array":[true,"x"]}',
        '{"id":"1","added":null,"array":[false,"x",null]}',
    );
    assert.deepEqual(result.counts, {added: 2, removed: 1, changed: 2});
    assert.deepEqual(result.changes.map(change => [change.type, change.path]), [
        ["changed", '$["id"]'], ["removed", '$["removed"]'],
        ["changed", '$["array"][0]'], ["added", '$["array"][2]'],
        ["added", '$["added"]'],
    ]);
    assert.deepEqual(result.changes[1].before, {present: true, json: "null"});
    assert.deepEqual(result.changes[1].after, {present: false});
    assert.deepEqual(result.changes[4].before, {present: false});
    assert.deepEqual(result.changes[4].after, {present: true, json: "null"});
});

test("decoded duplicate keys and invalid input identify the side and position", () => {
    assert.throws(() => compare('{}', '{\n "a":1, "\\u0061":2}'), error =>
        error.side === "right" && error.line === 2 && error.column === 9 && /Повтор ключа/.test(error.message));
    assert.throws(() => compare('{"x":}', '{}'), error =>
        error.side === "left" && error.line === 1 && error.column === 6);
    assert.throws(() => compare('{}', ''), error =>
        error.side === "right" && error.line === 1 && error.column === 1);
});

test("2 MiB per side, depth 100 and 20,000 changes are exact boundaries", () => {
    const validSize = `"${"a".repeat(MAX_BYTES - 2)}"`;
    assert.equal(compare(validSize, validSize).equal, true);
    assert.throws(() => compare(validSize + " ", "0"), error => error.side === "left" && /2 МиБ/.test(error.message));
    const depth100 = `${"[".repeat(100)}0${"]".repeat(100)}`;
    assert.equal(compare(depth100, depth100).equal, true);
    assert.throws(() => compare(`${"[".repeat(101)}0${"]".repeat(101)}`, "0"), /100 уровней/);
    const array = count => `[${Array.from({length: count}, (_, i) => i).join(",")}]`;
    const twentyThousand = compare("[]", array(20000));
    assert.equal(twentyThousand.changes.length, 20000);
    assert.equal(JSON.parse(twentyThousand.report).changes.length, 20000);
    assert.throws(() => compare("[]", array(20001)), /20 000/);
});

test("full report includes all paths and original number tokens", () => {
    const right = `{${Array.from({length: 12}, (_, i) => `"k${i}":1e${i}`).join(",")}}`;
    const result = compare("{}", right);
    const exported = JSON.parse(result.report);
    assert.equal(exported.changes.length, 12);
    assert.equal(exported.changes[11].path, '$["k11"]');
    assert.equal(exported.changes[11].after.json, "1e11");
    assert.equal(exported.changes[11].before.present, false);
});

test("worker messaging returns one complete result or one error without a partial report", () => {
    const messages = [];
    const self = {postMessage(message) { messages.push(message); }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../static/js/json_compare_worker.js"), "utf8"),
        {self, TextEncoder});
    self.onmessage({data: {id: 7, left: "{}", right: '{"x":null}'}});
    assert.equal(messages[0].id, 7);
    assert.equal(messages[0].ok, true);
    assert.equal(JSON.parse(messages[0].result.report).changes.length, 1);
    self.onmessage({data: {id: 8, left: "{}", right: '{"x":1,"x":2}'}});
    assert.equal(messages[1].ok, false);
    assert.equal(messages[1].error.side, "right");
    assert.equal(Object.hasOwn(messages[1], "result"), false);
});

test("long paths repeated across changes fail at 32 MiB without a partial report", () => {
    const key = "x".repeat(9000);
    const left = `{${JSON.stringify(key)}:[]}`;
    const right = `{${JSON.stringify(key)}:[${Array(5000).fill("0").join(",")}]}`;
    assert.throws(() => compare(left, right), /32 МиБ.*не сформирован/);
});

test("full report accepts exactly 32 MiB UTF-8 and rejects one byte more", () => {
    const count = 4096;
    const makeRight = (keyLength, last) =>
        `{${JSON.stringify("x".repeat(keyLength))}:[${Array(count - 1).fill("0").join(",")},${last}]}`;
    const makeLeft = keyLength => `{${JSON.stringify("x".repeat(keyLength))}:[]}`;
    const baseline = Buffer.byteLength(compare(makeLeft(1), makeRight(1, "0")).report, "utf8");
    const keyLength = Math.floor((MAX_REPORT_BYTES - baseline) / count) + 1;
    const residual = MAX_REPORT_BYTES - (baseline + (keyLength - 1) * count);
    const atLimit = compare(makeLeft(keyLength), makeRight(keyLength, `1${"0".repeat(residual)}`));
    assert.equal(Buffer.byteLength(atLimit.report, "utf8"), MAX_REPORT_BYTES);
    assert.throws(() => compare(makeLeft(keyLength), makeRight(keyLength, `1${"0".repeat(residual + 1)}`)), /32 МиБ/);
});
