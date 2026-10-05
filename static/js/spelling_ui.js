(() => {
    "use strict";
    function mount(root, engine) {
        if (!root || !engine || typeof engine.check !== "function" || typeof engine.suggest !== "function" || !globalThis.QASpellingCore) {
            throw new Error("Для орфографии нужен подключённый словарный движок.");
        }
        const core = globalThis.QASpellingCore;
        const by = selector => root.querySelector(selector);
        const input = by("[data-spelling-input]"), sourceView = by("[data-spelling-source]");
        const outputView = by("[data-spelling-output]"), counter = by("[data-spelling-counter]");
        const check = by("[data-spelling-check]"), build = by("[data-spelling-build]");
        const edit = by("[data-spelling-edit]"), copy = by("[data-spelling-copy]");
        const status = by("[data-spelling-status]"), resultStatus = by("[data-spelling-result-status]");
        const choices = by("[data-spelling-choices]"), suggestions = by("[data-spelling-suggestions]");
        const choiceTitle = by("[data-spelling-choice-title]"), context = by("[data-spelling-context]");
        const undoBar = by("[data-spelling-undo-bar]");
        const example = "Превет! Проверьте пожалуста этот текст.\nПожалуста, сохраните API и QA без изменений.\nThis is a tehst.";
        let session = null, activeIssue = null, revision = 0, controller = null, pending = false;
        let choiceController = null, choiceRevision = 0;
        let outputRevision = 0, outputPending = false;
        const issuesById = new Map(), sourceNodes = new Map(), outputNodes = new Map();
        const nextBatch = () => new Promise(resolve => setTimeout(resolve, 0));

        function message(value, error = false) {
            status.textContent = value;
            status.classList.toggle("error", error);
        }
        function pointCount(value) {
            let count = 0;
            for (const point of value) if (++count > core.MAX_POINTS) break;
            return count;
        }
        function updateCounter() {
            const count = pointCount(input.value), overflow = count > core.MAX_POINTS;
            counter.textContent = overflow ? "Более 20 000 / 20 000 символов"
                : `${count.toLocaleString("ru-RU")} / 20 000 символов`;
            counter.classList.toggle("error", overflow);
            check.disabled = pending || overflow;
            if (overflow) message("Превышен предел 20 000 символов Unicode. Текст не обрезан.", true);
            return !overflow;
        }
        function invalidate() {
            revision++; outputRevision++;
            if (controller) { controller.abort(); controller = null; }
            closeChoice();
            pending = false;
            session = null;
            activeIssue = null;
            outputPending = false;
            issuesById.clear(); sourceNodes.clear(); outputNodes.clear();
            input.hidden = false;
            sourceView.hidden = true;
            edit.hidden = true;
            choices.hidden = true;
            outputView.hidden = false;
            outputView.textContent = "Результат появится после формирования.";
            resultStatus.textContent = "Исправления применяются только по вашему выбору";
            build.disabled = true;
            copy.disabled = true;
            undoBar.hidden = true;
            if (updateCounter()) message("Текст изменён. Проверьте его снова.");
        }
        function controls() {
            build.disabled = outputPending || !session;
            copy.disabled = outputPending || !session || session.output === null || session.stale;
            undoBar.hidden = outputPending || !session || session.output === null || session.appliedIds.length === 0;
            resultStatus.textContent = outputPending ? "Формируем результат…"
                : session?.stale ? "Результат требует обновления"
                : session && session.output !== null ? "Результат сформирован" : "Исправления применяются только по вашему выбору";
            if (session?.stale) message("Результат требует обновления. Сформируйте его снова.");
        }
        function updateIssueNode(issue) {
            const button = sourceNodes.get(issue.id);
            if (!button) return;
            const choice = session.decisions.get(issue.id);
            const label = choice?.type === "replace" ? `Выбрана замена: ${choice.replacement}`
                : choice?.type === "keep" || choice?.type === "skip" ? "Оставлено без замены"
                    : issue.kind === "mixed" ? "Смешаны кириллица и латиница" : "Нет в словаре";
            button.className = `spelling-issue${choice ? ` spelling-${choice.type}` : ""}`;
            button.setAttribute("aria-label", `${label}. Слово «${issue.value}». Открыть варианты.`);
        }
        function issueButton(issue) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = issue.value;
            button.addEventListener("click", () => openChoice(issue.id));
            sourceNodes.set(issue.id, button);
            updateIssueNode(issue);
            return button;
        }
        async function renderSource(current, token) {
            sourceView.replaceChildren();
            sourceNodes.clear();
            let cursor = 0, batch = document.createDocumentFragment(), count = 0;
            for (const issue of current.issues) {
                if (current !== session || token !== revision) return false;
                batch.append(document.createTextNode(current.source.slice(cursor, issue.start)), issueButton(issue));
                cursor = issue.end;
                if (++count % 100 === 0) {
                    sourceView.append(batch);
                    batch = document.createDocumentFragment();
                    await nextBatch();
                }
            }
            if (current !== session || token !== revision) return false;
            batch.append(document.createTextNode(current.source.slice(cursor)));
            sourceView.append(batch);
            return true;
        }
        async function renderOutput() {
            const current = session, token = ++outputRevision;
            outputView.replaceChildren();
            outputNodes.clear();
            if (!current || current.output === null) return;
            outputPending = true; outputView.hidden = true; controls();
            let cursor = 0, batch = document.createDocumentFragment(), count = 0;
            for (const issue of current.issues) {
                if (current !== session || token !== outputRevision) return false;
                if (!current.applied.has(issue.id)) continue;
                batch.append(document.createTextNode(current.source.slice(cursor, issue.start)));
                const button = document.createElement("button");
                button.type = "button";
                button.className = "spelling-applied";
                button.textContent = current.applied.get(issue.id);
                button.setAttribute("aria-label", `Отменить замену «${issue.value}» на «${button.textContent}»`);
                button.addEventListener("click", () => undo(issue.id));
                outputNodes.set(issue.id, button);
                batch.append(button);
                cursor = issue.end;
                if (++count % 100 === 0) {
                    outputView.append(batch);
                    batch = document.createDocumentFragment();
                    await nextBatch();
                }
            }
            if (current !== session || token !== outputRevision) return false;
            batch.append(document.createTextNode(current.source.slice(cursor)));
            outputView.append(batch);
            outputPending = false;
            outputView.hidden = false;
            controls();
            return true;
        }
        async function openChoice(id) {
            if (!session) return;
            const issue = issuesById.get(id);
            if (!issue) return;
            closeChoice();
            activeIssue = id;
            choiceTitle.textContent = issue.kind === "mixed" ? `Смешаны алфавиты: «${issue.value}»` : `Нет в словаре: «${issue.value}»`;
            context.textContent = session.source.slice(Math.max(0, issue.start - 32), Math.min(session.source.length, issue.end + 32));
            choices.hidden = false;
            const keep = by("[data-spelling-keep]");
            if (issue.kind === "mixed") {
                suggestions.replaceChildren(document.createTextNode("Автоматические варианты для смешанных алфавитов не предлагаются."));
                keep.focus();
                return;
            }
            if (issue.suggestionsLoaded) {
                showSuggestions(issue, "");
                return;
            }
            suggestions.replaceChildren(document.createTextNode("Подбираем варианты…"));
            keep.focus();
            const token = ++choiceRevision;
            choiceController = new AbortController();
            try {
                const answer = await engine.suggest(issue, {signal: choiceController.signal});
                if (token !== choiceRevision || activeIssue !== id || !session) return;
                issue.suggestions = [...new Set((answer.suggestions || []).filter(value => typeof value === "string"))].slice(0, 5);
                issue.suggestionsLoaded = true;
                showSuggestions(issue, answer.note || "");
            } catch (error) {
                if (token === choiceRevision && activeIssue === id) {
                    suggestions.replaceChildren(document.createTextNode(error.message || "Не удалось получить варианты."));
                }
            } finally {
                if (token === choiceRevision) choiceController = null;
            }
        }
        function showSuggestions(issue, note) {
            suggestions.replaceChildren();
            for (const value of issue.suggestions) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "secondary-action";
                button.textContent = value;
                button.addEventListener("click", () => choose({type: "replace", replacement: value}));
                suggestions.append(button);
            }
            if (!issue.suggestions.length) suggestions.append(document.createTextNode(note || "Вариантов нет. Можно оставить слово без изменения."));
            (suggestions.querySelector("button") || by("[data-spelling-keep]")).focus();
        }
        function closeChoice() {
            choiceRevision++;
            if (choiceController) { choiceController.abort(); choiceController = null; }
            activeIssue = null; choices.hidden = true;
        }
        function choose(decision) {
            if (!session || activeIssue === null) return;
            const issue = issuesById.get(activeIssue);
            session.decide(activeIssue, decision);
            closeChoice(); updateIssueNode(issue); controls();
        }
        function undo(id) {
            if (!session || outputPending) return;
            const issue = issuesById.get(id);
            session.undo(id);
            if (issue) updateIssueNode(issue);
            const button = outputNodes.get(id);
            if (button) {
                button.replaceWith(document.createTextNode(issue.value));
                outputNodes.delete(id);
            }
            controls();
            message(session.stale ? "Результат требует обновления. Новые решения не применены." : "Замена отменена.");
        }
        input.addEventListener("input", invalidate);
        by("[data-spelling-example]").addEventListener("click", () => { input.value = example; invalidate(); });
        edit.addEventListener("click", () => { input.hidden = false; sourceView.hidden = true; edit.hidden = true; input.focus(); });
        by("[data-spelling-close]").addEventListener("click", closeChoice);
        by("[data-spelling-keep]").addEventListener("click", () => choose({type: "keep"}));
        by("[data-spelling-unselect]").addEventListener("click", () => choose(null));
        by("[data-spelling-skip-all]").addEventListener("click", () => {
            if (!session || activeIssue === null) return;
            const selected = issuesById.get(activeIssue);
            session.skipAll(activeIssue); closeChoice();
            const word = selected.value.normalize("NFC");
            for (const issue of session.issues) if (issue.language === selected.language
                && issue.value.normalize("NFC") === word) updateIssueNode(issue);
            controls();
        });
        check.addEventListener("click", async () => {
            if (pending || !updateCounter()) return;
            if (!input.value.trim()) { message("Введите текст для проверки.", true); return; }
            revision++; outputRevision++;
            const token = revision, source = input.value;
            if (controller) controller.abort();
            controller = new AbortController();
            pending = true; check.disabled = true;
            session = null; outputPending = false; outputNodes.clear(); issuesById.clear(); sourceNodes.clear();
            closeChoice(); build.disabled = true; copy.disabled = true;
            input.hidden = false; sourceView.hidden = true; edit.hidden = true;
            undoBar.hidden = true; outputView.hidden = false;
            outputView.textContent = "Результат появится после формирования.";
            message("Проверяем написание слов…");
            try {
                const checked = await engine.check(source, {signal: controller.signal});
                if (token !== revision) return;
                session = core.createSession(source, checked.issues);
                issuesById.clear();
                for (const issue of session.issues) issuesById.set(issue.id, issue);
                message("Готовим замечания к просмотру…");
                if (!await renderSource(session, token)) return;
                input.hidden = true; sourceView.hidden = false; edit.hidden = false;
                controls();
                const parts = [];
                if (checked.issues.length) parts.push(`Замечаний: ${checked.issues.length}. Выберите исправления вручную.`);
                else if (!checked.checkedCount) parts.push("Русских и английских слов для проверки нет.");
                else if (checked.uncheckedCount) parts.push("Проверка RU/EN слов завершена; часть текста не проверена.");
                else parts.push("Замечаний по написанию русских и английских слов не найдено.");
                if (checked.uncheckedCount) parts.push(`Не проверено фрагментов других алфавитов: ${checked.uncheckedCount}.`);
                if (checked.skippedCount) parts.push(`Пропущено технических фрагментов: ${checked.skippedCount}.`);
                message(parts.join(" "));
            } catch (error) {
                if (token === revision) message(error.message || "Не удалось проверить текст.", true);
            } finally {
                if (token === revision) { pending = false; controller = null; updateCounter(); }
            }
        });
        build.addEventListener("click", async () => {
            if (!session || outputPending) return;
            const current = session;
            session.build();
            if (!await renderOutput() || current !== session) return;
            message(session.stale ? "Результат требует обновления. Сформируйте его снова."
                : session.appliedIds.length ? "Результат сформирован из выбранных замен."
                    : "Результат совпадает с исходным текстом.");
        });
        by("[data-spelling-undo]").addEventListener("click", () => { if (session) undo(session.appliedIds.at(-1)); });
        by("[data-spelling-reset]").addEventListener("click", () => {
            if (!session) return;
            const changed = [...session.decisions.keys()];
            session.reset();
            for (const id of changed) {
                const issue = issuesById.get(id);
                if (issue) updateIssueNode(issue);
            }
            outputRevision++; outputPending = false; outputNodes.clear();
            outputView.hidden = false;
            outputView.replaceChildren(document.createTextNode(session.source));
            controls(); message("Все замены сброшены к исходному тексту.");
        });
        copy.addEventListener("click", async () => {
            if (!session || session.output === null || session.stale) return;
            const token = revision, value = session.output;
            try {
                await navigator.clipboard.writeText(value);
                if (token === revision && !session.stale) message("Результат скопирован.");
            } catch (error) { if (token === revision) message("Не удалось скопировать результат.", true); }
        });
        updateCounter();
        return {get session() { return session; }};
    }
    globalThis.QASpellingUI = {mount};
    if (typeof module !== "undefined") module.exports = {mount};
})();
