const assert = require("node:assert/strict");
const {test} = require("node:test");
const files = require("../static/js/test_files_core.js");

test("exact binary and ASCII text contain the requested integer bytes", async () => {
    for (const format of ["bin", "txt"]) {
        const plan = files.planExact({base: "sample", size: "1.5", unit: "1024", format, triple: false});
        const [item] = files.makeExact(plan);
        assert.equal(item.blob.size, 1536);
        const bytes = new Uint8Array(await item.blob.arrayBuffer());
        assert.equal(bytes[0], format === "txt" ? 65 : 0);
        assert.equal(bytes.at(-1), format === "txt" ? 65 : 0);
        assert.equal(item.blob.type, format === "txt" ? "text/plain" : "application/octet-stream");
    }
    assert.equal(files.exactBytes("0,5", "1024"), 512);
    assert.throws(() => files.exactBytes("0.5", "1"), /целое число байтов/);
});

test("boundary set steps by one byte and zero creates only 0 and 1", () => {
    const plan = files.planExact({base: "upload", size: "1024", unit: "1", format: "bin", triple: true});
    assert.deepEqual(plan.items.map(item => item.size), [1023, 1024, 1025]);
    assert.deepEqual(files.makeExact(plan).map(item => item.blob.size), [1023, 1024, 1025]);
    const zero = files.planExact({base: "upload", size: "0", unit: "1", format: "txt", triple: true});
    assert.deepEqual(zero.items.map(item => item.size), [0, 1]);
});

test("all file and set limits are checked before allocating a Blob", () => {
    const exact = {base: "sample", unit: "1", format: "bin", triple: false};
    assert.equal(files.planExact({...exact, size: String(files.MAX_FILE_BYTES)}).items[0].size, files.MAX_FILE_BYTES);
    assert.throws(() => files.planExact({...exact, size: String(files.MAX_FILE_BYTES + 1)}), /20 МиБ/);
    assert.throws(() => files.planExact({...exact, size: String(files.MAX_FILE_BYTES), triple: true}), /20 МиБ/);
    assert.throws(() => files.checkSizes([files.MAX_FILE_BYTES, files.MAX_FILE_BYTES, files.MAX_FILE_BYTES, 1]), /60 МиБ/);
});

test("image geometry requires both side and area limits", () => {
    const input = {base: "image", width: "800", height: "600", format: "jpeg", pattern: "grid", background: "dark"};
    const image = files.planImage(input);
    assert.deepEqual({width: image.width, height: image.height, mime: image.mime},
        {width: 800, height: 600, mime: "image/jpeg"});
    assert.throws(() => files.planImage({...input, width: "4096", height: "4096"}), /8 000 000/);
    assert.throws(() => files.planImage({...input, width: "4097"}), /4096/);
    assert.throws(() => files.planImage({...input, width: "1.5"}), /целое/);
});

test("names reject paths, controls, reserved devices, and long final names", () => {
    for (const base of ["../secret", "a/b", "a\\b", "CON", "nul.txt", " trailing ", "name\nline", "name\u202ejpg", "bad\ud800"]) {
        assert.throws(() => files.filename(base, "", "txt"), /недопустим/);
    }
    for (const base of ["COM¹", "cOm².csv", "CoM³.txt", "LPT¹", "lPt².log", "LpT³.backup"]) {
        assert.throws(() => files.filename(base, "", "txt"), /зарезервировано Windows/);
    }
    for (const base of ["COM⁴", "COM¹a", "XCOM¹", "LPT¹-extra", "COM10", "LPT0"]) {
        assert.equal(files.filename(base, "", "txt"), `${base}.txt`);
    }
    assert.equal(files.filename("COM¹", "-sample", "txt"), "COM¹-sample.txt");
    assert.throws(() => files.filename("я".repeat(197), "", "txt"), /200 символов/);
    assert.throws(() => files.filename("x".repeat(100000), "", "txt"), /200 символов/);
    assert.equal([...files.filename("🧪".repeat(196), "", "txt")].length, 200);
    const names = files.planNames("custom");
    assert.equal(names.length, 4);
    assert.ok(names.every(item => item.name.endsWith(".txt")));
    assert.ok(names.some(item => item.name.includes(" ")));
});

test("negative samples keep explicit extension mismatch and size checks", () => {
    assert.match(files.planNegative({base: "x", kind: "truncated"}).note, /усечённый/);
    assert.equal(files.planNegative({base: "x", kind: "mismatch"}).name, "x-png-as-jpg.jpg");
    assert.throws(() => files.planNegative({base: "x", kind: "other"}), /негативный/);
    assert.throws(() => files.verifyBlob(new Blob([new Uint8Array(files.MAX_FILE_BYTES + 1)]), "x"), /20 МиБ/);
});
