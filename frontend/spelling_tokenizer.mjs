const WORD = /[\p{L}\p{M}]+(?:['’\-\u2010\u2011][\p{L}\p{M}]+)*/gu;
const TECHNICAL_CANDIDATE = /[\p{L}\p{M}\p{N}._%+@/-]+/gu;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const EXCLUSIONS = [
    /```[\s\S]*?```|```[\s\S]*$/g,
    /`[^`\n]*`/g,
    /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    /(?:\d+(?:[.,:/-]\d+)+|\d+)/g,
    /(?:[A-Za-zА-Яа-яЁё]\.){2,}/g,
];

function isTechnical(value) {
    const characters = [...value];
    for (let index = 0; index < characters.length; index++) {
        const current = characters[index], previous = characters[index - 1], next = characters[index + 1];
        if (current === "_" || /\p{N}/u.test(current)) return true;
        if (previous && /[a-z]/u.test(previous) && /[A-Z]/u.test(current)) return true;
        if ((current === "." || current === "/") && previous && next
            && WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(next)) return true;
    }
    return false;
}

export function lookupWord(word) {
    return word.normalize("NFC").replaceAll("’", "'").replace(/[\u2010\u2011]/g, "-");
}

export function tokenize(text) {
    const ranges = [];
    for (const expression of EXCLUSIONS) {
        expression.lastIndex = 0;
        for (const match of text.matchAll(expression)) ranges.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(TECHNICAL_CANDIDATE)) {
        if (isTechnical(match[0])) ranges.push([match.index, match.index + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of ranges) {
        const last = merged.at(-1);
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    const tokens = [], mixed = [], unchecked = [];
    let range = 0;
    WORD.lastIndex = 0;
    for (const match of text.matchAll(WORD)) {
        const start = match.index, value = match[0], end = start + value.length;
        while (range < merged.length && merged[range][1] <= start) range++;
        if (range < merged.length && merged[range][0] < end) continue;
        const ru = /\p{Script=Cyrillic}/u.test(value);
        const en = /\p{Script=Latin}/u.test(value);
        const other = [...value].some(character => /\p{L}/u.test(character)
            && !/\p{Script=Cyrillic}|\p{Script=Latin}/u.test(character));
        const token = {start, end, value};
        if (ru && en) mixed.push({...token, kind: "mixed"});
        else if (other || !ru && !en) unchecked.push(token);
        else tokens.push({...token, language: ru ? "ru" : "en"});
    }
    return {tokens, mixed, unchecked, skippedCount: merged.length};
}
