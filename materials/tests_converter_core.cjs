const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createHash, webcrypto} = require("node:crypto");
const {test} = require("node:test");
const vm = require("node:vm");
const core = require("../static/js/converter_core.js");

test("URL percent and form modes apply exactly one pass and keep literal plus distinct", () => {
    assert.equal(core.convertUrl("QA + JSON", "encode", "percent"), "QA%20%2B%20JSON");
    assert.equal(core.convertUrl("QA + JSON", "encode", "form"), "QA+%2B+JSON");
    assert.equal(core.convertUrl("QA+%2B+JSON", "decode", "form"), "QA + JSON");
    assert.equal(core.convertUrl("%2520", "decode", "percent"), "%20");
    assert.throws(() => core.convertUrl("%ZZ", "decode", "percent"), /Некорректная percent/);
    assert.throws(() => core.convertUrl("\ud800", "encode", "percent"), /Unicode/);
    assert.equal(core.convertUrl("x".repeat(core.URL_INPUT_BYTES), "encode", "percent").length, core.URL_INPUT_BYTES);
    assert.throws(() => core.convertUrl("x".repeat(core.URL_INPUT_BYTES + 1), "encode", "percent"), /256 КиБ/);
});

test("date conversion is explicit about units and UTC, with exact milliseconds", () => {
    assert.match(core.convertDate("0", "to-date", "s", "UTC").output, /^1970-01-01 00:00:00\.000 · UTC\n1970-01-01T00:00:00\.000Z · UTC$/);
    assert.match(core.convertDate("1.234", "to-date", "s", "Asia/Tokyo").output, /^1970-01-01 09:00:01\.234 · Asia\/Tokyo/);
    assert.equal(core.convertDate("1969-12-31 23:59:59.999", "to-stamp", "s", "UTC").output, "-0.001");
    assert.equal(core.convertDate("1970-01-01 09:00:01.234", "to-stamp", "ms", "Asia/Tokyo").output, "1234");
    assert.equal(core.convertDate("1969-12-31 19:00:00", "to-stamp", "s", "America/New_York").output, "0");
    assert.throws(() => core.convertDate("1.0001", "to-date", "s", "UTC"), /меньше миллисекунды/);
    assert.throws(() => core.convertDate("1.1", "to-date", "ms", "UTC"), /целым числом/);
    assert.throws(() => core.convertDate("2026-02-30 12:00:00", "to-stamp", "s", "UTC"), /Некорректная дата/);
    assert.throws(() => core.convertDate("0", "to-date", "s", "Europe/Paris"), /поддерживаемый часовой пояс/);
});

test("New York DST gap and overlap reject nonexistent and ambiguous local times", () => {
    assert.throws(() => core.convertDate("2026-03-08 02:30:00", "to-stamp", "s", "America/New_York"), /не существует/);
    assert.throws(() => core.convertDate("2026-11-01 01:30:00", "to-stamp", "s", "America/New_York"), /неоднозначно/);
    assert.equal(core.convertDate("2026-11-01 01:30:00", "to-stamp", "s", "UTC").output,
        String(Date.parse("2026-11-01T01:30:00Z") / 1000));
});

const token = (header, payload, signature = "signature") =>
    `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;

test("JWT decodes Unicode and NumericDate locally without claiming signature validation", () => {
    const jwt = token({alg: "none", typ: "JWT"}, {name: "Анна", exp: 2000, iat: 1000, nbf: "bad"}, "");
    const result = core.decodeJwt(jwt, 1500 * 1000);
    assert.match(result.payload, /Анна/);
    assert.equal(result.expiry, "Срок не истёк");
    assert.equal(result.dates.find(item => item.name === "nbf").text, "Некорректная дата: ожидается NumericDate");
    assert.deepEqual(JSON.parse(result.download).payload, {name: "Анна", exp: 2000, iat: 1000, nbf: "bad"});
    assert.equal(core.decodeJwt(jwt, 2000 * 1000).expiry, "Срок истёк");
    assert.equal(core.decodeJwt(token({}, {})).expiry, "exp отсутствует");
    assert.throws(() => core.decodeJwt("x".repeat(core.JWT_BYTES + 1)), /64 КиБ/);
    assert.throws(() => core.decodeJwt("bad.parts"), /три сегмента/);
    assert.throws(() => core.decodeJwt(`${Buffer.from("not json").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`), /Header: некорректный JSON/);
});

test("hash algorithms match independent vectors and expected hex validation", async () => {
    const source = new TextEncoder().encode("abc");
    for (const algorithm of ["MD5", "SHA-1", "SHA-256", "SHA-512"]) {
        const actual = await core.hashBytes(source, algorithm, webcrypto.subtle);
        const expected = createHash(algorithm.toLowerCase().replace("-", "")).update(source).digest("hex");
        assert.equal(actual, expected);
        assert.equal(core.validateExpectedHex(expected.toUpperCase(), algorithm), expected);
    }
    assert.equal(await core.hashBytes(new TextEncoder().encode(""), "MD5"), "d41d8cd98f00b204e9800998ecf8427e");
    assert.throws(() => core.validateExpectedHex("g".repeat(64), "SHA-256"), /64 hex-символов/);
    assert.throws(() => core.validateExpectedHex("ab", "MD5"), /32 hex-символов/);
    assert.doesNotThrow(() => core.validateHashFileSize(core.HASH_FILE_BYTES));
    assert.throws(() => core.validateHashFileSize(core.HASH_FILE_BYTES + 1), /20 МиБ/);
});

test("hash worker posts digest or one error without sending bytes elsewhere", async () => {
    const messages = [];
    const context = vm.createContext({TextEncoder, Uint8Array, DataView, crypto: webcrypto,
        postMessage(value) { messages.push(value); }});
    context.self = context;
    context.importScripts = () => vm.runInContext(
        fs.readFileSync(path.join(__dirname, "../static/js/converter_core.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/js/converter_hash_worker.js"), "utf8"), context);
    await context.onmessage({data: {id: 3, mode: "file", algorithm: "MD5", buffer: new TextEncoder().encode("abc").buffer}});
    assert.equal(messages[0].id, 3);
    assert.equal(messages[0].digest, "900150983cd24fb0d6963f7d28e17f72");
    await context.onmessage({data: {id: 4, mode: "file", algorithm: "unknown", buffer: new Uint8Array(0).buffer}});
    assert.equal(messages[1].ok, false);
    assert.equal(Object.hasOwn(messages[1], "digest"), false);
});
