import {createRequire} from "node:module";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = join(root, "static");
const dictionaryRoot = join(staticRoot, "vendor", "spelling");
const licenses = join(dictionaryRoot, "licenses");

async function copy(source, target) {
    const data = await readFile(source);
    await mkdir(dirname(target), {recursive: true});
    try {
        if (data.equals(await readFile(target))) return;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    await writeFile(target, data);
}

for (const [code, packageName] of [["ru", "dictionary-ru"], ["en", "dictionary-en"]]) {
    const directory = join(root, "node_modules", packageName);
    for (const extension of ["aff", "dic"]) {
        await copy(join(directory, `index.${extension}`), join(dictionaryRoot, `${code}.${extension}`));
    }
    await copy(join(directory, "license"), join(licenses, `${packageName}.LICENSE`));
}
const nspellEntry = require.resolve("nspell");
const dependencyRequire = createRequire(nspellEntry);
const isBufferDirectory = dirname(dependencyRequire.resolve("is-buffer/package.json"));
await copy(join(root, "node_modules", "nspell", "license"), join(licenses, "nspell.LICENSE"));
await copy(join(isBufferDirectory, "LICENSE"), join(licenses, "is-buffer.LICENSE"));
await copy(join(root, "node_modules", "esbuild", "LICENSE.md"), join(licenses, "esbuild.LICENSE"));
await writeFile(join(licenses, "NOTICE.txt"),
    "QA Helper spelling assets (same-origin, built from pinned pnpm-lock.yaml)\n" +
    "dictionary-ru 3.0.0: BSD-3-Clause; full upstream notice in dictionary-ru.LICENSE\n" +
    "dictionary-en 4.0.0: MIT AND BSD; full upstream notice in dictionary-en.LICENSE\n" +
    "nspell 2.1.5: MIT; full upstream notice in nspell.LICENSE\n" +
    "is-buffer 2.0.5: MIT; full upstream notice in is-buffer.LICENSE\n" +
    "esbuild 0.28.2: MIT (build-time only); notice in esbuild.LICENSE\n" +
    "Sources: https://github.com/wooorm/dictionaries , https://github.com/wooorm/nspell , https://github.com/evanw/esbuild\n");

await build({
    entryPoints: [join(root, "frontend", "spelling_worker.mjs")],
    outfile: join(staticRoot, "js", "spelling_worker.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
});
console.log("Spelling worker and local dictionaries built.");
