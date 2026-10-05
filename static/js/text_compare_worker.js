importScripts("text_compare_core.js");

self.onmessage = event => {
    try {
        const {left, right, options} = event.data;
        self.postMessage({ok: true, result: self.QATextCompareCore.compare(left, right, options)});
    } catch (error) {
        self.postMessage({ok: false, error: error.message || "Не удалось сравнить текст."});
    }
};
