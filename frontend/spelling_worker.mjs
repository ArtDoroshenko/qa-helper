import nspell from "nspell";
import {lookupWord, tokenize} from "./spelling_tokenizer.mjs";

const dictionaries = new Map();
const suggestionCache = new Map();
const MAX_POINTS = 20000;

function checkLimit(text) {
    if (typeof text !== "string") throw new Error("Текст должен быть строкой.");
    let count = 0;
    for (const point of text) if (++count > MAX_POINTS) throw new Error("Не больше 20 000 символов Unicode. Текст не обрезан.");
}

async function dictionary(language) {
    if (!dictionaries.has(language)) {
        const root = new URL("../vendor/spelling/", self.location.href);
        const load = async extension => {
            const url = new URL(`${language}.${extension}`, root);
            const response = await fetch(url, {credentials: "same-origin"});
            if (!response.ok) throw new Error(`Не удалось загрузить словарь ${language.toUpperCase()}.`);
            return new TextDecoder("utf-8", {fatal: true}).decode(await response.arrayBuffer());
        };
        const pending = Promise.all([load("aff"), load("dic")]).then(([aff, dic]) => nspell(aff, dic));
        dictionaries.set(language, pending);
        pending.catch(() => dictionaries.delete(language));
    }
    return dictionaries.get(language);
}

function correct(spell, raw, language) {
    const word = lookupWord(raw);
    if (spell.correct(word)) return true;
    const lowered = word.toLocaleLowerCase(language === "ru" ? "ru" : "en-US");
    const title = word.length > 1 && word[0] !== lowered[0] && word.slice(1) === lowered.slice(1);
    return title && spell.correct(lowered);
}

async function check(text) {
    checkLimit(text);
    const scan = tokenize(text);
    const needed = [...new Set(scan.tokens.map(token => token.language))];
    const spell = Object.fromEntries(await Promise.all(needed.map(async language => [language, await dictionary(language)])));
    const issues = [...scan.mixed.map(item => ({...item, id: item.start, language: null, suggestions: []}))];
    for (const token of scan.tokens) {
        const engine = spell[token.language];
        if (correct(engine, token.value, token.language)) continue;
        if (/[-\u2010\u2011]/u.test(token.value)) {
            for (const part of token.value.matchAll(/[^-\u2010\u2011]+/gu)) {
                if (correct(engine, part[0], token.language)) continue;
                const start = token.start + part.index;
                issues.push({id: start, start, end: start + part[0].length, value: part[0],
                    language: token.language, kind: "unknown", suggestions: []});
            }
        } else issues.push({...token, id: token.start, kind: "unknown", suggestions: []});
    }
    issues.sort((a, b) => a.start - b.start);
    return {issues, checkedCount: scan.tokens.length, skippedCount: scan.skippedCount, uncheckedCount: scan.unchecked.length};
}

async function suggest(language, word) {
    if (!["ru", "en"].includes(language) || typeof word !== "string") throw new Error("Некорректное слово для подсказок.");
    if ([...word].length > 64) return {suggestions: [], note: "Для слов длиннее 64 символов варианты не подбираются."};
    const key = `${language}\0${word}`;
    if (suggestionCache.has(key)) return {suggestions: suggestionCache.get(key)};
    const spell = await dictionary(language);
    const values = [];
    for (const item of spell.suggest(lookupWord(word))) {
        if (typeof item === "string" && spell.correct(item) && !values.includes(item)) values.push(item);
        if (values.length === 5) break;
    }
    suggestionCache.set(key, values);
    return {suggestions: values};
}

self.onmessage = async event => {
    const {id, type} = event.data || {};
    try {
        const result = type === "check" ? await check(event.data.text)
            : type === "suggest" ? await suggest(event.data.language, event.data.word)
                : (() => { throw new Error("Неизвестная операция."); })();
        self.postMessage({id, ok: true, result});
    } catch (error) {
        self.postMessage({id, ok: false, error: error.message || "Не удалось проверить текст."});
    }
};
