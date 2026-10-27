(() => {
    "use strict";

    const MAX_FILE_BYTES = 20 * 1024 * 1024;
    const MAX_SET_BYTES = 60 * 1024 * 1024;
    const MAX_SIDE = 4096;
    const MAX_PIXELS = 8000000;
    const MAX_NAME_POINTS = 200;
    const UNITS = new Set([1, 1024, 1048576]);
    const RESERVED = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])$/i;

    function filename(base, suffix, extension) {
        if (typeof base !== "string" || !base) throw new Error("Укажите основу имени файла.");
        let points = 0;
        for (const point of base) if (++points > MAX_NAME_POINTS) {
            throw new Error("Итоговое имя длиннее 200 символов Unicode.");
        }
        if (base !== base.trim()
            || /^[. ]|[. ]$/u.test(base) || /[<>:"/\\|?*]|[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(base)) {
            throw new Error("Основа имени недопустима: уберите путь, служебные символы и пробелы по краям.");
        }
        const name = `${base}${suffix}.${extension}`;
        if (RESERVED.test(name.split(".")[0])) {
            throw new Error("Итоговое имя зарезервировано Windows и недопустимо.");
        }
        points = 0;
        for (const point of name) if (++points > MAX_NAME_POINTS) {
            throw new Error("Итоговое имя длиннее 200 символов Unicode.");
        }
        return name;
    }

    function exactBytes(raw, unit) {
        const multiplier = Number(unit);
        if (!UNITS.has(multiplier) || typeof raw !== "string" || raw.length > 40 || !/^\d+(?:[.,]\d+)?$/u.test(raw)) {
            throw new Error("Укажите неотрицательный размер в байтах, КиБ или МиБ.");
        }
        const [whole, fraction = ""] = raw.replace(",", ".").split(".");
        const divisor = 10n ** BigInt(fraction.length);
        const numerator = (BigInt(whole) * divisor + BigInt(fraction || "0")) * BigInt(multiplier);
        if (numerator % divisor !== 0n) throw new Error("Размер должен давать целое число байтов.");
        const bytes = numerator / divisor;
        if (bytes > BigInt(MAX_FILE_BYTES)) throw new Error("Файл превышает 20 МиБ (20 971 520 байт).");
        return Number(bytes);
    }

    function checkSizes(sizes) {
        if (sizes.some(size => !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES)) {
            throw new Error("Хотя бы один файл превышает предел 20 МиБ. Ничего не создано.");
        }
        if (sizes.reduce((total, size) => total + size, 0) > MAX_SET_BYTES) {
            throw new Error("Набор превышает 60 МиБ. Ничего не создано.");
        }
    }

    function planExact({base, size, unit, format, triple}) {
        if (!["bin", "txt"].includes(format)) throw new Error("Выберите .bin или .txt.");
        const bytes = exactBytes(size, unit);
        const points = triple ? bytes === 0 ? [["L", 0], ["L+1", 1]]
            : [["L−1", bytes - 1], ["L", bytes], ["L+1", bytes + 1]] : [["L", bytes]];
        checkSizes(points.map(([, count]) => count));
        const suffix = {"L−1": "-L-minus-1", L: "-L", "L+1": "-L-plus-1"};
        const items = points.map(([label, count]) => ({
            label, size: count, name: filename(base, triple ? suffix[label] : "", format),
            mime: format === "bin" ? "application/octet-stream" : "text/plain",
            note: format === "bin" ? "Нулевые байты · нейтральный .bin" : "ASCII A · без BOM",
        }));
        return {format, items};
    }

    function makeExact(plan) {
        const maximum = Math.max(...plan.items.map(item => item.size));
        const bytes = new Uint8Array(maximum);
        if (plan.format === "txt") bytes.fill(65);
        const source = new Blob([bytes], {type: plan.items[0].mime});
        return plan.items.map(item => ({...item, blob: source.slice(0, item.size, item.mime)}));
    }

    function positiveInteger(raw, label) {
        const value = String(raw);
        if (!/^\d+$/u.test(value) || value.length > 10) throw new Error(`${label}: укажите целое число пикселей.`);
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1 || number > MAX_SIDE) {
            throw new Error(`${label}: допустимо от 1 до 4096 px.`);
        }
        return number;
    }

    function planImage({base, width, height, format, pattern, background}) {
        const w = positiveInteger(width, "Ширина"), h = positiveInteger(height, "Высота");
        if (w * h > MAX_PIXELS) throw new Error("Площадь изображения превышает 8 000 000 пикселей.");
        if (!["png", "jpeg"].includes(format) || !["grid", "plain"].includes(pattern)
            || !["light", "dark"].includes(background)) throw new Error("Выберите допустимые параметры изображения.");
        const extension = format === "jpeg" ? "jpg" : "png";
        return {name: filename(base, "", extension), width: w, height: h, format, pattern, background,
            mime: format === "jpeg" ? "image/jpeg" : "image/png"};
    }

    function planNegative({base, kind}) {
        const types = {
            empty: {suffix: "-empty", extension: "bin", note: "Пустой .bin · 0 байт"},
            truncated: {suffix: "-truncated", extension: "png", note: "Намеренно усечённый PNG · первые 24 байта"},
            mismatch: {suffix: "-png-as-jpg", extension: "jpg", note: "Валидный PNG под именем .jpg · MIME image/png"},
        };
        if (!Object.hasOwn(types, kind)) throw new Error("Выберите негативный образец.");
        return {...types[kind], kind, name: filename(base, types[kind].suffix, types[kind].extension)};
    }

    function planNames(base) {
        const names = [
            {label: "Своё имя", name: filename(base, "", "txt")},
            {label: "Кириллица", name: filename("проверка-данных", "", "txt")},
            {label: "Пробелы", name: filename("файл с пробелами", "", "txt")},
            {label: "Длинное Unicode-имя", name: filename("🧪".repeat(60), "", "txt")},
        ];
        checkSizes(names.map(() => 32));
        return names;
    }

    function verifyBlob(blob, name) {
        if (!(blob instanceof Blob) || blob.size > MAX_FILE_BYTES) {
            throw new Error(`${name}: фактический размер превышает 20 МиБ или файл не создан.`);
        }
        return blob;
    }

    const api = {MAX_FILE_BYTES, MAX_SET_BYTES, MAX_SIDE, MAX_PIXELS, MAX_NAME_POINTS,
        filename, exactBytes, checkSizes, planExact, makeExact, planImage, planNegative, planNames, verifyBlob};
    globalThis.QATestFilesCore = api;
    if (typeof module !== "undefined") module.exports = api;
})();
