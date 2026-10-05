(() => {
    "use strict";
    const URL_INPUT_BYTES = 256 * 1024;
    const URL_OUTPUT_BYTES = 1024 * 1024;
    const JWT_BYTES = 64 * 1024;
    const HASH_FILE_BYTES = 20 * 1024 * 1024;
    const DATE_LIMIT = 8640000000000000n;
    const ZONES = ["UTC", "Europe/Moscow", "America/New_York", "Asia/Tokyo"];
    const HASH_LENGTHS = {"SHA-256": 64, "SHA-512": 128, "SHA-1": 40, MD5: 32};
    const encoder = new TextEncoder();
    const formatters = new Map();
    const bytes = value => encoder.encode(value).length;

    function convertUrl(source, operation, mode) {
        if (!source) throw new Error("Введите значение для преобразования.");
        if (bytes(source) > URL_INPUT_BYTES) throw new Error("Вход URL превышает 256 КиБ UTF-8.");
        if (!["encode", "decode"].includes(operation) || !["percent", "form"].includes(mode)) {
            throw new Error("Выберите операцию и режим URL.");
        }
        let output;
        try {
            if (operation === "encode") {
                output = encodeURIComponent(source);
                if (mode === "form") {
                    output = output.replace(/[!'()~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
                        .replace(/%20/g, "+");
                }
            } else output = decodeURIComponent(mode === "form" ? source.replace(/\+/g, " ") : source);
        } catch (error) {
            throw new Error("Некорректная percent-последовательность или Unicode.");
        }
        if (bytes(output) > URL_OUTPUT_BYTES) throw new Error("Результат URL превышает 1 МиБ UTF-8.");
        return output;
    }

    function formatter(zone) {
        if (!ZONES.includes(zone)) throw new Error("Выберите поддерживаемый часовой пояс.");
        if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-GB", {
            timeZone: zone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        }));
        return formatters.get(zone);
    }
    function zonedParts(ms, zone) {
        const found = Object.fromEntries(formatter(zone).formatToParts(new Date(ms))
            .filter(part => ["year", "month", "day", "hour", "minute", "second"].includes(part.type))
            .map(part => [part.type, Number(part.value)]));
        return found;
    }
    function civilMs(year, month, day, hour, minute, second, millis = 0) {
        const date = new Date(0);
        date.setUTCFullYear(year, month - 1, day);
        date.setUTCHours(hour, minute, second, millis);
        return date.getTime();
    }
    const pad = (value, length = 2) => String(value).padStart(length, "0");
    function zonedText(ms, zone) {
        const p = zonedParts(ms, zone);
        return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(new Date(ms).getUTCMilliseconds(), 3)}`;
    }
    function timestampMs(source, unit) {
        const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(source);
        if (!match) throw new Error("Timestamp должен быть числом в выбранных единицах.");
        const whole = match[2].replace(/^0+(?=\d)/, "");
        const fraction = match[3] || "";
        if (unit === "s") {
            if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
                throw new Error("Точность timestamp меньше миллисекунды не поддерживается.");
            }
        } else if (unit === "ms") {
            if (/[1-9]/.test(fraction)) throw new Error("Миллисекунды должны быть целым числом.");
        } else throw new Error("Выберите секунды или миллисекунды.");
        if (whole.length > 16) throw new Error("Дата вне поддерживаемого диапазона.");
        let result = BigInt(whole) * (unit === "s" ? 1000n : 1n);
        if (unit === "s") result += BigInt((fraction.slice(0, 3) || "").padEnd(3, "0") || "0");
        if (match[1]) result = -result;
        if (result < -DATE_LIMIT || result > DATE_LIMIT) throw new Error("Дата вне поддерживаемого диапазона.");
        return Number(result);
    }
    function localInstant(source, zone) {
        formatter(zone);
        const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(source);
        if (!match) throw new Error("Введите дату и время: ГГГГ-ММ-ДД ЧЧ:ММ:СС.");
        const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || "0");
        const millis = Number((match[7] || "0").padEnd(3, "0"));
        const base = civilMs(year, month, day, hour, minute, second);
        const valid = new Date(base);
        if (valid.getUTCFullYear() !== year || valid.getUTCMonth() + 1 !== month || valid.getUTCDate() !== day ||
            valid.getUTCHours() !== hour || valid.getUTCMinutes() !== minute || valid.getUTCSeconds() !== second) {
            throw new Error("Некорректная дата или время.");
        }
        const target = {year, month, day, hour, minute, second};
        const offsets = new Set();
        for (let delta = -36 * 60; delta <= 36 * 60; delta += 15) {
            const sample = base + delta * 60000;
            if (!Number.isFinite(new Date(sample).getTime())) continue;
            const p = zonedParts(sample, zone);
            offsets.add(civilMs(p.year, p.month, p.day, p.hour, p.minute, p.second) - sample);
        }
        const matches = new Set();
        for (const offset of offsets) {
            const candidate = base - offset + millis;
            if (!Number.isFinite(new Date(candidate).getTime())) continue;
            const p = zonedParts(candidate, zone);
            if (Object.keys(target).every(key => p[key] === target[key]) &&
                new Date(candidate).getUTCMilliseconds() === millis) matches.add(candidate);
        }
        if (!matches.size) throw new Error("Это локальное время не существует в выбранном поясе.");
        if (matches.size > 1) throw new Error("Время неоднозначно из-за перевода часов. Укажите соответствующее время в UTC.");
        return [...matches][0];
    }
    function secondsText(ms) {
        const value = BigInt(ms);
        const negative = value < 0n;
        const absolute = negative ? -value : value;
        const whole = absolute / 1000n;
        const fraction = absolute % 1000n;
        return `${negative ? "-" : ""}${whole}${fraction ? `.${pad(fraction, 3).replace(/0+$/, "")}` : ""}`;
    }
    function convertDate(source, direction, unit, zone) {
        source = source.trim();
        if (!source) throw new Error(direction === "to-stamp" ? "Введите дату и время." : "Введите timestamp.");
        formatter(zone);
        if (!["s", "ms"].includes(unit)) throw new Error("Выберите секунды или миллисекунды.");
        if (direction === "to-date") {
            const ms = timestampMs(source, unit);
            return {output: `${zonedText(ms, zone)} · ${zone}\n${new Date(ms).toISOString()} · UTC`, meta: `${zone} · UTC`};
        }
        if (direction === "to-stamp") {
            const ms = localInstant(source, zone);
            return {output: unit === "s" ? secondsText(ms) : String(ms),
                meta: `${unit === "s" ? "Секунды" : "Миллисекунды"} · исходная зона ${zone}`};
        }
        throw new Error("Выберите направление преобразования.");
    }

    function jwtSegment(part, label) {
        if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) {
            throw new Error(`${label}: некорректный base64url.`);
        }
        let raw;
        try {
            const decoded = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
            raw = new TextDecoder("utf-8", {fatal: true}).decode(Uint8Array.from(decoded, char => char.charCodeAt(0)));
        } catch (error) { throw new Error(`${label}: не удалось декодировать UTF-8.`); }
        let value;
        try { value = JSON.parse(raw); }
        catch (error) { throw new Error(`${label}: некорректный JSON.`); }
        if (!value || Array.isArray(value) || typeof value !== "object") {
            throw new Error(`${label} должен быть JSON-объектом.`);
        }
        return {raw, value};
    }
    function numericDate(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        const ms = value * 1000;
        return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
    }
    function decodeJwt(token, nowMs = Date.now()) {
        token = token.trim();
        if (!token) throw new Error("Вставьте JWT.");
        if (bytes(token) > JWT_BYTES) throw new Error("JWT превышает 64 КиБ UTF-8.");
        const parts = token.split(".");
        if (parts.length !== 3 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]*$/.test(parts[2])) {
            throw new Error("Ожидаются три сегмента JWT, разделённые точками.");
        }
        const header = jwtSegment(parts[0], "Header");
        const payload = jwtSegment(parts[1], "Payload");
        const dates = ["exp", "iat", "nbf"].map(name => {
            const present = Object.hasOwn(payload.value, name);
            return {name, text: !present ? "Отсутствует" : numericDate(payload.value[name]) || "Некорректная дата: ожидается NumericDate"};
        });
        const expPresent = Object.hasOwn(payload.value, "exp");
        const expDate = expPresent ? numericDate(payload.value.exp) : null;
        const expiry = !expPresent ? "exp отсутствует" : !expDate ? "Некорректный exp"
            : payload.value.exp * 1000 <= nowMs ? "Срок истёк" : "Срок не истёк";
        return {header: header.raw, payload: payload.raw, dates, expiry,
            download: `{"header":${header.raw},"payload":${payload.raw}}`};
    }

    function validateHashFileSize(size) {
        if (size > HASH_FILE_BYTES) throw new Error("Файл для хеша превышает 20 МиБ.");
    }
    function validateExpectedHex(expected, algorithm) {
        if (!Object.hasOwn(HASH_LENGTHS, algorithm)) throw new Error("Выберите алгоритм хеширования.");
        expected = expected.trim();
        if (expected && (!/^[0-9a-fA-F]+$/.test(expected) || expected.length !== HASH_LENGTHS[algorithm])) {
            throw new Error(`Ожидаемый хеш должен содержать ${HASH_LENGTHS[algorithm]} hex-символов.`);
        }
        return expected.toLowerCase();
    }
    const md5Shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const md5Constants = Array.from({length: 64}, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296));
    function md5(bytesInput) {
        const bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
        const length = Math.ceil((bytes.length + 9) / 64) * 64;
        const buffer = new Uint8Array(length);
        buffer.set(bytes);
        buffer[bytes.length] = 128;
        const view = new DataView(buffer.buffer);
        view.setUint32(length - 8, (bytes.length * 8) >>> 0, true);
        view.setUint32(length - 4, Math.floor(bytes.length / 536870912), true);
        const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
        for (let offset = 0; offset < length; offset += 64) {
            let [a, b, c, d] = state;
            for (let index = 0; index < 64; index++) {
                let f, g;
                if (index < 16) { f = (b & c) | (~b & d); g = index; }
                else if (index < 32) { f = (d & b) | (~d & c); g = (5 * index + 1) % 16; }
                else if (index < 48) { f = b ^ c ^ d; g = (3 * index + 5) % 16; }
                else { f = c ^ (b | ~d); g = (7 * index) % 16; }
                const shift = md5Shifts[Math.floor(index / 16) * 4 + index % 4];
                const sum = (a + f + md5Constants[index] + view.getUint32(offset + g * 4, true)) | 0;
                [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0, b, c];
            }
            state[0] = (state[0] + a) | 0;
            state[1] = (state[1] + b) | 0;
            state[2] = (state[2] + c) | 0;
            state[3] = (state[3] + d) | 0;
        }
        return state.map(value => [0, 8, 16, 24].map(shift => ((value >>> shift) & 255).toString(16).padStart(2, "0")).join("")).join("");
    }
    async function hashBytes(input, algorithm, subtle) {
        if (!Object.hasOwn(HASH_LENGTHS, algorithm)) throw new Error("Выберите алгоритм хеширования.");
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (algorithm === "MD5") return md5(bytes);
        if (!subtle) throw new Error("Для хеширования нужен защищённый контекст браузера (HTTPS).");
        const digest = await subtle.digest(algorithm, bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    const api = {convertUrl, convertDate, decodeJwt, validateHashFileSize, validateExpectedHex, hashBytes,
        URL_INPUT_BYTES, URL_OUTPUT_BYTES, JWT_BYTES, HASH_FILE_BYTES, ZONES};
    if (typeof module !== "undefined") module.exports = api;
    globalThis.QAConverterCore = api;
})();
