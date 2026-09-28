// Derives the oracle's inputs from an ICU checkout, so that what is tested is everything the data mentions rather
// than a hand-picked sample.
//
//   bun prepare.ts <icu repository> <output dir>

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, outDir] = process.argv.slice(2);
if (!repo || !outDir) throw new Error("usage: prepare.ts <icu repository> <output dir>");
const source = join(repo, "icu4c/source");
const data = join(source, "data");
mkdirSync(outDir, { recursive: true });

const save = (name: string, value: unknown) => writeFileSync(join(outDir, name + ".json"), JSON.stringify(value));
const stems = (dir: string) =>
  readdirSync(join(data, dir))
    .filter(f => f.endsWith(".txt"))
    .map(f => f.slice(0, -4))
    .sort();

// ─── ICU resource bundle text ───

type Res = string | Res[] | { [key: string]: Res };

/** Enough of genrb's grammar to read the shipped bundles: tables, arrays, strings; other types come out as strings. */
function parseBundle(text: string): { [key: string]: Res } {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /[\s\ufeff]/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) i = text.indexOf("\n", i) >>> 0;
      else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) + 2;
      else return;
    }
  };
  const quoted = (): string => {
    let out = "";
    i++;
    while (text[i] !== '"') {
      if (text[i] === "\\") {
        const c = text[i + 1]!;
        if (c === "u") ((out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))), (i += 6));
        else if (c === "U") ((out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 10), 16))), (i += 10));
        else ((out += c), (i += 2));
      } else out += text[i++];
    }
    i++;
    return out;
  };
  const bare = (): string => {
    const start = i;
    while (i < text.length && !/[\s{},:"]/.test(text[i]!)) i++;
    return text.slice(start, i);
  };
  const token = () => (text[i] === '"' ? quoted() : bare());

  /** After the `{`. */
  const body = (): Res => {
    skip();
    if (text[i] === "}") return (i++, "");
    const strings: Res[] = [];
    const table: { [key: string]: Res } = {};
    let isTable = false;
    let sawComma = false;
    for (;;) {
      skip();
      if (text[i] === "}") {
        i++;
        break;
      }
      if (text[i] === ",") {
        i++;
        sawComma = true;
        continue;
      }
      if (text[i] === "{") {
        i++;
        strings.push(body());
        sawComma = true;
        continue;
      }
      const wasQuoted = text[i] === '"';
      let value = token();
      skip();
      if (text[i] === ":") {
        i++;
        bare();
        if (text[i] === "(") i = text.indexOf(")", i) + 1;
        skip();
      }
      if (text[i] === "{") {
        i++;
        table[value] = body();
        isTable = true;
        continue;
      }
      // Adjacent quoted strings are one string.
      while (wasQuoted && text[i] === '"') {
        value += quoted();
        skip();
      }
      strings.push(value);
    }
    if (isTable) return table;
    return strings.length === 1 && !sawComma ? strings[0]! : strings;
  };

  skip();
  bare();
  skip();
  if (text[i] === ":") {
    i++;
    bare();
    if (text[i] === "(") i = text.indexOf(")", i) + 1;
    skip();
  }
  i++;
  return body() as { [key: string]: Res };
}

const bundle = (path: string) => parseBundle(readFileSync(join(data, path), "utf8"));
const keys = (res: Res | undefined) => (res && typeof res === "object" && !Array.isArray(res) ? Object.keys(res) : []);

// ─── Locales ───

const toBcp47 = (id: string): string | undefined => {
  if (id === "root") return "und";
  if (id === "en_US_POSIX") return "en-US-u-va-posix";
  if (/__|_$|_TRADITIONAL$/.test(id)) return undefined;
  const tag = id.replaceAll("_", "-");
  // ICU's own legacy identifiers (no_NO_NY) are not language tags.
  try {
    Intl.getCanonicalLocales(tag);
  } catch {
    return undefined;
  }
  return tag;
};
const locales = (dir: string) => [...new Set(stems(dir).flatMap(id => toBcp47(id) ?? []))];
const all = new Set<string>();
for (const dir of ["locales", "curr", "lang", "region", "unit", "zone", "coll", "brkitr", "rbnf"]) {
  for (const l of locales(dir)) {
    if (!/^(supplementalData|tzdbNames)$/.test(l)) all.add(l);
  }
}
// Nothing has data for these: what falls back, and to what, is behaviour too.
for (const l of ["xx", "en-XX", "de-Latn-XX", "zh-Hant-US", "sr-Latn-XK", "pt-Latn", "und-Arab", "und-JP", "tlh"])
  all.add(l);
save("locales", [...all].sort());
save("collLocales", locales("coll"));

// ─── Display name codes ───

const union = (dir: string, table: string) => {
  const found = new Set<string>();
  for (const stem of stems(dir)) {
    if (stem === "supplementalData" || stem === "tzdbNames") continue;
    for (const k of keys(bundle(`${dir}/${stem}.txt`)[table])) found.add(k);
  }
  return [...found].sort();
};
const langEn = bundle("lang/en.txt");
save("codes", {
  languages: union("lang", "Languages").map(l => l.replaceAll("_", "-")),
  scripts: union("lang", "Scripts"),
  variants: union("lang", "Variants").map(v => v.toLowerCase()),
  regions: union("region", "Countries"),
  currencies: union("curr", "Currencies"),
  keys: keys(langEn.Keys),
  types: Object.fromEntries(keys(langEn.Types).map(k => [k, keys((langEn.Types as any)[k])])),
});

// ─── Canonicalization ───

const metadata = bundle("misc/metadata.txt");
const alias = metadata.alias as { [key: string]: Res };
const keyTypeData = bundle("misc/keyTypeData.txt");
const nested = (res: Res | undefined) => Object.fromEntries(keys(res).map(k => [k, keys((res as any)[k])]));
save("aliases", {
  language: keys(alias.language).map(l => l.replaceAll("_", "-")),
  script: keys(alias.script),
  territory: keys(alias.territory),
  variant: keys(alias.variant).map(v => v.toLowerCase()),
  subdivision: keys(alias.subdivision),
  keyMap: Object.entries(keyTypeData.keyMap as object).flat(),
  typeMap: Object.fromEntries(
    keys(keyTypeData.typeMap).map(k => [k, Object.entries((keyTypeData.typeMap as any)[k]).flat()]),
  ),
  typeAlias: nested(keyTypeData.typeAlias),
  bcpTypeAlias: nested(keyTypeData.bcpTypeAlias),
});

// ─── Time zones ───

const zoneinfo = bundle("misc/zoneinfo64.txt");
const timezoneTypes = bundle("misc/timezoneTypes.txt");
const zoneIds = new Set<string>(zoneinfo.Names as string[]);
for (const table of ["typeMap", "typeAlias"]) {
  for (const k of keys((timezoneTypes[table] as any)?.timezone)) zoneIds.add(k.replaceAll(":", "/"));
}
for (const k of keys(bundle("misc/windowsZones.txt").mapTimezones)) zoneIds.add(k);
save("zones", [...zoneIds].sort());

// A zone's names come from its metazone, and which that is has changed over time: two instants, half a year apart
// where there is room, inside each period a zone spent in a metazone.
const periods: Record<string, number[]> = {};
for (const [zone, list] of Object.entries(bundle("misc/metaZones.txt").metazoneInfo as Record<string, Res>)) {
  const entries = (Array.isArray(list) && Array.isArray(list[0]) ? list : [list]) as Res[];
  if (entries.length < 2) continue;
  const instants: number[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const from = Date.parse((entry[1] as string).replace(" ", "T") + "Z");
    const to = Math.min(Date.parse((entry[2] as string).replace(" ", "T") + "Z"), Date.UTC(2030, 0, 1));
    const step = Math.min((to - from) / 3, 182 * 86400000);
    instants.push(Math.round(from + step), Math.round(from + 2 * step));
  }
  periods[zone.replaceAll(":", "/")] = instants;
}
save("zonePeriods", periods);

// ─── Units: every identifier the data has a name for ───

const unitsEn = bundle("unit/en.txt").units as Record<string, Res>;
const unitIds = new Set<string>();
for (const category of keys(unitsEn)) for (const unit of keys(unitsEn[category])) unitIds.add(unit);
save("unitIds", [...unitIds].sort());

// ─── Collation: every string a tailoring mentions ───

const tailored: Record<string, Record<string, string[]>> = {};
for (const stem of stems("coll")) {
  const collations = bundle(`coll/${stem}.txt`).collations;
  for (const type of keys(collations)) {
    const rules = (collations as any)[type].Sequence;
    if (typeof rules !== "string") continue;
    const found = new Set<string>();
    // Reset and relation operators separate the strings; `<*` and friends introduce a list of single characters.
    for (const part of rules.replace(/\[[^\]]*\]/g, " ").split(/(?=&|<<<\*?|<<\*?|<\*?|=\*?)/)) {
      const m = /^(&|<<<\*?|<<\*?|<\*?|=\*?)\s*([^]*)$/.exec(part);
      if (!m) continue;
      const text = m[2]!.replace(/'([^']*)'/g, "$1").replace(/\s+/g, "");
      if (m[1]!.endsWith("*")) for (const c of text.replaceAll("-", "")) found.add(c);
      else for (const piece of text.split(/[|/]/)) if (piece) found.add(piece);
    }
    (tailored[stem] ??= {})[type] = [...found];
  }
}
save("tailored", tailored);

// ─── Corpora ───

const lines = (path: string) => readFileSync(join(source, path), "utf8").split("\n");
const fromHex = (hex: string) =>
  String.fromCodePoint(
    ...hex
      .trim()
      .split(/\s+/)
      .map(h => parseInt(h, 16)),
  );

for (const dict of stems("brkitr/dictionaries")) {
  const words = lines(`data/brkitr/dictionaries/${dict}.txt`)
    .map(l => l.replace(/^\ufeff/, "").replace(/#.*/, "").split("\t")[0]!.trim())
    .filter(Boolean);
  save("dict-" + dict, words);
}

save(
  "breakTests",
  Object.fromEntries(
    ["Grapheme", "Word", "Sentence"].map(kind => [
      kind.toLowerCase(),
      lines(`test/testdata/${kind}BreakTest.txt`)
        .map(l => l.replace(/#.*/, "").replace(/[÷×]/g, " ").trim())
        .filter(Boolean)
        .map(fromHex),
    ]),
  ),
);

save(
  "emojiSequences",
  ["emoji-sequences.txt", "emoji-zwj-sequences.txt"].flatMap(file =>
    lines(`data/unidata/${file}`)
      .map(l => l.replace(/#.*/, "").split(";")[0]!.trim())
      .filter(l => l && !l.includes(".."))
      .map(fromHex),
  ),
);

save(
  "normalizationTest",
  lines("data/unidata/NormalizationTest.txt")
    .filter(l => /^[0-9A-F]/.test(l))
    .map(l => fromHex(l.split(";")[0]!)),
);

save(
  "idnaTest",
  lines("test/testdata/IdnaTestV2.txt")
    .map(l => l.replace(/#.*/, "").split(";")[0]!.trim())
    .filter(Boolean)
    .map(s =>
      s
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x\{([0-9A-Fa-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16))),
    ),
);

save(
  "collationTest",
  lines("test/testdata/CollationTest_NON_IGNORABLE_SHORT.txt")
    .map(l => l.replace(/[#;].*/, "").trim())
    .filter(l => /^[0-9A-F ]+$/.test(l))
    .map(fromHex)
    // Lone surrogates cannot be hashed as text.
    .filter(s => s.isWellFormed()),
);

console.log(`${all.size} locales, ${zoneIds.size} zone ids → ${outDir}`);
