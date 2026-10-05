importScripts("converter_core.js?v=20261005-converter");

self.onmessage = async ({data}) => {
    try {
        const bytes = new Uint8Array(data.buffer);
        if (data.mode === "file") self.QAConverterCore.validateHashFileSize(bytes.byteLength);
        const digest = await self.QAConverterCore.hashBytes(bytes, data.algorithm, self.crypto?.subtle);
        self.postMessage({id: data.id, ok: true, digest, size: bytes.byteLength});
    } catch (error) {
        self.postMessage({id: data.id, ok: false, error: error.message || "Не удалось вычислить хеш."});
    }
};
