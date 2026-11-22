(() => {
    "use strict";

    const limits = Object.freeze({bytes: 40 * 1024 * 1024, side: 4096, pixels: 8388608});
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    const exifSignature = [69, 120, 105, 102, 0, 0];
    const jpegSizes = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    const invalid = () => new Error("Не удалось прочитать структуру изображения. Выберите исправный PNG или JPEG.");
    const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);
    const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    function checkGeometry(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw invalid();
        if (width > limits.side || height > limits.side || width * height > limits.pixels) {
            throw new Error("Размер " + width + " × " + height + " превышает предел 4096 px по стороне или 8 388 608 пикселей.");
        }
    }

    function makeReader(file) {
        let offset = 0;
        let cached = new Uint8Array();
        return async (start, length) => {
            if (start < 0 || start + length > file.size) throw invalid();
            if (start < offset || start + length > offset + cached.length) {
                const end = Math.min(file.size, start + Math.max(length, 64 * 1024));
                cached = new Uint8Array(await file.slice(start, end).arrayBuffer());
                offset = start;
            }
            return cached.subarray(start - offset, start - offset + length);
        };
    }

    async function exifOrientation(read, start, length, yieldWork) {
        if (length < 8) throw invalid();
        const header = view(await read(start, 8));
        const order = header.getUint16(0);
        const little = order === 0x4949;
        if ((!little && order !== 0x4d4d) || header.getUint16(2, little) !== 42) throw invalid();
        const directory = header.getUint32(4, little);
        if (directory < 8 || directory + 2 > length) throw invalid();
        const count = view(await read(start + directory, 2)).getUint16(0, little);
        if (directory + 2 + count * 12 + 4 > length) throw invalid();
        let orientation = 0;
        for (let i = 0; i < count; i++) {
            if (i % 256 === 0) await yieldWork();
            const field = view(await read(start + directory + 2 + i * 12, 12));
            if (field.getUint16(0, little) !== 0x0112) continue;
            const value = field.getUint16(8, little);
            if (orientation || field.getUint16(2, little) !== 3 || field.getUint32(4, little) !== 1 || value < 1 || value > 8) {
                throw invalid();
            }
            orientation = value;
        }
        return orientation || 1;
    }

    async function readPng(read, size, yieldWork) {
        const header = view(await read(8, 21));
        if (header.getUint32(0) !== 13 || header.getUint32(4) !== 0x49484452) throw invalid();
        const width = header.getUint32(8);
        const height = header.getUint32(12);
        checkGeometry(width, height);
        let orientation;
        let seenData = false;
        let offset = 33;
        let chunks = 0;
        while (offset < size) {
            if (chunks++ % 256 === 0) await yieldWork();
            const chunk = view(await read(offset, 8));
            const length = chunk.getUint32(0);
            const kind = chunk.getUint32(4);
            const next = offset + length + 12;
            if (next > size || kind === 0x49484452) throw invalid();
            if (kind === 0x6163544c || kind === 0x6663544c || kind === 0x66644154) {
                throw new Error("Анимированный PNG (APNG) не поддерживается.");
            }
            if (kind === 0x49444154) seenData = true;
            if (kind === 0x65584966) {
                if (orientation !== undefined) throw invalid();
                orientation = await exifOrientation(read, offset + 8, length, yieldWork);
            }
            if (kind === 0x49454e44) {
                if (!seenData || length || next !== size) throw invalid();
                return {width, height, orientation: orientation || 1, mime: "image/png"};
            }
            offset = next;
        }
        throw invalid();
    }

    async function readJpeg(read, size, yieldWork) {
        let width, height, orientation;
        let offset = 2;
        let markers = 0;
        if (view(await read(size - 2, 2)).getUint16(0) !== 0xffd9) throw invalid();
        while (offset < size) {
            if (markers++ % 256 === 0) await yieldWork();
            if ((await read(offset++, 1))[0] !== 0xff) throw invalid();
            let marker = (await read(offset++, 1))[0];
            while (marker === 0xff) {
                if (markers++ % 256 === 0) await yieldWork();
                marker = (await read(offset++, 1))[0];
            }
            if (marker === 0 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) throw invalid();
            if (marker === 0x01) continue;
            const length = view(await read(offset, 2)).getUint16(0);
            if (length < 2 || offset + length > size) throw invalid();
            const start = offset + 2;
            if (jpegSizes.has(marker)) {
                if (width !== undefined || length < 11) throw invalid();
                const frame = view(await read(start, 6));
                height = frame.getUint16(1);
                width = frame.getUint16(3);
                if (length !== 8 + frame.getUint8(5) * 3) throw invalid();
                checkGeometry(width, height);
            } else if (marker === 0xe1 && length >= 8 && startsWith(await read(start, 6), exifSignature)) {
                if (orientation !== undefined) throw invalid();
                orientation = await exifOrientation(read, start + 6, length - 8, yieldWork);
            } else if (marker === 0xe2 && length >= 6 && view(await read(start, 4)).getUint32(0) === 0x4d504600) {
                throw new Error("Файл JPEG должен содержать один снимок.");
            } else if (marker === 0xda) {
                if (width === undefined || length < 8 || offset + length >= size - 2) throw invalid();
                return {width, height, orientation: orientation || 1, mime: "image/jpeg"};
            }
            offset += length;
        }
        throw invalid();
    }

    async function readMetadata(file, yieldWork = async () => {}) {
        if (file.size > limits.bytes) throw new Error("Размер файла превышает 40 МиБ.");
        if (file.size < 8) throw invalid();
        const read = makeReader(file);
        const signature = await read(0, 8);
        let info;
        if (startsWith(signature, pngSignature)) {
            info = await readPng(read, file.size, yieldWork);
        } else if (signature[0] === 0xff && signature[1] === 0xd8) {
            info = await readJpeg(read, file.size, yieldWork);
        } else {
            throw new Error("Поддерживаются только статические PNG и JPEG.");
        }
        const {width, height, orientation, mime} = info;
        return orientation >= 5 ? {width: height, height: width, mime} : {width, height, mime};
    }

    function compareStrip(left, right, mode, threshold, weight) {
        let changed = 0;
        for (let i = 0; i < left.length; i += 4) {
            const distance = Math.max(
                Math.abs(left[i] - right[i]),
                Math.abs(left[i + 1] - right[i + 1]),
                Math.abs(left[i + 2] - right[i + 2]),
            );
            const differs = distance > threshold;
            if (differs) changed++;
            if (mode === "overlay") {
                for (let c = 0; c < 3; c++) {
                    left[i + c] = Math.round((left[i + c] * (100 - weight) + right[i + c] * weight) / 100);
                }
            } else {
                left[i] = differs ? 212 : 48;
                left[i + 1] = differs ? 0 : 51;
                left[i + 2] = differs ? 149 : 57;
            }
            left[i + 3] = 255;
        }
        return changed;
    }

    const api = {limits, checkGeometry, readMetadata, compareStrip};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else self.QAScreenshots = api;
})();
