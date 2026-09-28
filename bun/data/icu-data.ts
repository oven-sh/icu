/**
 * Builds the ICU data package that Bun ships from the text sources in `icu4c/source/data`.
 *
 * This is ICU's own data build (`data/BUILDRULES.py`, run by the Python
 * `icutools.databuilder`) for the categories Bun has a use for. It runs under node and under bun,
 * and writes the same bytes.
 *
 *   node icu-data.ts --tools <dir> --work <dir> --out <file> [--depfile <file>] [--uncompacted]
 *
 * The tools (gencnval, genrb, genbrk, gendict) are programs for the machine this runs on, built from this
 * source tree: `bin/` of a build directory. If that has shared libraries, its `lib/` has to be where the tools look
 * for them: another ICU's, such as the system's, cannot read this one's collation data.
 * The output is a little-endian ASCII common-data package
 * (`ucmndata.h` UDataOffsetTOC), the same for every target Bun has.
 *
 * It differs from ICU's in what is left out (below), and in the forms of the largest items, which only
 * this ICU reads (icu-res.ts, icu-dict.ts, and what its genrb writes for collation).
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { succinctDictionary } from "./icu-dict.ts";
import { canCompact, compactTree } from "./icu-res.ts";

// ───────────────────────────────────────────────────────────────────────────
// What is built
// ───────────────────────────────────────────────────────────────────────────

/**
 * ICU ships everything CLDR has. Bun reaches ICU through about 200 functions of its C API (what JavaScriptCore's
 * Intl, Date and String call, and Bun.stringWidth, URL and URLPattern), and what those cannot reach is left out.
 * "Cannot reach" is one of, and each entry below says which:
 *
 *   unnamed   No ICU4C source names the key, whole or in part, and no code enumerates the table it is in. CLDR data
 *             that other consumers (ICU4J, CLDR's own tools) read.
 *   unlinked  The only functions that name it are not in Bun: nothing calls them, so the linker dropped them.
 *   refused   ECMA-402 rejects, before ICU sees it, every input that would select it.
 *
 * ../oracle compares what every one of those APIs returns, for every locale, between two builds.
 *
 * Whole BUILDRULES.py categories that are not built (all unlinked): conversion_mappings (ucnv_*), translit
 * (utrans_*), stringprep (usprep_*), confusables (uspoof_*), unames (u_charName), and the LSTM/AdaBoost break
 * engines' models, which ICU's default build leaves out too.
 */

/** Built because the tools need them, and not packaged. */
const NOT_PACKAGED: RegExp[] = [
  // The tools' u_init() loads it. unlinked: ucnv_*.
  /^cnvalias\.icu$/,
  // genbrk resolves properties in the rules through it. unlinked: only u_getIntPropertyValue(InPC, InSC, vo) reads
  // it, and nothing asks for those properties.
  /^ulayout\.icu$/,
  // brkitr's bundles name them as dependencies, which genrb checks. refused: Intl.Segmenter, the only caller of
  // ubrk_open, has the granularities grapheme, word and sentence; ICU itself opens only those three.
  /^brkitr\/(line.*|title)\.brk$/,
];

/** Copied as they are: `icupkg -tl` on a little-endian ASCII file changes nothing. */
const COPIED: Record<string, string> = {
  "ulayout.icu": "in/ulayout.icu",
  // Emoji_Presentation and Emoji_Modifier, which Bun.stringWidth's perCodePoint (node:readline, util.inspect) asks for.
  "uemoji.icu": "in/uemoji.icu",
  // Not nfkc_cf and nfkc_scf (unlinked): normalize() has the forms NFC, NFD, NFKC and NFKD, and nothing asks for the
  // Changes_When_NFKC_Casefolded property.
  "nfkc.nrm": "in/nfkc.nrm",
  "uts46.nrm": "in/uts46.nrm",
};

/** The root collator's data, which the source has as a binary file. */
const ROOT_COLLATION = "in/coll/ucadata-unihan.icu";

/** gendict's options per dictionary (BUILDRULES.py generate_brkitr_dictionaries). */
const DICTIONARIES: Record<string, string[]> = {
  burmesedict: ["--bytes", "--transform", "offset-0x1000"],
  cjdict: ["--uchars"],
  khmerdict: ["--bytes", "--transform", "offset-0x1780"],
  laodict: ["--bytes", "--transform", "offset-0x0e80"],
  thaidict: ["--bytes", "--transform", "offset-0x0e00"],
};

/**
 * The units of Intl.NumberFormat: ECMA-402's table of sanctioned single units. A unit is one of these, or two of
 * them joined by "-per-".
 */
// prettier-ignore
const SANCTIONED_UNITS = [
  "acre", "bit", "byte", "celsius", "centimeter", "day", "degree", "fahrenheit", "fluid-ounce", "foot", "gallon",
  "gigabit", "gigabyte", "gram", "hectare", "hour", "inch", "kilobit", "kilobyte", "kilogram", "kilometer", "liter",
  "megabit", "megabyte", "meter", "microsecond", "mile", "mile-scandinavian", "milliliter", "millimeter",
  "millisecond", "minute", "month", "nanosecond", "ounce", "percent", "petabyte", "pound", "second", "stone",
  "terabit", "terabyte", "week", "yard", "year",
];

/** The grammatical cases, other than the nominative, that a unit is put in when it is part of "A per B". */
const UNIT_CASES = ["accusative"];

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Tree {
  /** Directory under data/. */
  dir: string;
  /** Directory in the package; "" is the top level. */
  out: string;
  /** Share table keys and strings between the tree's bundles through a pool.res. */
  pool: boolean;
  /** Bundles in `dir` that are not locales: built without the pool and left out of res_index. */
  standalone?: string[];
  /**
   * genrb `--filterDir` rules, the same for every bundle of the tree: `-/path` leaves a resource out, `+/path` puts
   * one back, `*` stands for any one key, and a later rule wins.
   */
  filter?: () => string[];
  /** The only bundles built. res_index still lists every locale in `dir`. */
  only?: string[];
}

const leaveOut = (...paths: string[]) => paths.map(path => `-/${path}`);

/** genrb's list of the items a bundle names, for icupkg to check a package by. unnamed. */
const DEPENDENCIES = "%%DEPENDENCY";

const TREES: Tree[] = [
  {
    dir: "locales",
    out: "",
    pool: true,
    filter: () => [
      // unnamed
      ...leaveOut("characterLabel", "personNames", "measurementSystemNames", "NumberElements/minimalPairs"),
      ...leaveOut("calendar/*/DateTimeSkeletons", "calendar/*/DateTimePatterns%relative", "fields/*/relativePeriod"),
      ...["currencyFormat", "accountingFormat"].flatMap(format =>
        ["patterns", "patternsShort"].flatMap(table =>
          leaveOut(
            `NumberElements/*/${table}/${format}%alphaNextToNumber`,
            `NumberElements/*/${table}/${format}%noCurrency`,
          ),
        ),
      ),
      // unnamed, and DateFormatSymbols, which enumerates the table, skips them by their suffix.
      ...["wide", "abbreviated", "narrow"].flatMap(width => leaveOut(`calendar/*/eras/${width}%variant`)),
      // unlinked: ulocdata_*, AlphabeticIndex.
      ...leaveOut("ExemplarCharacters", "AuxExemplarCharacters", "ExemplarCharactersIndex"),
      ...leaveOut("ExemplarCharactersNumbers", "ExemplarCharactersPunctuation", "delimiters", "Ellipsis"),
      // refused: "last Sunday", "in 2 Mondays". Intl.RelativeTimeFormat's units are second to year.
      ...WEEKDAYS.flatMap(day => leaveOut(`fields/${day}`, `fields/${day}-short`, `fields/${day}-narrow`)),
    ],
  },
  { dir: "curr", out: "curr", pool: true, standalone: ["supplementalData"] },
  {
    dir: "lang",
    out: "lang",
    pool: true,
    filter: () => [
      // refused: names of Unicode extension keys and their values. Intl.DisplayNames takes a language identifier
      // without extensions, and of the keys' values only calendars.
      ...leaveOut("Keys", "Types"),
      "+/Types/calendar",
      // unnamed
      ...leaveOut("characterLabelPattern", "codePatterns"),
      ...["long", "menu", "variant", "extension", "core", "secondary", "official"].flatMap(alt =>
        leaveOut(`Languages%${alt}`),
      ),
      ...leaveOut("Scripts%variant", "Scripts%secondary", "Variants%secondary", "Types%variant"),
      // unlinked: uloc_getDisplayScript.
      ...leaveOut("Scripts%stand-alone"),
    ],
  },
  {
    dir: "region",
    out: "region",
    pool: true,
    // unnamed
    filter: () => leaveOut("Countries%variant", "Countries%chagos", "Countries%biot"),
  },
  { dir: "zone", out: "zone", pool: true, standalone: ["tzdbNames"] },
  {
    dir: "unit",
    out: "unit",
    pool: true,
    // refused: every other unit.
    filter: () =>
      ["units", "unitsShort", "unitsNarrow"].flatMap(width => [
        `-/${width}`,
        `+/${width}/compound/per`,
        // No wildcards: where a rule could put something back, genrb keeps every table on the way, empty.
        ...reachableUnits().flatMap(unit => [
          `+/${width}/${unit}`,
          // unlinked: the rest are selected by unitDisplayCase, which no caller sets.
          `-/${width}/${unit}/case`,
          ...UNIT_CASES.map(unitCase => `+/${width}/${unit}/case/${unitCase}`),
        ]),
      ]),
  },
  {
    dir: "coll",
    out: "coll",
    pool: false,
    filter: () => [
      // BUILDRULES.py's own default: the orders that mimic two legacy charsets.
      ...leaveOut("collations/big5han", "collations/gb2312han"),
      // unlinked: ucol_getRulesEx(UCOL_FULL_RULES).
      ...leaveOut("UCARules"),
      // Rules for other tailorings to import, which genrb does from the text. Enumerating the types skips them.
      ...leaveOut("collations/private-kana", "collations/private-pinyin", "collations/private-unihan"),
      ...leaveOut(DEPENDENCIES),
    ],
  },
  {
    dir: "brkitr",
    out: "brkitr",
    pool: false,
    // The rules NOT_PACKAGED leaves out.
    filter: () => [
      ...leaveOut("boundaries/title", "boundaries/line"),
      ...["loose", "normal", "strict"].flatMap(w => leaveOut(`boundaries/line_${w}`, `boundaries/line_${w}_phrase`)),
      ...leaveOut("boundaries/line_phrase"),
      ...leaveOut(DEPENDENCIES),
    ],
  },
  // Nothing in Bun calls RuleBasedNumberFormat, but ICU does: numberingSystems.res declares algorithmic numbering
  // systems whose rules are here, and SimpleDateFormat applies them for the number overrides CLDR attaches to
  // calendar patterns (ja + japanese forces "y=jpanyear", zh + chinese carries "d=hanidays"). checkRbnf() derives
  // this list from the data.
  { dir: "rbnf", out: "rbnf", pool: false, only: ["root", "ja", "zh", "zh_Hant"] },
];

/** data/misc: bundles that are left out, and rules for the ones that are not. */
const MISC_LEFT_OUT = new Set([
  // unlinked: ucurr_getNumericCode, GenderInfo.
  "currencyNumericCodes",
  "genderList",
]);
const MISC_FILTERS: Record<string, string[]> = {
  supplementalData: [
    // unnamed
    ...leaveOut(
      "subdivisionContainment",
      "territoryInfo",
      "languageData",
      "languageMatchingNew",
      "languageMatchingInfo",
    ),
    ...leaveOut("codeMappingsCurrency", "parentLocales", "weekOfPreference", "personNamesDefaults", "weekData%variant"),
    // unlinked: ulocdata_*.
    ...leaveOut("measurementData"),
    // Only ever read under "region".
    ...leaveOut("idValidity"),
    "+/idValidity/region",
  ],
  // unnamed
  metadata: leaveOut("defaultContent"),
  metaZones: leaveOut("metazoneIds"),
  units: leaveOut("unitPrefixes", "unitIdComponents", "unitConstants"),
};

/** Not locales, though they are named like them (BUILDRULES.py generate_tree, ICU-20628). */
const NOT_INSTALLED = new Set([
  "ja_JP_TRADITIONAL",
  "th_TH_TRADITIONAL",
  "de_",
  "de__PHONEBOOK",
  "es_",
  "es__TRADITIONAL",
  "root",
]);

// ───────────────────────────────────────────────────────────────────────────
// Arguments
// ───────────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    tools: { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
    /** Where to write what was read, as a rule for make or ninja. */
    depfile: { type: "string" },
    /** Leaves everything as ICU's tools wrote it, for ../oracle/native to compare what is packaged otherwise with. */
    uncompacted: { type: "boolean" },
  },
});
for (const name of ["tools", "work", "out"] as const) {
  if (args[name] === undefined) die(`--${name} is required`);
}
/** Every file read, for the depfile. */
const inputs = new Set<string>(["./icu-dict.ts", "./icu-res.ts"].map(file => fileURLToPath(new URL(file, import.meta.url))));

const sourceDir = fileURLToPath(new URL("../../icu4c/source", import.meta.url));
const dataDir = join(sourceDir, "data");
const exe = process.platform === "win32" ? ".exe" : "";
const tool = (name: string) => join(args.tools!, name + exe);

const major = /#define U_ICU_VERSION_MAJOR_NUM (\d+)/.exec(read(join(sourceDir, "common/unicode/uvernum.h")))?.[1];
if (major === undefined) die("no U_ICU_VERSION_MAJOR_NUM in uvernum.h");
/** The package's name. The tools find data they need in a directory of this name. */
const pkg = `icudt${major}l`;
const outDir = join(args.work!, pkg);
const tmpDir = join(args.work!, "tmp");

// ───────────────────────────────────────────────────────────────────────────
// Inputs and processes
// ───────────────────────────────────────────────────────────────────────────

function read(path: string): string {
  inputs.add(path);
  return readFileSync(path, "utf8");
}

/** Names, without the extension, of the `.txt` files in a directory under data/. Sorted as Python's sorted() would. */
function stems(dir: string): string[] {
  const found = readdirSync(join(dataDir, dir))
    .filter(f => f.endsWith(".txt"))
    .map(f => f.slice(0, -4))
    .sort((a, b) => (a + ".txt" < b + ".txt" ? -1 : 1));
  for (const stem of found) inputs.add(join(dataDir, dir, stem + ".txt"));
  return found;
}

let running = 0;
const waiting: (() => void)[] = [];
const limit = availableParallelism();

async function run(name: string, argv: string[]): Promise<void> {
  if (running >= limit) await new Promise<void>(resolve => waiting.push(resolve));
  running++;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tool(name), argv, { stdio: ["ignore", "pipe", "pipe"] });
      const output: Buffer[] = [];
      child.stdout.on("data", chunk => output.push(chunk));
      child.stderr.on("data", chunk => output.push(chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) return resolve();
        const shown = argv.length > 24 ? [...argv.slice(0, 24), `… ${argv.length - 24} more`] : argv;
        reject(new Error(`${name} ${shown.join(" ")}\n${code ?? signal}: ${Buffer.concat(output).toString()}`));
      });
    });
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function chunks<T>(items: T[], count: number): T[][] {
  const size = Math.ceil(items.length / count);
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function die(message: string): never {
  console.error(`icu-data: ${message}`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Steps
// ───────────────────────────────────────────────────────────────────────────

const genrb = (srcDir: string, out: string, extra: string[], files: string[]) =>
  run("genrb", ["-s", srcDir, "-d", join(outDir, out), "-i", outDir, ...extra, "-k", ...files.map(f => f + ".txt")]);

/** genrb reads the rules for `<bundle>.txt` from a file of the same name in the directory it is given. */
function filterDir(name: string, bundles: string[], rules: string[]): string[] {
  const dir = join(tmpDir, "filters", name);
  mkdirSync(dir, { recursive: true });
  for (const bundle of bundles) writeFileSync(join(dir, bundle + ".txt"), ["+/", ...rules].join("\n") + "\n");
  return ["--filterDir", dir];
}

/**
 * The sanctioned units, and the units the data names as a whole that are one sanctioned unit per another,
 * each as `category/unit`.
 */
function reachableUnits(): string[] {
  const sanctioned = new Set(SANCTIONED_UNITS);
  const paths = new Map<string, string>();
  let category = "";
  // root{ unitsShort{ category{ unit{
  for (const [, indent, name] of read(join(dataDir, "unit/root.txt")).matchAll(/^( +)([a-z0-9-]+)[:{]/gm)) {
    if (indent!.length === 8) category = name!;
    if (indent!.length !== 12) continue;
    const [, a, b] = name!.match(/^([a-z0-9-]+?)-per-([a-z0-9-]+)$/) ?? [];
    if (sanctioned.has(name!) || (sanctioned.has(a!) && sanctioned.has(b!))) paths.set(name!, `${category}/${name}`);
  }
  for (const unit of SANCTIONED_UNITS) if (!paths.has(unit)) die(`unit/root.txt has no ${unit}`);
  return [...paths.values()];
}

function resIndex(tree: Tree, locales: string[]): string {
  // LOCALE_DEPS.json starts with `//` comment lines.
  const deps = JSON.parse(read(join(dataDir, tree.dir, "LOCALE_DEPS.json")).replace(/^\s*\/\/.*$/gm, ""));
  const aliases = new Set(Object.keys(deps.aliases ?? {}));
  const listed = locales.filter(l => !NOT_INSTALLED.has(l));
  const table = (names: string[]) => names.map(l => `        ${l} {""}`).join("\n");
  return (
    "// Warning this file is automatically generated\n" +
    "res_index:table(nofallback) {\n" +
    (tree.dir === "locales" ? `    CLDRVersion { "${deps.cldrVersion}" }\n` : "") +
    `    InstalledLocales:table {\n${table(listed.filter(l => !aliases.has(l)))}\n    }\n` +
    `    AliasLocales:table {\n${table(listed.filter(l => aliases.has(l)))}\n    }\n` +
    "}"
  );
}

async function buildTree(tree: Tree, after: Promise<unknown>): Promise<void> {
  const src = join(dataDir, tree.dir);
  const standalone = tree.standalone ?? [];
  const locales = stems(tree.dir).filter(l => !standalone.includes(l));
  const built = tree.only ?? locales;
  for (const l of built) if (!locales.includes(l)) die(`${tree.dir}/${l}.txt does not exist`);

  const tmp = join(tmpDir, tree.dir);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "res_index.txt"), resIndex(tree, locales));

  const extra = tree.filter === undefined ? [] : filterDir(tree.dir, built, tree.filter());
  // unlinked: what builds a collator from rules. JavaScriptCore asks only whether there are any, and the fork's genrb
  // leaves a space of them.
  if (tree.dir === "coll") extra.push("--omitCollationRules");

  await after;
  const steps = [genrb(tmp, tree.out, [], ["res_index"]), ...standalone.map(s => genrb(src, tree.out, [], [s]))];
  if (tree.pool) {
    await genrb(src, tree.out, [...extra, "--writePoolBundle"], built);
    extra.push("--usePoolBundle", join(outDir, tree.out));
  }
  // Collation tailorings differ in cost by orders of magnitude, so those go one to a process.
  const groups = tree.dir === "coll" ? built.map(l => [l]) : chunks(built, limit);
  steps.push(...groups.map(group => genrb(src, tree.out, extra, group)));
  await Promise.all(steps);
}

/**
 * The rbnf bundles that ICU reaches by itself are the ones numberingSystems.txt
 * names: `desc{"<locale>/<ruleset group>/%<ruleset>"}`, or a bare `%ruleset` for root.
 */
function checkRbnf(): void {
  const kept = new Set(TREES.find(t => t.dir === "rbnf")!.only);
  const text = read(join(dataDir, "misc/numberingSystems.txt"));
  for (const [, locale] of text.matchAll(/desc\{"([A-Za-z_]+)\//g)) {
    if (!kept.has(locale!)) die(`numberingSystems.txt names rbnf/${locale}, which is not built`);
  }
}

/**
 * Which case the parts of "A per B" take is a rule of the language: `case{ per{ "<of A>", "<of B>" } }`, where
 * "compound" is the case of the whole, which is the nominative unless unitDisplayCase says otherwise.
 */
function checkUnitCases(): void {
  const text = read(join(dataDir, "misc/grammaticalFeatures.txt"));
  for (const [, cases] of text.matchAll(/\bcase\{\s*per\{([^}]*)\}/g)) {
    for (const [, unitCase] of cases!.matchAll(/"([a-z]+)"/g)) {
      if (unitCase !== "compound" && unitCase !== "nominative" && !UNIT_CASES.includes(unitCase!)) {
        die(`grammaticalFeatures.txt puts part of a "per" unit in the ${unitCase}, which is not built`);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Package
// ───────────────────────────────────────────────────────────────────────────

function listItems(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listItems(join(dir, entry.name), `${prefix}${entry.name}/`) : [prefix + entry.name],
  );
}

/**
 * DataHeader | u32 count | { u32 nameOffset, u32 dataOffset }[count] | names | items
 *
 * Offsets are from the count. Names are NUL-terminated "<pkg>/<item>" and sorted
 * as bytes, which is what the lookup's binary search compares. Items are
 * 16-aligned; ICU's packagers fill the gaps with 0xaa.
 */
function writePackage(): Buffer {
  const comment =
    " Copyright (C) 2016 and later: Unicode, Inc. and others. License & terms of use: http://www.unicode.org/copyright.html ";
  const info = 24;
  const headerSize = (info + comment.length + 1 + 15) & ~15;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(headerSize, 0);
  header.set([0xda, 0x27], 2);
  header.writeUInt16LE(20, 4); // UDataInfo.size
  header.set([0, 0, 2, 0], 8); // little-endian, ASCII, 2-byte UChar
  header.write("CmnD", 12, "latin1");
  header.set([1, 0, 0, 0], 16); // formatVersion
  header.set([3, 0, 0, 0], 20); // dataVersion
  header.write(comment, info, "latin1");

  const names = listItems(outDir)
    .filter(item => !NOT_PACKAGED.some(pattern => pattern.test(item)))
    .map(item => `${pkg}/${item}`)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "latin1"), Buffer.from(b, "latin1")));
  const toc = Buffer.alloc(4 + names.length * 8);
  toc.writeUInt32LE(names.length, 0);

  const pad = (length: number) => Buffer.alloc(-length & 15, 0xaa);
  const parts: Buffer[] = [];
  let offset = toc.length;
  const push = (part: Buffer) => (parts.push(part), (offset += part.length));

  names.forEach((name, i) => {
    toc.writeUInt32LE(offset, 4 + i * 8);
    push(Buffer.from(name + "\0", "latin1"));
  });
  push(pad(offset));
  names.forEach((name, i) => {
    toc.writeUInt32LE(offset, 8 + i * 8);
    push(readFileSync(join(args.work!, name)));
    push(pad(offset));
  });
  // uresdata.cpp looks for the ends of strings 8 bytes at a time.
  push(Buffer.alloc(16, 0xaa));
  return Buffer.concat([header, toc, ...parts]);
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

rmSync(args.work!, { recursive: true, force: true });
for (const tree of TREES) mkdirSync(join(outDir, tree.out), { recursive: true });
checkRbnf();
checkUnitCases();

for (const [to, from] of Object.entries(COPIED)) {
  inputs.add(join(dataDir, from));
  copyFileSync(join(dataDir, from), join(outDir, to));
}

inputs.add(join(dataDir, "mappings/convrtrs.txt"));
// The one file a bundle includes from outside the directories globbed here: coll/root.txt, for UCARules.
inputs.add(join(dataDir, "unidata/UCARules.txt"));
inputs.add(join(dataDir, ROOT_COLLATION));
copyFileSync(join(dataDir, ROOT_COLLATION), join(outDir, "coll/ucadata.icu"));
try {
  await run("gencnval", ["-s", dataDir, "-d", outDir, "mappings/convrtrs.txt"]);
} catch (error) {
  die((error as Error).message);
}

const dictionaries = stems("brkitr/dictionaries");
for (const d of dictionaries) if (!(d in DICTIONARIES)) die(`no gendict options for brkitr/dictionaries/${d}.txt`);

// brkitr's bundles name these as dependencies, and genrb -k requires that they exist.
const breakData = Promise.all([
  ...stems("brkitr/rules").map(rules =>
    run("genbrk", [
      "-d",
      outDir,
      "-i",
      outDir,
      "-c",
      "-r",
      join(dataDir, "brkitr/rules", rules + ".txt"),
      "-o",
      `brkitr/${rules}.brk`,
    ]),
  ),
  ...dictionaries.map(d =>
    run("gendict", [
      "-i",
      outDir,
      "-c",
      ...DICTIONARIES[d]!,
      join(dataDir, "brkitr/dictionaries", d + ".txt"),
      join(outDir, "brkitr", d + ".dict"),
    ]),
  ),
]);

try {
  await Promise.all([
    breakData,
    ...stems("misc")
      .filter(bundle => !MISC_LEFT_OUT.has(bundle))
      .map(bundle =>
        genrb(
          join(dataDir, "misc"),
          "",
          [...(bundle in MISC_FILTERS ? filterDir("misc", [bundle], MISC_FILTERS[bundle]!) : []), "-q"],
          [bundle],
        ),
      ),
    ...TREES.map(tree => buildTree(tree, tree.dir === "brkitr" ? breakData : Promise.resolve())),
  ]);
} catch (error) {
  die((error as Error).message);
}

for (const d of args.uncompacted ? [] : dictionaries) {
  if (!DICTIONARIES[d]!.includes("--uchars")) continue;
  const file = join(outDir, "brkitr", d + ".dict");
  writeFileSync(file, succinctDictionary(readFileSync(file)));
}

for (const tree of TREES) {
  if (!tree.pool || args.uncompacted) continue;
  const dir = join(outDir, tree.out);
  const bundles = new Map<string, Buffer>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".res") || file === "pool.res") continue;
    const bytes = readFileSync(join(dir, file));
    if (!canCompact(bytes)) continue;
    bundles.set(file.slice(0, -".res".length), bytes);
    rmSync(join(dir, file));
  }
  writeFileSync(join(dir, "pool.res"), compactTree(readFileSync(join(dir, "pool.res")), bundles));
}

// An output that would be the same is left alone, for builds that go by timestamps.
const packaged = writePackage();
const unchanged = existsSync(args.out!) && readFileSync(args.out!).equals(packaged);
if (!unchanged) writeFileSync(args.out!, packaged);

// Spaces cannot occur in these names; backslashes are Windows path separators, which ninja accepts as /.
const escape = (path: string) => path.replaceAll("\\", "/").replaceAll(" ", "\\ ");
if (args.depfile) writeFileSync(args.depfile, `${escape(args.out!)}: ${[...inputs].map(escape).join(" ")}\n`);
console.log(`${basename(args.out!)}: ${packaged.length} bytes${unchanged ? " (unchanged)" : ""}`);
