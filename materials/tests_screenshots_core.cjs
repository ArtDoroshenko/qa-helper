const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const {crc32, deflateSync, inflateSync} = require("node:zlib");
const core = require("../static/js/screenshots_core.js");

function chunk(name, data = Buffer.alloc(0)) {
    const bytes = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(bytes));
    return Buffer.concat([length, bytes, crc]);
}

function png(width, height, rgba = new Uint8Array(width * height * 4), extras = []) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = [];
    for (let y = 0; y < height; y++) {
        rows.push(Buffer.from([0]), Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)));
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...extras,
        chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND"),
    ]);
}

function orientationExif(orientation) {
    const block = Buffer.alloc(26);
    block.write("II");
    block.writeUInt16LE(42, 2);
    block.writeUInt32LE(8, 4);
    block.writeUInt16LE(1, 8);
    block.writeUInt16LE(0x0112, 10);
    block.writeUInt16LE(3, 12);
    block.writeUInt32LE(1, 14);
    block.writeUInt16LE(orientation, 18);
    return block;
}

// 2 × 3 fixture generated from six coloured pixels, with application metadata removed.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9G/2cPgL8LvFn7PPwu8U6/ptzc6nrPhbRL26lGpX8YknuLGGSR9kdwqLuZicKoUdAAOK9n/4Zl+C//QGuv/BrqP8A8k1F+yd/yaz8G/8AsTPD3/pugr3+ndnd/aeJ/wCfkvvZ/9k=", "base64");

test("metadata comes from bytes and predicts oriented JPEG and PNG sizes", async () => {
    const data = Buffer.concat([Buffer.from("Exif\0\0"), orientationExif(6)]);
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xffe1);
    marker.writeUInt16BE(data.length + 2, 2);
    const rotated = new Blob([jpeg.subarray(0, 2), marker, data, jpeg.subarray(2)]);
    assert.deepEqual(await core.readMetadata(rotated), {width: 3, height: 2, mime: "image/jpeg"});
    const mirrored = png(3, 2, undefined, [chunk("eXIf", orientationExif(5))]);
    assert.deepEqual(await core.readMetadata(new Blob([mirrored], {type: "text/plain"})),
        {width: 2, height: 3, mime: "image/png"});
    assert.deepEqual(await core.readMetadata(new Blob([jpeg])), {width: 2, height: 3, mime: "image/jpeg"});
});

test("preflight rejects animated and unsupported types, broken chunks and out-of-range geometry", async () => {
    await assert.rejects(core.readMetadata(new Blob([png(2, 3, undefined, [chunk("acTL", Buffer.alloc(8))])])),
        /APNG/);
    await assert.rejects(core.readMetadata(new Blob(["<svg></svg>"], {type: "image/png"})), /статические PNG и JPEG/);
    await assert.rejects(core.readMetadata(new Blob([png(2, 3).subarray(0, -1)])), /структуру изображения/);
    const oversized = png(2, 3);
    oversized.writeUInt32BE(4097, 16);
    await assert.rejects(core.readMetadata(new Blob([oversized])), /превышает предел/);
    assert.doesNotThrow(() => core.checkGeometry(4096, 2048));
    assert.doesNotThrow(() => core.checkGeometry(3840, 2160));
    assert.throws(() => core.checkGeometry(4096, 2049), /превышает предел/);
    await assert.rejects(core.readMetadata({
        size: core.limits.bytes + 1, slice() { assert.fail("must reject before reading any data"); },
    }), /40 МиБ/);
});

test("difference uses max channel distance and a strict threshold, overlay uses rounded channel weights", () => {
    const a = [100, 50, 0, 255, 15, 20, 30, 255];
    const b = new Uint8ClampedArray([90, 56, 8, 255, 15, 20, 30, 255]);
    for (const [threshold, count, mapColor] of [[9, 1, [212, 0, 149, 255]], [10, 0, [48, 51, 57, 255]]]) {
        const left = new Uint8ClampedArray(a);
        assert.equal(core.compareStrip(left, b, "diff", threshold, 50), count);
        assert.deepEqual([...left.slice(0, 4)], mapColor);
        assert.deepEqual([...left.slice(4)], [48, 51, 57, 255]);
    }
    for (const [weight, expected] of [[0, a], [50, [95, 53, 4, 255, 15, 20, 30, 255]], [100, [...b]]]) {
        const left = new Uint8ClampedArray(a);
        assert.equal(core.compareStrip(left, b, "overlay", 9, weight), 1);
        assert.deepEqual([...left], expected);
    }
});

function file(width, height, pixels) {
    const data = new Blob([png(width, height)]);
    return {
        size: data.size,
        slice(start, end, mime) {
            if (mime) return {width, height, pixels, mime};
            return data.slice(start, end);
        },
    };
}

function workerHarness({beforeEncode = async () => {}, beforeDecode = async input => input} = {}) {
    const canvases = [];
    const bitmaps = [];
    const waiting = new Map();
    class Canvas {
        constructor(width, height) {
            Object.assign(this, {width, height, pixels: new Uint8ClampedArray(width * height * 4)});
            canvases.push(this);
        }
        getContext(mode, options) {
            assert.equal(mode, "2d");
            assert.equal(options.alpha, false);
            assert.equal(options.colorSpace, "srgb");
            const canvas = this;
            return {
                fillRect(x, y, width, height) {
                    assert.equal(this.fillStyle, "#fff");
                    canvas.pixels.fill(255, 0, width * height * 4);
                },
                drawImage(bitmap, x, y, width, height) {
                    for (let row = 0; row < height; row++) {
                        for (let column = 0; column < width; column++) {
                            const i = ((y + row) * bitmap.width + x + column) * 4;
                            const j = (row * canvas.width + column) * 4;
                            const alpha = bitmap.pixels[i + 3] / 255;
                            for (let c = 0; c < 3; c++) {
                                canvas.pixels[j + c] = Math.round(bitmap.pixels[i + c] * alpha + 255 * (1 - alpha));
                            }
                        }
                    }
                },
                getImageData(x, y, width, height) {
                    return {data: canvas.pixels.slice(0, width * height * 4)};
                },
                putImageData(frame, x, y) { canvas.pixels.set(frame.data, (y * canvas.width + x) * 4); },
            };
        }
        async convertToBlob({type}) {
            assert.equal(type, "image/png");
            await beforeEncode();
            return new Blob([png(this.width, this.height, this.pixels)], {type});
        }
    }
    const messages = [];
    const self = {QAScreenshots: core, postMessage(message) {
        messages.push(message);
        if (message.type !== "progress") waiting.get(message.id)?.(message);
    }};
    vm.runInNewContext(readFileSync(join(__dirname, "../static/js/screenshots_worker.js"), "utf8"), {
        self, importScripts() {}, OffscreenCanvas: Canvas, setTimeout,
        async createImageBitmap(input, options) {
            assert.equal(input.mime, "image/png");
            assert.equal(options.imageOrientation, "from-image");
            const decoded = await beforeDecode(input);
            const bitmap = {...decoded, closed: false, close() { this.closed = true; }};
            bitmaps.push(bitmap);
            return bitmap;
        },
    });
    const send = data => self.onmessage({data});
    const run = data => new Promise(resolve => { waiting.set(data.id, resolve); send(data); });
    return {run, send, messages, bitmaps, canvases};
}

test("worker uses a white background, exports the full PNG and frees native objects", async () => {
    const h = workerHarness();
    const height = 65;
    const pixels = values => Array.from({length: height}, () => values).flat();
    const left = file(2, height, pixels([180, 0, 0, 0, 0, 0, 0, 128]));
    const right = file(2, height, pixels([255, 255, 255, 255, 127, 127, 127, 255]));
    const reply = await h.run({id: 1, type: "compare", left, right, mode: "overlay", threshold: 0, weight: 50});
    assert.equal(reply.type, "done");
    assert.equal(reply.result.changed, 0);
    assert.deepEqual(await core.readMetadata(reply.result.png), {width: 2, height, mime: "image/png"});
    const image = Buffer.from(await reply.result.png.arrayBuffer());
    const idat = image.subarray(41, 41 + image.readUInt32BE(33));
    const expectedRow = [0, 255, 255, 255, 255, 127, 127, 127, 255];
    assert.deepEqual([...inflateSync(idat)], pixels(expectedRow));
    assert.equal(h.bitmaps.length, 2);
    assert.ok(h.bitmaps.every(bitmap => bitmap.closed));
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));

    const mismatch = await h.run({id: 2, type: "compare", left, right: file(1, 2, []), mode: "diff", threshold: 0, weight: 50});
    assert.equal(mismatch.type, "error");
    assert.match(mismatch.message, /одинакового размера/);
    assert.equal(h.bitmaps.length, 2);
});

test("canceling a native PNG export waits for it to finish and discards its blob", async () => {
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const h = workerHarness({beforeEncode() { started(); return hold; }});
    const shot = file(1, 1, [0, 0, 0, 255]);
    const request = {id: 1, type: "compare", left: shot, right: shot, mode: "diff", threshold: 0, weight: 50};
    const current = h.run(request);
    await entered;
    h.send({id: 1, type: "cancel"});
    h.send({...request, id: 2});
    assert.equal(h.bitmaps.length, 2);
    release();
    const canceled = await current;
    assert.equal(canceled.type, "cancelled");
    assert.equal(canceled.result, undefined);
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.ok(h.messages.every(message => message.id === 1));
    assert.equal((await h.run({...request, id: 3})).type, "done");
});

test("late native decode is closed after cancellation or a metadata mismatch", async () => {
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const h = workerHarness({async beforeDecode(input) {
        started();
        await hold;
        return {...input, width: input.height, height: input.width};
    }});
    const request = {id: 1, type: "inspect", file: file(3, 2, [])};
    const current = h.run(request);
    await entered;
    h.send({id: 1, type: "cancel"});
    release();
    assert.equal((await current).type, "cancelled");
    const mismatch = await h.run({...request, id: 2});
    assert.equal(mismatch.type, "error");
    assert.match(mismatch.message, /не совпадает с метаданными/);
    assert.equal(h.canvases.length, 0);
    assert.ok(h.bitmaps.every(bitmap => bitmap.closed));
});
