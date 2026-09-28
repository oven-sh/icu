// Puts the data of a build of ICU by its own makefiles, all of it, into the forms that ../data writes, so that ICU's
// own tests can be run on them.
//
//   node reencode.ts <build directory>/data/out/build/icudt<version>l <directory>/icudt<version>l
//
// With ICU_DATA=<directory>, ICU prefers the files written there to the items of its package.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dictionaryWords, succinctDictionary } from "../data/icu-dict.ts";
import { canCompact, compactTree } from "../data/icu-res.ts";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("usage: reencode.ts <icudt<version>l of a build> <icudt<version>l to write>");

/** The directories that have a pool bundle. */
const TREES = ["", "curr", "lang", "region", "unit", "zone"];

for (const tree of TREES) {
  const bundles = new Map<string, Buffer>();
  let before = 0;
  for (const file of readdirSync(join(from, tree))) {
    if (!file.endsWith(".res") || file === "pool.res") continue;
    const bytes = readFileSync(join(from, tree, file));
    if (!canCompact(bytes)) continue;
    bundles.set(file.slice(0, -".res".length), bytes);
    before += bytes.length;
  }
  const pool = readFileSync(join(from, tree, "pool.res"));
  const archive = compactTree(pool, bundles);
  mkdirSync(join(to, tree), { recursive: true });
  writeFileSync(join(to, tree, "pool.res"), archive);
  console.log(`${tree || "locales"}: ${bundles.size} bundles, ${before + pool.length} -> ${archive.length} bytes`);
}

const words = fileURLToPath(new URL("../../icu4c/source/data/brkitr/dictionaries/cjdict.txt", import.meta.url));
const dictionary = readFileSync(join(from, "brkitr/cjdict.dict"));
const succinct = succinctDictionary(dictionary, dictionaryWords(readFileSync(words, "utf8")));
mkdirSync(join(to, "brkitr"), { recursive: true });
writeFileSync(join(to, "brkitr/cjdict.dict"), succinct);
console.log(`cjdict: ${dictionary.length} -> ${succinct.length} bytes`);
