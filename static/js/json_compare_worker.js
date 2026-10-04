/* JSON comparison runs only in a browser worker. Keep number tokens as text so
   integers and exponents never pass through JavaScript's Number precision. */
(() => {
    "use strict";
    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_DEPTH = 100;
    const MAX_CHANGES = 20000;
    const MAX_REPORT_BYTES = 32 * 1024 * 1024;
    const encoder = new TextEncoder();
    const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const hexDigit = /^[0-9a-fA-F]$/;

    class CompareError extends Error {
        constructor(message, side, position = null, source = "") {
            super(message);
            this.side = side;
            this.position = position;
            if (position !== null) {
                const before = source.slice(0, position);
                this.line = before.split("\n").length;
                this.column = position - before.lastIndexOf("\n");
            }
        }
    }

    function parseDocument(source, side) {
        const bytes = encoder.encode(source).length;
        if (bytes > MAX_BYTES) throw new CompareError("Размер превышает 2 МиБ UTF-8.", side);
        let at = 0;
        const length = source.length;
        const fail = (message, position = at) => { throw new CompareError(message, side, position, source); };
        const whitespace = () => {
            while (at < length && (source[at] === " " || source[at] === "\n" || source[at] === "\r" || source[at] === "\t")) at++;
        };
        const string = () => {
            const start = at++;
            while (at < length) {
                const ch = source[at++];
                if (ch === '"') {
                    return JSON.parse(source.slice(start, at));
                }
                if (ch.charCodeAt(0) < 32) fail("Недопустимый управляющий символ в строке.", at - 1);
                if (ch === "\\") {
                    if (at >= length) fail("Незавершённая escape-последовательность.");
                    const escape = source[at++];
                    if (escape === "u") {
                        for (let i = 0; i < 4; i++) {
                            if (at >= length || !hexDigit.test(source[at])) fail("Ожидаются четыре шестнадцатеричные цифры после \\u.");
                            at++;
                        }
                    } else if (!'"\\/bfnrt'.includes(escape)) fail("Недопустимая escape-последовательность.", at - 1);
                }
            }
            fail("Строка не закрыта кавычкой.", start);
        };
        const value = (depth) => {
            whitespace();
            const start = at;
            const ch = source[at];
            if (ch === "{" || ch === "[") {
                if (depth >= MAX_DEPTH) fail("Глубина JSON превышает 100 уровней.");
                at++;
                const object = ch === "{";
                const entries = object ? new Map() : [];
                whitespace();
                if (source[at] === (object ? "}" : "]")) at++;
                else {
                    while (true) {
                        if (object) {
                            if (source[at] !== '"') fail("Ожидается строковый ключ объекта.");
                            const keyStart = at;
                            const key = string();
                            if (entries.has(key)) fail(`Повтор ключа ${JSON.stringify(key)}.`, keyStart);
                            whitespace();
                            if (source[at] !== ":") fail("Ожидается двоеточие после ключа.");
                            at++;
                            entries.set(key, value(depth + 1));
                        } else entries.push(value(depth + 1));
                        whitespace();
                        if (source[at] === (object ? "}" : "]")) { at++; break; }
                        if (source[at] !== ",") fail("Ожидается запятая или закрывающая скобка.");
                        at++;
                        whitespace();
                    }
                }
                return {type: object ? "object" : "array", value: entries, start, end: at};
            }
            if (ch === '"') return {type: "string", value: string(), start, end: at};
            for (const literal of ["true", "false", "null"]) {
                if (source.startsWith(literal, at)) {
                    at += literal.length;
                    return {type: literal === "null" ? "null" : "boolean", value: literal, start, end: at};
                }
            }
            numberToken.lastIndex = at;
            const match = numberToken.exec(source);
            if (match) {
                at = numberToken.lastIndex;
                return {type: "number", value: normalizeNumber(match[0]), start, end: at};
            }
            fail("Ожидается значение JSON.");
        };
        whitespace();
        if (at === length) fail("Документ пуст.");
        const root = value(0);
        whitespace();
        if (at !== length) fail("Лишние символы после JSON.");
        return root;
    }

    function normalizeNumber(raw) {
        const [coefficient, exponent = "0"] = raw.toLowerCase().split("e");
        const negative = coefficient[0] === "-";
        const unsigned = negative ? coefficient.slice(1) : coefficient;
        const point = unsigned.indexOf(".");
        const fractional = point < 0 ? 0 : unsigned.length - point - 1;
        let digits = unsigned.replace(".", "").replace(/^0+/, "");
        if (!digits) return "0";
        const trailing = digits.match(/0+$/)?.[0].length || 0;
        if (trailing) digits = digits.slice(0, -trailing);
        const power = BigInt(exponent) - BigInt(fractional) + BigInt(trailing);
        return `${negative ? "-" : ""}${digits}e${power}`;
    }

    function compare(left, right) {
        const documents = {left, right};
        const roots = {left: parseDocument(left, "left"), right: parseDocument(right, "right")};
        const changes = [];
        const counts = {added: 0, removed: 0, changed: 0};
        let changeBytes = 0;
        const shown = (node, side) => node === undefined
            ? {present: false}
            : {present: true, json: documents[side].slice(node.start, node.end)};
        const record = (type, path, before, after) => {
            if (changes.length >= MAX_CHANGES) throw new CompareError("Число отличий превышает 20 000. Отчёт не сформирован.");
            const change = {type, path, before: shown(before, "left"), after: shown(after, "right")};
            const entryBytes = encoder.encode(JSON.stringify(change)).length;
            const nextCounts = {...counts, [type]: counts[type] + 1};
            // A compact report contains this fixed envelope, serialized entries
            // and one comma between adjacent entries. Reject before retaining a
            // change that would make the full export exceed the agreed limit.
            const envelopeBytes = encoder.encode(JSON.stringify({equal: false, counts: nextCounts, changes: []})).length;
            if (envelopeBytes + changeBytes + entryBytes + changes.length > MAX_REPORT_BYTES) {
                throw new CompareError("Полный отчёт превышает 32 МиБ UTF-8. Отчёт не сформирован.");
            }
            counts[type]++;
            changeBytes += entryBytes;
            changes.push(change);
        };
        const walk = (a, b, path) => {
            if (a === undefined || b === undefined) {
                record(a === undefined ? "added" : "removed", path, a, b);
            } else if (a.type !== b.type) record("changed", path, a, b);
            else if (a.type === "object") {
                for (const [key, child] of a.value) walk(child, b.value.get(key), `${path}[${JSON.stringify(key)}]`);
                for (const [key, child] of b.value) if (!a.value.has(key)) walk(undefined, child, `${path}[${JSON.stringify(key)}]`);
            } else if (a.type === "array") {
                for (let i = 0; i < Math.max(a.value.length, b.value.length); i++) walk(a.value[i], b.value[i], `${path}[${i}]`);
            } else if (a.value !== b.value) record("changed", path, a, b);
        };
        walk(roots.left, roots.right, "$");
        const equal = changes.length === 0;
        const report = JSON.stringify({equal, counts, changes});
        if (encoder.encode(report).length > MAX_REPORT_BYTES) {
            throw new CompareError("Полный отчёт превышает 32 МиБ UTF-8. Отчёт не сформирован.");
        }
        return {equal, counts, changes, report};
    }

    if (typeof self !== "undefined" && typeof self.postMessage === "function") {
        self.onmessage = ({data}) => {
            try { self.postMessage({id: data.id, ok: true, result: compare(data.left, data.right)}); }
            catch (error) {
                self.postMessage({id: data.id, ok: false, error: {
                    message: error.message || "Не удалось сравнить JSON.", side: error.side || null,
                    position: error.position ?? null, line: error.line ?? null, column: error.column ?? null,
                }});
            }
        };
    }
    if (typeof module !== "undefined") module.exports = {compare, parseDocument, normalizeNumber, MAX_BYTES, MAX_DEPTH, MAX_CHANGES, MAX_REPORT_BYTES};
})();
