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
 *             that other consumers (ICU4J, CLDR's own tools) read. checkUnnamed() looks the keys up in the sources.
 *   unlinked  Nothing in Bun calls the only functions that ask for it. Most of those the linker dropped;
 *             some are there because others in their file are, or ask for it only for an argument nobody passes.
 *   refused   ECMA-402 rejects, before ICU sees it, every input that would select it.
 *
 * ../oracle compares what every one of those APIs returns, for every locale, between two builds.
 *
 * What is here was written for one release of ICU. With another, a key may have another name, or there may be a file
 * that nothing here has heard of. So a rule that finds nothing to apply to (checkRules()) and an input that is neither
 * built nor known to be left out (checkInputs()) are errors: nothing is left out, or kept, by accident.
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

/** Packaged without parts that the tools need, or that are in a file that is copied. */
const PACKAGED_WITHOUT: Record<string, (item: Buffer) => Buffer> = {
  // unlinked: CollationRootElements, by which CollationBuilder, and so genrb, finds weights for what rules put between
  // two characters. collationdatareader.h: indexes[12] is where it starts, and what is after it starts at the next.
  "coll/ucadata.icu": item => withoutSections(item, [12], 19),
  // unlinked: u_stringHasBinaryProperty(). emojiprops.h: indexes[4] to [9] are where the tries of the sequences that are
  // emoji start.
  "uemoji.icu": item => withoutSections(item, [4, 5, 6, 7, 8, 9], 13),
};

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
  /** Bundles in `dir` that are not locales, and are not built. */
  leftOut?: string[];
  /**
   * genrb `--filterDir` rules for a bundle: `-/path` leaves a resource out, `+/path` puts one back, `*` stands for any
   * one key, and a later rule wins.
   */
  filter?: (bundle: string) => string[];
  /** What genrb reads instead of a bundle's source: its rules reach into tables, and not into arrays. */
  edit?: (bundle: string, text: string) => string;
  /** The only bundles built. res_index still lists every locale in `dir`. */
  only?: string[];
  /**
   * Has no res_index. unlinked: that is for listing a tree's locales (ures_openAvailableLocales) and for what a keyword
   * is worth in one (ures_getFunctionalEquivalent), which is asked of the trees that have one.
   */
  unlisted?: boolean;
}

const leaveOut = (...paths: string[]) => paths.map(path => `-/${path}`);

/** The last parts of the paths that are left out for being unnamed. */
const unnamedKeys = new Set<string>();
const unnamed = (...paths: string[]) => {
  for (const path of paths) unnamedKeys.add(path.slice(path.lastIndexOf("/") + 1));
  return leaveOut(...paths);
};

/** genrb's list of the items a bundle names, for icupkg to check a package by. unnamed, and not in the sources: genrb adds it. */
const DEPENDENCIES = "%%DEPENDENCY";

const TREES: Tree[] = [
  {
    dir: "locales",
    out: "",
    pool: true,
    edit: withoutGluePatterns,
    filter: bundle => [
      ...unnamed("characterLabel", "personNames", "measurementSystemNames", "NumberElements/minimalPairs"),
      ...unnamed("calendar/*/DateTimeSkeletons", "calendar/*/DateTimePatterns%relative", "fields/*/relativePeriod"),
      ...["currencyFormat", "accountingFormat"].flatMap(format =>
        unnamed(
          `NumberElements/*/patterns/${format}%alphaNextToNumber`,
          `NumberElements/*/patterns/${format}%noCurrency`,
        ),
      ),
      ...unnamed("NumberElements/*/patternsShort/currencyFormat%alphaNextToNumber"),
      // DateFormatSymbols, which enumerates the table, skips them by their suffix.
      ...["wide", "abbreviated", "narrow"].flatMap(width => unnamed(`calendar/*/eras/${width}%variant`)),
      // unlinked: ulocdata_*, AlphabeticIndex.
      ...leaveOut("ExemplarCharacters", "AuxExemplarCharacters", "ExemplarCharactersIndex"),
      ...leaveOut("ExemplarCharactersNumbers", "ExemplarCharactersPunctuation", "delimiters", "Ellipsis"),
      // refused: "last Sunday", "in 2 Mondays". Intl.RelativeTimeFormat's units are second to year.
      // And the fields that Intl.DisplayNames has no code for.
      ...[...WEEKDAYS, "dayOfYear", "weekdayOfMonth", "weekOfMonth"].flatMap(field =>
        leaveOut(`fields/${field}`, `fields/${field}-short`, `fields/${field}-narrow`),
      ),
      ...unnamed("MoreInformation", "nestedBracketReplacements", "contextTransforms/typographicNames"),
      ...unnamed("NumberElements/*/rationalFormats", "NumberElements/*/patterns/currencyPatternAppendISO"),
      ...unnamed("NumberElements/*/miscPatterns/atLeast", "NumberElements/*/miscPatterns/atMost"),
      ...unnamed("calendar/*/NoonMarker", "calendar/*/NoonMarkerNarrow"),
      // unlinked: UCONFIG_NO_PARSING. But for the root's: by that, static_unicode_sets.cpp knows white space and signs,
      // which formatToParts() tells from what they are next to.
      ...(bundle === "root" ? [] : leaveOut("parse")),
      // unlinked: ures_getVersion.
      ...leaveOut("Version"),
      // refused: numbering systems by what they are for. JavaScriptCore takes the names of those that have digits.
      ...leaveOut("NumberElements/native", "NumberElements/traditional", "NumberElements/finance"),
      // DateFormatSymbols, which enumerates the table, skips the first three, and nothing asks it for the other two
      // (unlinked: getZodiacNames). What is left is the names of the years.
      ...["days", "months", "solarTerms", "zodiacs", "dayParts"].flatMap(set =>
        leaveOut(`calendar/*/cyclicNameSets/${set}`),
      ),
      // refused: there is no option for a quarter or a week. `yyyy` is a year of four digits.
      ...skeletons(/[QqwW]|^yyyy$/).map(path => `-/${path}`),
      // unlinked: getQuarters. Without any, DateFormatSymbols gives up on the locale's other names too, so the root's stay.
      ...(bundle === "root" ? [] : leaveOut("calendar/*/quarters")),
      // refused: not a calendar of Intl.supportedValuesOf().
      ...leaveOut("calendar/islamic-rgsa"),
      // refused: nobody can ask for the generic calendar. Others have aliases to some of what it has, and none to these.
      ...leaveOut("calendar/generic/eras", "calendar/generic/monthNames", "calendar/generic/DateTimePatterns%atTime"),
    ],
  },
  {
    dir: "curr",
    out: "curr",
    pool: true,
    standalone: ["supplementalData"],
    unlisted: true,
    edit: (bundle, text) => (bundle === "supplementalData" ? withoutCurrencyHistory(text) : text),
    filter: () => leaveOut("Version"),
  },
  {
    dir: "lang",
    out: "lang",
    pool: true,
    unlisted: true,
    filter: () => [
      ...leaveOut("Version"),
      // refused: names of Unicode extension keys and their values. Intl.DisplayNames takes a language identifier
      // without extensions, and of the keys' values only calendars.
      ...leaveOut("Keys", "Types"),
      "+/Types/calendar",
      ...unnamed("characterLabelPattern", "codePatterns"),
      ...["long", "menu", "variant", "extension", "core", "secondary", "official"].flatMap(alt =>
        unnamed(`Languages%${alt}`),
      ),
      ...unnamed("Scripts%variant", "Scripts%secondary", "Variants%secondary", "Types%variant"),
      // unlinked: uloc_getDisplayScript.
      ...leaveOut("Scripts%stand-alone"),
    ],
  },
  {
    dir: "region",
    out: "region",
    pool: true,
    unlisted: true,
    filter: () => [...leaveOut("Version"), ...unnamed("Countries%variant", "Countries%chagos", "Countries%biot")],
  },
  {
    dir: "zone",
    out: "zone",
    pool: true,
    unlisted: true,
    // unlinked: TZDBTimeZoneNames, which is for parsing.
    leftOut: ["tzdbNames"],
    filter: () => [
      ...leaveOut("Version"),
      ...unnamed(
        "zoneStrings/regionFormatStandard",
        "zoneStrings/regionFormatDaylight",
        "zoneStrings/gmtUnknownFormat",
      ),
      // refused: JavaScriptCore does not take it for a time zone.
      ...leaveOut("zoneStrings/Etc:Unknown"),
      ...unshownZoneNames.map(path => `-/${path}`),
    ],
  },
  {
    dir: "unit",
    out: "unit",
    pool: true,
    unlisted: true,
    // refused: every other unit.
    filter: bundle => [
      ...leaveOut("Version"),
      ...["units", "unitsShort", "unitsNarrow"].flatMap(width => [
        `-/${width}`,
        `+/${width}/compound/per`,
        // No wildcards: where a rule could put something back, genrb keeps every table on the way, empty.
        ...reachableUnits().flatMap(unit => [
          `+/${width}/${unit}`,
          // unlinked: the rest are selected by unitDisplayCase, which no caller sets.
          `-/${width}/${unit}/case`,
          ...unitCases(bundle).map(unitCase => `+/${width}/${unit}/case/${unitCase}`),
          // unlinked: getUnitDisplayName.
          `-/${width}/${unit}/dnam`,
        ]),
      ]),
    ],
  },
  {
    dir: "coll",
    out: "coll",
    pool: false,
    filter: () => [
      // unlinked: ucol_getRulesEx(UCOL_FULL_RULES).
      ...leaveOut("UCARules"),
      // Rules for other tailorings to import, which genrb does from the text. Enumerating the types skips them.
      ...leaveOut("collations/private-kana", "collations/private-pinyin", "collations/private-unihan"),
      ...leaveOut(DEPENDENCIES),
      // A collator's version is in its binary data.
      ...leaveOut("Version", "collations/*/Version"),
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
      // unlinked: UCONFIG_NO_FILTERED_BREAK_ITERATION.
      ...leaveOut("exceptions"),
      ...leaveOut("Version"),
    ],
  },
  // Nothing in Bun calls RuleBasedNumberFormat, but ICU does: numberingSystems.res declares algorithmic numbering
  // systems whose rules are here, and SimpleDateFormat applies them for the number overrides CLDR attaches to
  // calendar patterns (zh + chinese carries "d=hanidays") or that it attaches itself (FORCED_OVERRIDES).
  // refused: the rest. JavaScriptCore takes the names of the numbering systems that have digits.
  // checkRbnf() checks this list against the data.
  {
    dir: "rbnf",
    out: "rbnf",
    pool: false,
    only: ["root", "ja", "zh"],
    unlisted: true,
    // A numbering system's rules are NumberingSystemRules, or what its description says, which is SpelloutRules.
    filter: () => leaveOut("RBNFRules/OrdinalRules", "RBNFRules/DurationRules", "Version"),
  },
];

/** data/misc: bundles that are left out, and rules for the ones that are not. */
const MISC_LEFT_OUT = new Set([
  // unlinked: ucurr_getNumericCode, GenderInfo.
  "currencyNumericCodes",
  "genderList",
  // unlinked: u_getDataVersion. And a bundle that says that this is ICU's data, which nothing asks.
  "icuver",
  "icustd",
]);
const MISC_FILTERS: Record<string, string[]> = {
  supplementalData: [
    ...unnamed(
      "subdivisionContainment",
      "territoryInfo",
      "languageData",
      "languageMatchingNew",
      "languageMatchingInfo",
    ),
    ...unnamed("codeMappingsCurrency", "parentLocales", "weekOfPreference", "personNamesDefaults", "weekData%variant"),
    // unlinked: ulocdata_*.
    ...leaveOut("measurementData"),
    // Only ever read under "region".
    ...leaveOut("idValidity"),
    "+/idValidity/region",
    ...unnamed("calendarData/*/inheritEras"),
    ...leaveOut("calendarData/islamic-rgsa"),
    // unlinked: ulocdata_getCLDRVersion.
    ...leaveOut("cldrVersion"),
  ],
  // Of an alias, only what it stands for is asked for.
  metadata: [...unnamed("defaultContent"), ...leaveOut("alias/*/*/reason")],
  metaZones: unnamed("metazoneIds"),
  units: [
    ...unnamed("unitPrefixes", "unitIdComponents", "unitConstants"),
    // unlinked: UCONFIG_NO_UNIT_CONVERSION. What a unit is converted to says what kind of unit it is, and stays.
    ...leaveOut("unitPreferenceData"),
    ...["factor", "offset", "special", "systems"].flatMap(key => leaveOut(`convertUnits/*/${key}`)),
  ],
  // unlinked: LocaleDistance, which is LocaleMatcher's.
  langInfo: leaveOut("match"),
  // Of a language's grammar, only which forms the parts of a compound unit take is asked for.
  grammaticalFeatures: leaveOut("grammaticalData/features"),
  dayPeriods: unnamed("locales_selection"),
  // unlinked: ucal_getTZDataVersion.
  zoneinfo64: leaveOut("TZVersion"),
};

/**
 * refused: a tag with the variant POSIX is made one with -u-va-posix, and what looks for a locale's data leaves
 * extensions out. Nor is it the locale of a process whose LC_ALL says so: JavaScriptCore's default is en-US.
 */
const LOCALES_LEFT_OUT = new Set(["en_US_POSIX"]);
/** Break rules that only such a locale's bundle names. */
const BREAK_RULES_LEFT_OUT = new Set(["word_POSIX"]);

const MISC_EDITS: Record<string, (text: string) => string> = { zoneinfo64: withoutUnusedZones };

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
const inputs = new Set<string>(
  ["./icu-dict.ts", "./icu-res.ts"].map(file => fileURLToPath(new URL(file, import.meta.url))),
);

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
function filterDir(name: string, bundles: string[], rules: (bundle: string) => string[]): string[] {
  const dir = join(tmpDir, "filters", name);
  mkdirSync(dir, { recursive: true });
  for (const bundle of bundles) writeFileSync(join(dir, bundle + ".txt"), ["+/", ...rules(bundle)].join("\n") + "\n");
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

/** LOCALE_DEPS.json, which starts with `//` comment lines. */
function localeDeps(dir: string): {
  cldrVersion: string;
  aliases?: Record<string, string>;
  parents?: Record<string, string>;
} {
  return JSON.parse(read(join(dataDir, dir, "LOCALE_DEPS.json")).replace(/^\s*\/\/.*$/gm, ""));
}

function resIndex(tree: Tree, locales: string[]): string {
  const deps = localeDeps(tree.dir);
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

/** The locales of a tree, and its bundles that are built. */
function bundlesOf(tree: Tree): { locales: string[]; built: string[] } {
  const all = stems(tree.dir);
  for (const l of [...(tree.standalone ?? []), ...(tree.leftOut ?? [])]) {
    if (!all.includes(l)) die(`${tree.dir}/${l}.txt does not exist`);
  }
  const locales = all.filter(
    l => !tree.standalone?.includes(l) && !tree.leftOut?.includes(l) && !LOCALES_LEFT_OUT.has(l),
  );
  const built = tree.only ?? locales;
  for (const l of built) if (!locales.includes(l)) die(`${tree.dir}/${l}.txt does not exist`);
  return { locales, built };
}

/** A directory with what genrb is to read for these bundles. */
function edited(dir: string, bundles: string[], edit: (bundle: string, text: string) => string): string {
  const to = join(tmpDir, "edited", dir);
  mkdirSync(to, { recursive: true });
  for (const bundle of bundles)
    writeFileSync(join(to, bundle + ".txt"), edit(bundle, read(join(dataDir, dir, bundle + ".txt"))));
  return to;
}

async function buildTree(tree: Tree, after: Promise<unknown>): Promise<void> {
  const standalone = tree.standalone ?? [];
  const { locales, built } = bundlesOf(tree);
  const src = tree.edit ? edited(tree.dir, [...built, ...standalone], tree.edit) : join(dataDir, tree.dir);

  const tmp = join(tmpDir, tree.dir);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "res_index.txt"), resIndex(tree, locales));

  const extra = tree.filter === undefined ? [] : filterDir(tree.dir, built, tree.filter);
  // unlinked: what builds a collator from rules. JavaScriptCore asks only whether there are any, and this genrb
  // leaves a space of them.
  if (tree.dir === "coll") extra.push("--omitCollationRules");

  await after;
  const steps = standalone.map(s => genrb(src, tree.out, [], [s]));
  if (!tree.unlisted) steps.push(genrb(tmp, tree.out, [], ["res_index"]));
  if (tree.pool) {
    await genrb(src, tree.out, [...extra, "--writePoolBundle"], built);
    extra.push("--usePoolBundle", join(outDir, tree.out));
  }
  // Collation tailorings differ in cost by orders of magnitude, so those go one to a process.
  const groups = tree.dir === "coll" ? built.map(l => [l]) : chunks(built, limit);
  steps.push(...groups.map(group => genrb(src, tree.out, extra, group)));
  await Promise.all(steps);
}

/** smpdtfmt.cpp: in Japanese, the first year of an era of the Japanese calendar is not "1". */
const FORCED_OVERRIDES = ["jpanyear"];

/**
 * The rbnf bundles that ICU reaches by itself are those of the algorithmic numbering systems that a pattern is to be
 * formatted with: `DateTimePatterns{ …, { "<pattern>", "<system>" or "<field>=<system>;…" }, … }`.
 * numberingSystems.txt says where a system's rules are: `desc{"<locale>/<ruleset group>/%<ruleset>"}`, or a bare
 * `%ruleset` for root.
 */
function checkRbnf(): void {
  const systems = new Map(
    find(parseSource(read(join(dataDir, "misc/numberingSystems.txt"))), "numberingSystems/numberingSystems/*").map(
      system => [
        system.name,
        { algorithmic: values(find(system, "algorithmic")[0]!)[0] === "1", desc: values(find(system, "desc")[0]!)[0]! },
      ],
    ),
  );
  const used = new Set(FORCED_OVERRIDES);
  for (const bundle of bundlesOf(TREES.find(t => t.dir === "locales")!).built) {
    const source = parseSource(read(join(dataDir, "locales", bundle + ".txt")));
    for (const pattern of find(source, "*/calendar/*/DateTimePatterns/")) {
      for (const override of values(pattern)[1]!.split(";")) used.add(override.replace(/^.=/, ""));
    }
    for (const system of find(source, "*/NumberElements/default").flatMap(values)) {
      if (systems.get(system)?.algorithmic !== false)
        die(`the numbers of ${bundle} are ${system}, which has no digits`);
    }
  }
  const needed = new Set<string>();
  for (const name of used) {
    const system =
      systems.get(name) ?? die(`a pattern is to be formatted with ${name}, which numberingSystems.txt does not have`);
    if (!system.algorithmic) continue;
    const [, locale, group] = /^(?:([A-Za-z_]+)\/([A-Za-z]+)\/)?%/.exec(system.desc) ?? die(`${name}: ${system.desc}`);
    if (group !== undefined && group !== "SpelloutRules") die(`${name} has its rules in ${group}, which is not built`);
    needed.add(locale ?? "root");
  }
  const kept = TREES.find(t => t.dir === "rbnf")!.only!;
  if (kept.toSorted().join() !== [...needed].sort().join())
    die(`rbnf: ${[...needed].sort()} are needed, ${kept} are built`);
  // A bare ruleset is looked for in the bundle of the formatter's locale, and found in root's by fallback.
  for (const locale of stems("rbnf")) {
    if (locale !== "root" && read(join(dataDir, "rbnf", locale + ".txt")).includes("NumberingSystemRules")) {
      die(`rbnf/${locale}.txt has NumberingSystemRules of its own`);
    }
  }
}

const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|[{},]|[^\s{},"]+/g;

/** A `name:type{ … }` in the source of a bundle, or a string or a number in one. */
interface Part {
  /** Where it is in the text. */
  start: number;
  end: number;
  /** A resource's key, "" if it has none. */
  name: string;
  /** A string's or a number's text. */
  text?: string;
  /** What a resource has: each is one resource, or the pieces of one string, which a comma ends. */
  elements: Part[][];
}

function parseSource(text: string): Part {
  const top: Part = { start: 0, end: text.length, name: "", elements: [[]] };
  const stack = [top];
  for (const { 0: token, index: at } of text.matchAll(TOKEN)) {
    const parent = stack.at(-1)!;
    const element = parent.elements.at(-1)!;
    if (token.startsWith("//") || token.startsWith("/*")) continue;
    if (token === "{") {
      // What was before it was its name.
      const name = element.at(-1)?.text === undefined ? undefined : element.pop()!;
      const part: Part = { start: name?.start ?? at, end: -1, name: name?.name ?? "", elements: [[]] };
      element.push(part);
      stack.push(part);
    } else if (token === "}") {
      parent.end = at + 1;
      parent.elements = parent.elements.filter(e => e.length);
      stack.pop();
      stack.at(-1)!.elements.push([]);
    } else if (token === ",") {
      parent.elements.push([]);
    } else {
      const quoted = token.startsWith('"');
      element.push({
        start: at,
        end: at + token.length,
        name: quoted ? token.slice(1, -1) : token.replace(/:.*/, ""),
        text: quoted ? token.slice(1, -1) : token,
        elements: [],
      });
    }
  }
  if (stack.length !== 1) die("a source has a { that is not closed");
  top.elements = top.elements.filter(e => e.length);
  return top;
}

/** The resource at a path of keys below a resource, in which * is any key: all that there are. */
function find(part: Part, path: string): Part[] {
  let found = [part];
  for (const key of path.split("/")) {
    found = found.flatMap(p =>
      p.elements.flat().filter(child => child.text === undefined && (key === "*" || child.name === key)),
    );
  }
  return found;
}

/** The strings or numbers of a resource that has nothing else. */
const values = (part: Part) => part.elements.map(element => element.map(piece => piece.text!).join(""));

/** The text with some parts of it replaced. */
function replace(text: string, edits: [part: { start: number; end: number }, by: string][]): string {
  let result = "";
  let from = 0;
  for (const [{ start, end }, by] of edits.toSorted((a, b) => a[0].start - b[0].start)) {
    if (start < from) die("two edits of a source overlap");
    result += text.slice(from, start) + by;
    from = end;
  }
  return result + text.slice(from);
}

/**
 * DateTimePatterns is four patterns for a time, four for a date, one for how to put the two together, and four more
 * for that, by the style of the date. Those four are asked for only where there is no DateTimePatterns%atTime, of the
 * calendar or else of the Gregorian one. A locale that gets as far as this bundle looks for that here and in its
 * parents too.
 */
function withoutGluePatterns(bundle: string, text: string): string {
  if (!hasAtTime(bundle)) return text;
  const edits: Parameters<typeof replace>[1] = [];
  for (const patterns of find(parseSource(text), "*/calendar/*/DateTimePatterns")) {
    // An alias.
    if (patterns.elements.length === 1) continue;
    if (patterns.elements.length !== 13) die(`${bundle}: DateTimePatterns has ${patterns.elements.length} patterns`);
    edits.push([{ start: patterns.elements[8]!.at(-1)!.end, end: patterns.elements[12]!.at(-1)!.end }, ""]);
  }
  return replace(text, edits);
}

/**
 * CurrencyMap has, for a region, the currencies it has had, the latest first, each with when it was one.
 * unlinked: all that asks but ucurr_forLocale(), which takes the first that is legal tender, or else the first.
 */
function withoutCurrencyHistory(text: string): string {
  const edits: Parameters<typeof replace>[1] = [];
  const regions = find(parseSource(text), "supplementalData/CurrencyMap/*");
  if (!regions.length) die("curr/supplementalData.txt has no CurrencyMap");
  for (const region of regions) {
    const currencies = find(region, "");
    const isTender = (currency: Part) => find(currency, "tender").flatMap(values)[0] !== "false";
    const taken = currencies.find(isTender) ?? currencies[0]!;
    for (const currency of currencies) {
      if (currency !== taken) edits.push([currency, ""]);
      else for (const when of [...find(currency, "from"), ...find(currency, "to")]) edits.push([when, ""]);
    }
  }
  return replace(text, edits);
}

interface Zone {
  region: string;
  /** Whether the clocks were ahead at any time from one instant to another, in seconds since 1970. */
  hadDaylightTime(from: number, to: number): boolean;
}

/** zoneinfo64's zones by name. See olsontz.h. */
function readZones(): Map<string, Zone> {
  const [source] = find(parseSource(read(join(dataDir, "misc/zoneinfo64.txt"))), "zoneinfo64");
  const names = values(find(source!, "Names")[0]!);
  const regions = values(find(source!, "Regions")[0]!);
  const zones = find(source!, "Zones")[0]!.elements.flat();
  const numbers = (zone: Part, key: string) => find(zone, key).flatMap(values).map(Number);
  const pairs = (list: number[]) => list.flatMap((high, i) => (i % 2 ? [] : [high * 2 ** 32 + (list[i + 1]! >>> 0)]));
  return new Map(
    names.map((name, i) => {
      // A zone that is another by a different name is that one's number.
      const [first] = zones[i]!.elements.flat();
      const zone = first!.text === undefined ? zones[i]! : zones[Number(first!.text)]!;
      const changes = [
        ...pairs(numbers(zone, "transPre32")),
        ...numbers(zone, "trans"),
        ...pairs(numbers(zone, "transPost32")),
      ];
      const types = Buffer.from(find(zone, "typeMap").flatMap(values)[0] ?? "", "hex");
      const ahead = numbers(zone, "typeOffsets").filter((_, j) => j % 2);
      const [finalYear] = numbers(zone, "finalYear");
      if (types.length !== changes.length)
        die(`zoneinfo64.txt: ${name} has ${changes.length} changes and ${types.length} types`);
      const hadDaylightTime = (from: number, to: number) =>
        // A rule that goes on for ever is one for daylight time.
        (finalYear !== undefined && to > Date.UTC(finalYear, 0) / 1000) ||
        changes.some((at, j) => ahead[types[j]!] !== 0 && at < to && (changes[j + 1] ?? Infinity) > from);
      return [name, { region: regions[i]!, hadDaylightTime }];
    }),
  );
}

/**
 * Names that no pattern JavaScriptCore makes can show, as paths in the zone tree.
 *
 * A zone's city (tzgnames.cpp). "Berlin Time" is said only of a zone that is not the only one of its country, or the one
 * that stands for it: of those it is "Germany Time". And "Central European Time (Berlin)" is said only of a zone that is
 * not the one that its metazone has for its country. What is left is the pattern VVV, which is the city.
 *
 * A metazone's names for daylight time, if no zone has had any while it was in it. Before 1970 no zone is in any.
 */
function findUnshownZoneNames(): string[] {
  const zones = readZones();
  const [metaZones] = find(parseSource(read(join(dataDir, "misc/metaZones.txt"))), "metaZones");
  const table = (part: Part) => new Map(find(part, "*").map(entry => [entry.name, values(entry)[0]!]));
  const primaryZones = table(find(metaZones!, "primaryZones")[0]!);
  const references = new Map(find(metaZones!, "mapTimezones/*").map(metazone => [metazone.name, table(metazone)]));
  const seconds = (time: string | undefined, otherwise: number) =>
    time === undefined ? otherwise : Date.parse(time.replace(" ", "T") + "Z") / 1000;
  /** By zone, the metazones it has been in, and from when to when. */
  const history = new Map(
    find(metaZones!, "metazoneInfo/*").map(zone => [
      zone.name.replaceAll(":", "/"),
      find(zone, "")
        .map(values)
        .map(([metazone, from, to]) => ({
          metazone: metazone!,
          from: Math.max(0, seconds(from, 0)),
          to: seconds(to, Infinity),
        })),
    ]),
  );
  // What CLDR calls a zone, of the names it has had, is what has a short name for -u-tz-. Names are by that.
  const canonical = find(parseSource(read(join(dataDir, "misc/timezoneTypes.txt"))), "timezoneTypes/typeMap/timezone/*")
    .map(zone => zone.name.replaceAll(":", "/"))
    .filter(zone => zones.has(zone));
  const inRegion = Map.groupBy(canonical, zone => zones.get(zone)!.region);

  const paths = new Set<string>();
  for (const bundle of bundlesOf(TREES.find(t => t.dir === "zone")!).built)
    resourcePaths(read(join(dataDir, "zone", bundle + ".txt")), paths);
  const has = (path: string) => paths.has(path);
  const others = (path: string, key: string) =>
    [...paths].some(p => p.startsWith(path + "/") && p !== `${path}/${key}`);

  const unshown: string[] = [];
  for (const zone of canonical) {
    const { region } = zones.get(zone)!;
    if (region === "001" || (inRegion.get(region)!.length > 1 && primaryZones.get(region) !== zone)) continue;
    const reference = (metazone: string) =>
      references.get(metazone)?.get(region) ?? references.get(metazone)?.get("001");
    if (!(history.get(zone) ?? []).every(({ metazone }) => reference(metazone) === zone)) continue;
    const path = `zoneStrings/${zone.replaceAll("/", ":")}`;
    // A table that would be left empty goes too.
    if (has(`${path}/ec`)) unshown.push(others(path, "ec") ? `${path}/ec` : path);
  }
  const withDaylightTime = new Set(
    [...history].flatMap(([zone, periods]) =>
      periods
        .filter(({ from, to }) => zones.get(zone)?.hadDaylightTime(from, to) ?? die(`metaZones.txt: no zone ${zone}`))
        .map(p => p.metazone),
    ),
  );
  for (const metazone of new Set([...history.values()].flat().map(p => p.metazone))) {
    if (withDaylightTime.has(metazone)) continue;
    unshown.push(...["ld", "sd"].map(key => `zoneStrings/meta:${metazone}/${key}`).filter(has));
  }
  if (!unshown.length) die("every name of a zone can be shown");
  return unshown;
}

/**
 * zoneinfo64 has an array of names, and an array of the zones in the same order.
 *
 * refused: SystemV/*, which JavaScriptCore does not take for time zones. But it tells a name that ICU knows from one that
 * it does not, so the zones stay, without when their clocks changed.
 * unlinked: a zone's list of those that are the same, which is for TimeZone::getEquivalentID().
 */
function withoutUnusedZones(text: string): string {
  const [source] = find(parseSource(text), "zoneinfo64");
  const names = values(find(source!, "Names")[0]!);
  const zones = find(source!, "Zones")[0]!.elements.flat();
  if (zones.length !== names.length) die("zoneinfo64.txt has not as many zones as names");
  if (!names.some(name => name.startsWith("SystemV/"))) die("zoneinfo64.txt has no SystemV zones");
  return replace(text, [
    ...zones.flatMap((zone, i) =>
      find(zone, "*")
        .filter(part => part.name === "links" || (names[i]!.startsWith("SystemV/") && part.name !== "typeOffsets"))
        .map(part => [part, ""] as [Part, string]),
    ),
    // The rule that only those zones went by.
    [find(source!, "Rules/SystemV")[0] ?? die("zoneinfo64.txt has no rule SystemV"), ""],
  ]);
}

/** The paths of the resources that have keys in the source of a bundle, from below its root. */
function resourcePaths(text: string, paths: Set<string>): void {
  const stack: string[] = [];
  let name = "";
  for (const [token] of text.matchAll(TOKEN)) {
    if (token === "{") {
      stack.push(name);
      if (stack.length > 1 && !stack.includes("", 1)) paths.add(stack.slice(1).join("/"));
      name = "";
    } else if (token === "}") {
      stack.pop();
      name = "";
    } else if (token === ",") {
      name = "";
    } else if (!token.startsWith("//") && !token.startsWith("/*")) {
      // "name"{ or name:type{
      name = token.startsWith('"') ? token.slice(1, -1) : token.replace(/:.*/, "");
    }
  }
}

/**
 * Each rule has to apply to something in some bundle it is for.
 * @param together rules that are made for each of many resources, of which only some have what the rule is about:
 *                 those with the same result here have to apply to something between them
 */
function checkRules(
  dir: string,
  bundles: string[],
  rules: (bundle: string) => string[],
  together = (rule: string) => rule,
): void {
  // Most bundles of a tree have the same rules.
  const groups = new Map<string, { rules: string[]; paths: Set<string> }>();
  for (const bundle of bundles) {
    const its = rules(bundle);
    const id = its.join("\n");
    if (!groups.has(id)) groups.set(id, { rules: its, paths: new Set() });
    resourcePaths(read(join(dataDir, dir, bundle + ".txt")), groups.get(id)!.paths);
  }
  const idle = new Set([...groups.values()].flatMap(group => group.rules.map(together)));
  for (const { rules, paths } of groups.values()) {
    for (const rule of rules) {
      if (!idle.has(together(rule))) continue;
      const path = rule.slice(2);
      const pattern = new RegExp("^" + path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$");
      if (path === DEPENDENCIES || (path.includes("*") ? [...paths].some(p => pattern.test(p)) : paths.has(path))) {
        idle.delete(together(rule));
      }
    }
  }
  if (idle.size) die(`${dir}: nothing there for the rules\n  ${[...idle].join("\n  ")}`);
}

function checkAllRules(): void {
  for (const tree of TREES) {
    if (tree.filter === undefined) continue;
    // Few units have forms for a case, and in few languages.
    checkRules(tree.dir, bundlesOf(tree).built, tree.filter, rule =>
      rule.replace(/^(.\/)[^/]+\/[^/]+\/[^/]+(\/case\b.*)$/, "$1*/*/*$2"),
    );
  }
  for (const [bundle, rules] of Object.entries(MISC_FILTERS)) checkRules("misc", [bundle], () => rules);
}

/**
 * No string in ICU4C's sources may have a key in it that is left out for being unnamed, or be the part of one after
 * a %, which is what code that asks for an alternative appends. (This does not see a string that is spelled as numbers.)
 */
function checkUnnamed(): void {
  const literals = new Set<string>();
  for (const dir of ["common", "i18n"]) {
    for (const file of readdirSync(join(sourceDir, dir))) {
      if (!/\.(cpp|h)$/.test(file)) continue;
      const tokens = read(join(sourceDir, dir, file)).matchAll(
        /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
      );
      for (const [token] of tokens) if (token.startsWith('"')) literals.add(token.slice(1, -1));
    }
  }
  for (const key of unnamedKeys) {
    const alternative = key.includes("%") ? key.slice(key.indexOf("%")) : undefined;
    for (const literal of literals) {
      if (literal.includes(key) || literal === alternative)
        die(`"${literal}" in ICU4C's sources names ${key}, which is left out`);
    }
  }
}

/** What is under data/ and is not built, so that what is new there is noticed. */
const NOT_BUILT: Record<string, string[]> = {
  // See "Whole BUILDRULES.py categories" above. dtd and xml are not data. mappings has cnvalias's source, unidata UCARules.txt.
  "": ["dtd", "mappings", "sprep", "translit", "unidata", "xml"],
  // Compiled into the library as C arrays: nfc, pnames, ubidi, ucase, uprops. See COPIED for nfkc_*, above for unames.
  in: ["nfc.nrm", "nfkc_cf.nrm", "nfkc_scf.nrm", "pnames.icu", "ubidi.icu", "ucase.icu", "unames.icu", "uprops.icu"],
  "in/coll": ["ucadata-implicithan.icu", "ucadata-implicithan-icu4x.icu", "ucadata-unihan-icu4x.icu"],
  brkitr: ["adaboost", "lstm"],
};

function checkInputs(): void {
  const known: Record<string, string[]> = {
    "": [...TREES.map(tree => tree.dir), "in", "misc"],
    in: [...Object.values(COPIED).map(from => from.slice("in/".length)), "coll"],
    "in/coll": [ROOT_COLLATION.slice("in/coll/".length)],
    brkitr: ["dictionaries", "rules"],
  };
  for (const [dir, notBuilt] of Object.entries(NOT_BUILT)) {
    for (const entry of readdirSync(join(dataDir, dir), { withFileTypes: true })) {
      // The build files at the top, and the bundles' sources in brkitr, which are all built.
      if ((dir === "" || dir === "brkitr") && !entry.isDirectory()) continue;
      if (!known[dir]!.includes(entry.name) && !notBuilt.includes(entry.name)) {
        die(`data/${join(dir, entry.name)} is neither built nor known to be left out`);
      }
    }
  }
}

/** The paths of the resources that have keys in the sources of the locales' bundles. */
const localePaths = new Set<string>();
for (const bundle of stems("locales")) resourcePaths(read(join(dataDir, "locales", bundle + ".txt")), localePaths);

/** The paths of the patterns that some locale has, for a date or for a range, for the skeletons that match. */
function skeletons(matching: RegExp): string[] {
  const found = [...localePaths].filter(
    path =>
      /^calendar\/[^/]+\/(availableFormats|intervalFormats)\/[^/]+$/.test(path) &&
      matching.test(path.slice(path.lastIndexOf("/") + 1)),
  );
  return [...new Set(found.map(path => path.replace(/^calendar\/[^/]+/, "calendar/*")))];
}

/**
 * The grammatical cases, other than the nominative, that a language puts a unit in when it is part of "A per B":
 * `derivations{ <language>{ component{ case{ per{ "<of A>", "<of B>" } } } } }`, where "compound" is the case of the
 * whole, which is the nominative unless unitDisplayCase says otherwise. A language that has no rules goes by the root's.
 */
const casesByLanguage = new Map(
  find(
    parseSource(read(join(dataDir, "misc/grammaticalFeatures.txt"))),
    "grammaticalFeatures/grammaticalData/derivations/*",
  ).map(language => [
    language.name,
    find(language, "component/case/per")
      .flatMap(values)
      .filter(c => c !== "compound" && c !== "nominative"),
  ]),
);
if (!casesByLanguage.has("root")) die("grammaticalFeatures.txt has no rules for the root");
const unitCases = (bundle: string) => casesByLanguage.get(bundle.split("_")[0]!) ?? casesByLanguage.get("root")!;

/** Whether a locale finds, in its own bundle or a parent's, how to put a date "at" a time in the Gregorian calendar. */
const localeParents = localeDeps("locales").parents ?? {};
function hasAtTime(bundle: string): boolean {
  if (bundle === "root") return false;
  if (/DateTimePatterns%atTime/.test(read(join(dataDir, "locales", bundle + ".txt")))) {
    const source = parseSource(read(join(dataDir, "locales", bundle + ".txt")));
    if (find(source, "*/calendar/gregorian/DateTimePatterns%atTime").length) return true;
  }
  return hasAtTime(localeParents[bundle] ?? (bundle.includes("_") ? bundle.slice(0, bundle.lastIndexOf("_")) : "root"));
}

const unshownZoneNames = findUnshownZoneNames();

// ───────────────────────────────────────────────────────────────────────────
// Package
// ───────────────────────────────────────────────────────────────────────────

/**
 * An item that is a header, and then int32 indexes of which some are the offsets from there of its sections, each of
 * which ends where the next starts.
 * @param last the index of the offset of the end of the last section
 */
function withoutSections(item: Buffer, sections: number[], last: number): Buffer {
  const base = item.readUInt16LE(0);
  const offset = (i: number) => item.readInt32LE(base + i * 4);
  // The item is padded after that.
  const parts = [item.subarray(0, base + offset(sections[0]!))];
  let removed = 0;
  const indexes = Buffer.from(item.subarray(base, base + (last + 1) * 4));
  for (let i = sections[0]!; i < last; i++) {
    if (offset(i + 1) < offset(i)) die("the sections of an item are not in order");
    if (sections.includes(i)) removed += offset(i + 1) - offset(i);
    else if (offset(i + 1) > offset(i) && removed % 4)
      die("what is after what is left out of an item would not be aligned");
    else parts.push(item.subarray(base + offset(i), base + offset(i + 1)));
    indexes.writeInt32LE(offset(i + 1) - removed, (i + 1) * 4);
  }
  if (removed === 0) die("an item has nothing of what is to be left out");
  const result = Buffer.concat(parts);
  indexes.copy(result, base);
  return result;
}

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
    const item = readFileSync(join(args.work!, name));
    push(PACKAGED_WITHOUT[name.slice(pkg.length + 1)]?.(item) ?? item);
    push(pad(offset));
  });
  return Buffer.concat([header, toc, ...parts]);
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

rmSync(args.work!, { recursive: true, force: true });
for (const tree of TREES) mkdirSync(join(outDir, tree.out), { recursive: true });
checkInputs();
checkRbnf();
checkAllRules();
checkUnnamed();

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

const breakRules = stems("brkitr/rules").filter(rules => !BREAK_RULES_LEFT_OUT.has(rules));
if (breakRules.length + BREAK_RULES_LEFT_OUT.size !== stems("brkitr/rules").length)
  die("there are no such break rules to leave out");

// brkitr's bundles name these as dependencies, and genrb -k requires that they exist.
const breakData = Promise.all([
  ...breakRules.map(rules =>
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
          bundle in MISC_EDITS
            ? edited("misc", [bundle], (_, text) => MISC_EDITS[bundle]!(text))
            : join(dataDir, "misc"),
          "",
          [...(bundle in MISC_FILTERS ? filterDir("misc", [bundle], () => MISC_FILTERS[bundle]!) : []), "-q"],
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

// Backslashes are Windows path separators, which make and ninja accept as /.
const escape = (path: string) => path.replaceAll("\\", "/").replaceAll(" ", "\\ ");
if (args.depfile) writeFileSync(args.depfile, `${escape(args.out!)}: ${[...inputs].map(escape).join(" ")}\n`);
console.log(`${basename(args.out!)}: ${packaged.length} bytes${unchanged ? " (unchanged)" : ""}`);
