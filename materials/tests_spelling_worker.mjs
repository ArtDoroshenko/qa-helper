import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import vm from "node:vm";
import {lookupWord, tokenize} from "../frontend/spelling_tokenizer.mjs";

test("tokenizer excludes technical values and reports mixed and untested scripts with original offsets", () => {
    const source = "😀 Превет don't привет-мир abcПривет Ελληνικά https://example.com/a email@x.com " +
        "550e8400-e29b-41d4-a716-446655440000 qa_42 qa-1042 fooBar 2026-10-05 `wrong`";
    const found = tokenize(source);
    assert.deepEqual(found.tokens.map(item => item.value), ["Превет", "don't", "привет-мир"]);
    assert.deepEqual(found.mixed.map(item => item.value), ["abcПривет"]);
    assert.deepEqual(found.unchecked.map(item => item.value), ["Ελληνικά"]);
    assert.equal(source.slice(found.tokens[0].start, found.tokens[0].end), "Превет");
    assert.equal(found.tokens[0].start, 3);
    assert.ok(found.skippedCount >= 5);
    assert.equal(lookupWord("е\u0308жик‑test’s"), "ёжик-test's");
});

test("Unicode and punycode email domains are excluded as complete technical fragments", () => {
    const found = tokenize("Привет user@пример.рф qa@例子.公司 name@xn--e1afmkfd.xn--p1ai hello");
    assert.deepEqual(found.tokens.map(item => item.value), ["Привет", "hello"]);
    assert.deepEqual(found.mixed, []);
    assert.deepEqual(found.unchecked, []);
    assert.ok(found.skippedCount >= 3);
});

test("long unfinished technical fragments stay within the worker time budget", () => {
    const cases = [
        "a".repeat(20000),
        "a".repeat(19999) + "@",
        "a".repeat(19999) + "/",
        "a".repeat(19999) + "A",
    ];
    for (const source of cases) {
        const started = performance.now();
        tokenize(source);
        assert.ok(performance.now() - started < 1500, "Tokenization took too long for a 20k-character input");
    }
});

test("real local RU and EN-US dictionaries check words and produce lazy suggestions", async () => {
    const messages = [];
    const previousSelf = globalThis.self, previousFetch = globalThis.fetch;
    const root = new URL("../static/vendor/spelling/", import.meta.url);
    globalThis.self = {location: {href: "http://localhost/static/js/spelling_worker.js"}, postMessage(value) { messages.push(value); }};
    globalThis.fetch = async url => {
        const basename = new URL(url).pathname.split("/").at(-1);
        const data = await readFile(fileURLToPath(new URL(basename, root)));
        return {ok: true, async arrayBuffer() { return data; }};
    };
    try {
        await import("../frontend/spelling_worker.mjs");
        await globalThis.self.onmessage({data: {id: 1, type: "check", text: "Привет hello Превет tehst abcПривет Ελληνικά"}});
        const result = messages[0].result;
        assert.equal(messages[0].ok, true, JSON.stringify(messages[0]));
        assert.deepEqual(result.issues.map(item => [item.value, item.kind]), [
            ["Превет", "unknown"], ["tehst", "unknown"], ["abcПривет", "mixed"],
        ]);
        assert.equal(result.uncheckedCount, 1);
        await globalThis.self.onmessage({data: {id: 4, type: "check", text: "color colour"}});
        assert.deepEqual(messages[1].result.issues.map(item => item.value), ["colour"]);
        await globalThis.self.onmessage({data: {id: 2, type: "suggest", language: "ru", word: "Превет"}});
        assert.equal(messages[2].ok, true);
        assert.ok(messages[2].result.suggestions.length <= 5);
        await globalThis.self.onmessage({data: {id: 3, type: "check", text: "a".repeat(20001)}});
        assert.equal(messages[3].ok, false);
        assert.match(messages[3].error, /20 000/);
    } finally {
        globalThis.self = previousSelf;
        globalThis.fetch = previousFetch;
    }
});

test("built classic worker runs without a module loader and uses same-origin assets", async () => {
    const code = await readFile(new URL("../static/js/spelling_worker.js", import.meta.url), "utf8");
    const messages = [], urls = [];
    const self = {location: {href: "https://qa.example/static/js/spelling_worker.js"}, postMessage(value) { messages.push(value); }};
    const context = {
        self, URL, TextDecoder,
        async fetch(url) {
            urls.push(String(url));
            const basename = new URL(url).pathname.split("/").at(-1);
            const data = await readFile(fileURLToPath(new URL(basename, new URL("../static/vendor/spelling/", import.meta.url))));
            return {ok: true, async arrayBuffer() { return data; }};
        },
    };
    vm.runInNewContext(code, context);
    await self.onmessage({data: {id: 9, type: "check", text: "Ελληνικά"}});
    assert.equal(messages[0].result.uncheckedCount, 1);
    assert.equal(messages[0].result.checkedCount, 0);
    assert.equal(urls.length, 0);
    await self.onmessage({data: {id: 10, type: "check", text: "Превет hello"}});
    assert.equal(messages[1].ok, true, messages[1].error);
    assert.equal(messages[1].result.issues[0].value, "Превет");
    assert.ok(urls.every(url => url.startsWith("https://qa.example/static/vendor/spelling/")));
});
