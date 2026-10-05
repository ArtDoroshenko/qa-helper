(() => {
    "use strict";
    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_LINES = 20000;

    function prepare(text, options = {}) {
        if (typeof text !== "string") throw new Error("Текст должен быть строкой.");
        if (new TextEncoder().encode(text).length > MAX_BYTES) {
            throw new Error("Каждая сторона должна быть не больше 2 МиБ UTF-8.");
        }
        const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
        if (lines.length > MAX_LINES) throw new Error("На каждой стороне допускается не больше 20 000 строк.");
        const keys = lines.map(line => {
            let key = options.ignoreTrailing ? line.replace(/[ \t]+$/g, "") : line;
            if (options.ignoreCase) key = key.toLocaleLowerCase("und");
            return key;
        });
        return {lines, keys};
    }

    function uniqueAnchors(left, right, startLeft, endLeft, startRight, endRight) {
        const leftCount = new Map(), rightCount = new Map();
        for (let i = startLeft; i < endLeft; i++) {
            const item = leftCount.get(left[i]);
            leftCount.set(left[i], item ? {count: item.count + 1, index: item.index} : {count: 1, index: i});
        }
        for (let j = startRight; j < endRight; j++) {
            const item = rightCount.get(right[j]);
            rightCount.set(right[j], item ? {count: item.count + 1, index: item.index} : {count: 1, index: j});
        }
        const candidates = [];
        for (let i = startLeft; i < endLeft; i++) {
            const l = leftCount.get(left[i]), r = rightCount.get(left[i]);
            if (l.count === 1 && r?.count === 1) candidates.push([i, r.index]);
        }
        const tails = [], tailIndexes = [], previous = new Int32Array(candidates.length);
        for (let i = 0; i < candidates.length; i++) {
            const rightIndex = candidates[i][1];
            let low = 0, high = tails.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (tails[middle] < rightIndex) low = middle + 1;
                else high = middle;
            }
            previous[i] = low ? tailIndexes[low - 1] : -1;
            tails[low] = rightIndex;
            tailIndexes[low] = i;
        }
        const result = [];
        for (let i = tailIndexes[tails.length - 1]; i !== undefined && i >= 0; i = previous[i]) result.push(candidates[i]);
        return result.reverse();
    }

    function fragments(left, right) {
        const a = [...left], b = [...right];
        let prefix = 0;
        while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
        let suffix = 0;
        while (suffix < a.length - prefix && suffix < b.length - prefix
            && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
        return {
            left: [a.slice(0, prefix).join(""), a.slice(prefix, a.length - suffix).join(""), a.slice(a.length - suffix).join("")],
            right: [b.slice(0, prefix).join(""), b.slice(prefix, b.length - suffix).join(""), b.slice(b.length - suffix).join("")],
        };
    }

    function compare(leftText, rightText, options = {}) {
        if (leftText === "" && rightText === "") throw new Error("Введите текст хотя бы на одной стороне.");
        const left = prepare(leftText, options), right = prepare(rightText, options);
        const changes = [];
        const add = (kind, i, j) => {
            const change = {kind, leftNumber: i === null ? null : i + 1,
                rightNumber: j === null ? null : j + 1,
                leftText: i === null ? null : left.lines[i], rightText: j === null ? null : right.lines[j]};
            if (kind === "modified") change.fragments = fragments(change.leftText, change.rightText);
            changes.push(change);
        };
        function gap(leftStart, leftEnd, rightStart, rightEnd) {
            while (leftStart < leftEnd && rightStart < rightEnd
                && left.keys[leftStart] === right.keys[rightStart]) { leftStart++; rightStart++; }
            while (leftStart < leftEnd && rightStart < rightEnd
                && left.keys[leftEnd - 1] === right.keys[rightEnd - 1]) { leftEnd--; rightEnd--; }
            const paired = Math.min(leftEnd - leftStart, rightEnd - rightStart);
            for (let offset = 0; offset < paired; offset++) add("modified", leftStart + offset, rightStart + offset);
            for (let i = leftStart + paired; i < leftEnd; i++) add("removed", i, null);
            for (let j = rightStart + paired; j < rightEnd; j++) add("added", null, j);
        }
        let prefix = 0;
        while (prefix < left.keys.length && prefix < right.keys.length
            && left.keys[prefix] === right.keys[prefix]) prefix++;
        let leftEnd = left.keys.length, rightEnd = right.keys.length;
        while (leftEnd > prefix && rightEnd > prefix
            && left.keys[leftEnd - 1] === right.keys[rightEnd - 1]) { leftEnd--; rightEnd--; }
        const anchors = uniqueAnchors(left.keys, right.keys, prefix, leftEnd, prefix, rightEnd);
        let li = prefix, ri = prefix;
        for (const [nextLeft, nextRight] of anchors) {
            gap(li, nextLeft, ri, nextRight);
            li = nextLeft + 1;
            ri = nextRight + 1;
        }
        gap(li, leftEnd, ri, rightEnd);
        const counts = {added: 0, removed: 0, modified: 0};
        changes.forEach(change => counts[change.kind]++);
        return {changes, counts};
    }

    function report(result, options = {}) {
        const lines = ["Сравнение текста", `Регистр: ${options.ignoreCase ? "игнорируется" : "учитывается"}`,
            `Пробелы и табы в конце строк: ${options.ignoreTrailing ? "игнорируются" : "учитываются"}`,
            `Добавлено: ${result.counts.added}; удалено: ${result.counts.removed}; изменено: ${result.counts.modified}`, ""];
        if (!result.changes.length) lines.push("Отличий нет.");
        for (const change of result.changes) {
            if (change.kind === "added") lines.push(`+ Строка ${change.rightNumber}: ${change.rightText}`);
            else if (change.kind === "removed") lines.push(`− Строка ${change.leftNumber}: ${change.leftText}`);
            else lines.push(`~ Строка ${change.leftNumber} → ${change.rightNumber}:`,
                `− ${change.leftText}`, `+ ${change.rightText}`);
        }
        return lines.join("\n");
    }
    const api = {MAX_BYTES, MAX_LINES, prepare, compare, report};
    globalThis.QATextCompareCore = api;
    if (typeof module !== "undefined") module.exports = api;
})();
