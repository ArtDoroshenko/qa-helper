(() => {
    "use strict";
    const MAX_POINTS = 20000;

    function validate(text) {
        if (typeof text !== "string") throw new Error("Текст должен быть строкой.");
        let points = 0;
        for (const point of text) {
            points++;
            if (points > MAX_POINTS) throw new Error("Не больше 20 000 символов Unicode. Текст не обрезан.");
        }
        return points;
    }

    function createSession(source, issues) {
        validate(source);
        const list = [...issues].sort((a, b) => a.start - b.start);
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (!Number.isInteger(item.id) || !Number.isInteger(item.start) || !Number.isInteger(item.end)
                || item.end <= item.start || !Array.isArray(item.suggestions)
                || item.suggestions.some(value => typeof value !== "string")
                || item.end > source.length || source.slice(item.start, item.end) !== item.value
                || (i && item.start < list[i - 1].end)) throw new Error("Некорректные позиции замечаний.");
        }
        const byId = new Map(list.map(item => [item.id, item]));
        if (byId.size !== list.length) throw new Error("Некорректные идентификаторы замечаний.");
        const decisions = new Map(), applied = new Map(), snapshot = new Map();
        let output = null, order = [];
        const compose = () => {
            let result = "", cursor = 0;
            for (const item of list) {
                if (!applied.has(item.id)) continue;
                result += source.slice(cursor, item.start) + applied.get(item.id);
                cursor = item.end;
            }
            return result + source.slice(cursor);
        };
        const stale = () => {
            if (output === null) return false;
            if (decisions.size !== snapshot.size) return true;
            for (const [id, value] of decisions) {
                const saved = snapshot.get(id);
                if (!saved || saved.type !== value.type || saved.replacement !== value.replacement) return true;
            }
            return false;
        };
        const decide = (id, decision) => {
            const item = byId.get(id);
            if (!item) throw new Error("Замечание не найдено.");
            if (decision === null) { decisions.delete(id); return; }
            if (decision.type === "replace") {
                if (!item.suggestions.includes(decision.replacement)) throw new Error("Нет такого варианта замены.");
                decisions.delete(id);
                decisions.set(id, {type: "replace", replacement: decision.replacement});
            } else if (decision.type === "keep" || decision.type === "skip") {
                decisions.set(id, {type: decision.type});
            } else throw new Error("Некорректный выбор.");
        };
        return {
            source, issues: list, decisions, applied,
            get output() { return output; }, get stale() { return stale(); },
            decide,
            skipAll(id) {
                const item = byId.get(id);
                if (!item) throw new Error("Замечание не найдено.");
                const word = item.value.normalize("NFC");
                for (const other of list) if (other.language === item.language && other.value.normalize("NFC") === word) {
                    decide(other.id, {type: "skip"});
                }
            },
            build() {
                applied.clear(); snapshot.clear();
                for (const [id, decision] of decisions) {
                    snapshot.set(id, {...decision});
                    if (decision.type === "replace") applied.set(id, decision.replacement);
                }
                order = [...decisions.keys()].filter(id => applied.has(id));
                output = compose();
                return output;
            },
            undo(id) {
                if (!applied.has(id)) return output;
                applied.delete(id); decisions.delete(id); snapshot.delete(id);
                order = order.filter(value => value !== id);
                output = compose();
                return output;
            },
            undoLast() { return order.length ? this.undo(order[order.length - 1]) : output; },
            reset() {
                decisions.clear(); applied.clear(); snapshot.clear(); order = [];
                output = source;
                return output;
            },
            get appliedIds() { return [...order]; },
        };
    }
    const api = {MAX_POINTS, validate, createSession};
    globalThis.QASpellingCore = api;
    if (typeof module !== "undefined") module.exports = api;
})();
