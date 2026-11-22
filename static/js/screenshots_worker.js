"use strict";

importScripts("screenshots_core.js?v=1");

const {readMetadata, checkGeometry, compareStrip} = self.QAScreenshots;
const cancelled = Symbol("cancelled");
let active = null;

function assertActive(job) {
    if (job.cancelled) throw cancelled;
}

async function checkpoint(job) {
    await new Promise(resolve => setTimeout(resolve, 0));
    assertActive(job);
}

function progress(job, message) {
    self.postMessage({id: job.id, type: "progress", message});
}

function context(canvas, willReadFrequently = false) {
    const ctx = canvas.getContext("2d", {alpha: false, colorSpace: "srgb", willReadFrequently});
    if (!ctx) throw new Error("Браузер не смог подготовить изображение.");
    return ctx;
}

function release(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

async function decode(file, info, job) {
    assertActive(job);
    let bitmap;
    try {
        bitmap = await createImageBitmap(file.slice(0, file.size, info.mime), {
            imageOrientation: "from-image", colorSpaceConversion: "default",
        });
    } catch {
        throw new Error("Браузер не смог декодировать изображение.");
    }
    try {
        assertActive(job);
        checkGeometry(bitmap.width, bitmap.height);
        if (bitmap.width !== info.width || bitmap.height !== info.height) {
            throw new Error("Размер после декодирования не совпадает с метаданными снимка.");
        }
        return bitmap;
    } catch (error) {
        bitmap.close();
        throw error;
    }
}

async function inspect(file, job) {
    const info = await readMetadata(file, () => checkpoint(job));
    const bitmap = await decode(file, info, job);
    let canvas;
    try {
        const scale = Math.min(1, 320 / bitmap.width, 180 / bitmap.height);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)));
        const ctx = context(canvas);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const thumbnail = await canvas.convertToBlob({type: "image/png"});
        assertActive(job);
        return {...info, thumbnail};
    } finally {
        bitmap.close();
        release(canvas);
    }
}

function readStrip(ctx, bitmap, y, height) {
    const width = bitmap.width;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, y, width, height, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
}

async function compare(request, job) {
    const {left, right, mode, threshold, weight} = request;
    const pause = () => checkpoint(job);
    const first = await readMetadata(left, pause);
    const second = await readMetadata(right, pause);
    const {width, height} = first;
    if (width !== second.width || height !== second.height) {
        throw new Error("Нужны изображения одинакового размера.");
    }
    let reference, actual, output, strip;
    try {
        progress(job, "Декодируем снимки…");
        reference = await decode(left, first, job);
        actual = await decode(right, second, job);
        const stripHeight = Math.min(64, height);
        output = new OffscreenCanvas(width, height);
        strip = new OffscreenCanvas(width, stripHeight);
        const out = context(output);
        const pixels = context(strip, true);
        let changed = 0;
        progress(job, "Сравниваем пиксели…");
        for (let y = 0; y < height; y += stripHeight) {
            const rows = Math.min(stripHeight, height - y);
            const a = readStrip(pixels, reference, y, rows);
            const b = readStrip(pixels, actual, y, rows);
            changed += compareStrip(a.data, b.data, mode, threshold, weight);
            out.putImageData(a, 0, y);
            await pause();
        }
        reference.close();
        reference = null;
        actual.close();
        actual = null;
        release(strip);
        strip = null;
        progress(job, "Готовим PNG…");
        const png = await output.convertToBlob({type: "image/png"});
        assertActive(job);
        return {png, width, height, changed};
    } finally {
        reference?.close();
        actual?.close();
        release(strip);
        release(output);
    }
}

async function makeDemo(job) {
    const canvas = new OffscreenCanvas(640, 360);
    try {
        const ctx = context(canvas);
        const files = [];
        for (const actual of [false, true]) {
            assertActive(job);
            ctx.fillStyle = "#edf2f8";
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(120, 50, 400, 260);
            ctx.fillStyle = "#263142";
            ctx.font = "bold 26px sans-serif";
            ctx.fillText("QA Kit", 150, 105);
            ctx.fillStyle = "#dce4ed";
            ctx.fillRect(150, 137, 290, 12);
            ctx.fillRect(150, 165, 245, 12);
            const buttonX = actual ? 158 : 150;
            ctx.fillStyle = actual ? "#096da7" : "#1453a5";
            ctx.fillRect(buttonX, 220, 150, 48);
            ctx.fillStyle = "#fff";
            ctx.font = "16px sans-serif";
            ctx.fillText("Save", buttonX + 54, 250);
            files.push(await canvas.convertToBlob({type: "image/png"}));
        }
        assertActive(job);
        return {files};
    } finally {
        release(canvas);
    }
}

async function run(request, job) {
    let reply;
    try {
        if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
            throw new Error("Для сравнения нужен браузер с поддержкой обработки изображений в отдельном потоке.");
        }
        let result;
        if (request.type === "inspect") result = await inspect(request.file, job);
        if (request.type === "compare") result = await compare(request, job);
        if (request.type === "demo") result = await makeDemo(job);
        assertActive(job);
        reply = {type: "done", result};
    } catch (error) {
        reply = job.cancelled || error === cancelled
            ? {type: "cancelled"}
            : {type: "error", message: error?.message || "Не удалось обработать снимок."};
    } finally {
        active = null;
    }
    self.postMessage({id: job.id, ...reply});
}

self.onmessage = ({data}) => {
    if (data.type === "cancel") {
        if (active?.id === data.id) active.cancelled = true;
        return;
    }
    if (active || !["inspect", "compare", "demo"].includes(data.type)) return;
    active = {id: data.id, cancelled: false};
    void run(data, active);
};
