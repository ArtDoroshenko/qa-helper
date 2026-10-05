const assert = require("node:assert/strict");
const {test} = require("node:test");
const core = require("../static/js/spelling_core.js");

const source = "Превет и превет! This is a tehst.\nAPI stays.";
const issues = [
    {id: 0, start: 0, end: 6, value: "Превет", suggestions: ["Привет"]},
    {id: 9, start: 9, end: 15, value: "превет", suggestions: ["привет"]},
    {id: 27, start: 27, end: 32, value: "tehst", suggestions: ["test"]},
];

test("20,000 Unicode code points are accepted without truncating astral characters", () => {
    const value = "😀".repeat(20000);
    assert.equal(core.validate(value), 20000);
    assert.throws(() => core.validate(value + "x"), /20 000.*не обрезан/);
    assert.equal(value.length, 40000);
});

test("one chosen replacement changes one occurrence and leaves source intact", () => {
    const session = core.createSession(source, issues);
    session.decide(0, {type: "replace", replacement: "Привет"});
    assert.equal(session.build(), "Привет и превет! This is a tehst.\nAPI stays.");
    assert.equal(session.source, source);
    assert.deepEqual(session.appliedIds, [0]);
    assert.equal(session.stale, false);
});

test("skip-all matches exact case and language only within this session", () => {
    const session = core.createSession(source, issues);
    session.skipAll(0);
    assert.equal(session.decisions.get(0).type, "skip");
    assert.equal(session.decisions.has(9), false);
    assert.equal(session.decisions.has(27), false);
    assert.equal(session.build(), source);
    assert.equal(core.createSession(source, issues).decisions.size, 0);
});

test("post-build decision marks output stale; undo does not apply a new choice", () => {
    const session = core.createSession(source, issues);
    session.decide(0, {type: "replace", replacement: "Привет"});
    session.build();
    session.decide(27, {type: "replace", replacement: "test"});
    assert.equal(session.stale, true);
    assert.equal(session.undo(0), source);
    assert.equal(session.stale, true);
    assert.equal(session.appliedIds.length, 0);
    assert.equal(session.build(), "Превет и превет! This is a test.\nAPI stays.");
    assert.equal(session.stale, false);
});

test("undo-last follows decision order; reset and invalid positions are safe", () => {
    const session = core.createSession(source, issues);
    session.decide(27, {type: "replace", replacement: "test"});
    session.decide(0, {type: "replace", replacement: "Привет"});
    session.build();
    assert.deepEqual(session.appliedIds, [27, 0]);
    assert.equal(session.undoLast(), "Превет и превет! This is a test.\nAPI stays.");
    assert.equal(session.reset(), source);
    assert.deepEqual(session.appliedIds, []);
    assert.throws(() => core.createSession(source, [{id: 1, start: 1, end: 6, value: "wrong", suggestions: []}]), /позиции/);
    assert.throws(() => core.createSession(source, [{id: 0, start: 0, end: 6, value: "Превет"}]), /позиции/);
});
