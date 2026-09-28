// Compares builds of Bun on what ICU's data representation can change: how long the first use of an API takes in a
// new process, how fast it is once warm, and how much memory it leaves behind.
//
//   bun bench.ts [--runs N] [--only first|warm|sweep|idle] name=<bun executable> name=<bun executable> ...
//
// Each measurement is a new process; the builds take turns, so that drift in the machine falls on all of them.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
let runs = 30;
if (argv[0] === "--runs") runs = Number(argv.splice(0, 2)[1]);
const only = argv[0] === "--only" ? argv.splice(0, 2)[1] : undefined;
const wanted = (section: string) => only === undefined || only === section;
const builds = argv.map(a => a.split("=") as [string, string]);

const LOCALES = ["en-US", "de", "fr", "es", "ja", "zh", "ko", "ar", "hi", "ru", "pt-BR", "th"];

/** name → the body of a function of `locale`. What is timed is its first call, then calls after the 2000th. */
const first: Record<string, string> = {
  "DateTimeFormat default": `new Intl.DateTimeFormat(locale).format(0)`,
  "DateTimeFormat full": `new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "full", timeZone: "Europe/Paris" }).format(0)`,
  "toLocaleDateString": `new Date(0).toLocaleDateString(locale)`,
  "NumberFormat decimal": `new Intl.NumberFormat(locale).format(1234.5)`,
  "NumberFormat currency": `new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(1234.5)`,
  "NumberFormat currency name": `new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", currencyDisplay: "name" }).format(1234.5)`,
  "NumberFormat unit long": `new Intl.NumberFormat(locale, { style: "unit", unit: "kilometer-per-hour", unitDisplay: "long" }).format(12)`,
  "NumberFormat compact": `new Intl.NumberFormat(locale, { notation: "compact" }).format(1234567)`,
  "PluralRules": `new Intl.PluralRules(locale).select(2)`,
  "RelativeTimeFormat": `new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day")`,
  "ListFormat": `new Intl.ListFormat(locale).format(["a", "b", "c"])`,
  "DisplayNames region": `new Intl.DisplayNames(locale, { type: "region" }).of("JP")`,
  "DisplayNames language": `new Intl.DisplayNames(locale, { type: "language" }).of("fr-CA")`,
  "Collator sort": `["b", "a", "ä", "z", "Z"].sort(new Intl.Collator(locale).compare)`,
  "localeCompare": `"a".localeCompare("b", locale)`,
  "Segmenter word": `[...new Intl.Segmenter(locale, { granularity: "word" }).segment("Hello world. 今日は天気がいい。สวัสดีครับ")].length`,
  "Segmenter grapheme": `[...new Intl.Segmenter(locale).segment("e\\u0301👨‍👩‍👧abc")].length`,
};

const dir = mkdtempSync(join(tmpdir(), "icu-bench-"));
const rss = `Number(/VmRSS:\\s+(\\d+)/.exec(require("fs").readFileSync("/proc/self/status", "utf8"))[1])`;
const anon = `Number(/RssAnon:\\s+(\\d+)/.exec(require("fs").readFileSync("/proc/self/status", "utf8"))[1])`;

const firstScript = join(dir, "first.js");
writeFileSync(
  firstScript,
  `const cases = {${Object.entries(first)
    .map(([n, b]) => `${JSON.stringify(n)}: locale => ${b}`)
    .join(",\n")}};
const [name, locale] = process.argv.slice(2);
const fn = cases[name];
const t0 = performance.now(); fn(locale); const t1 = performance.now();
for (let i = 0; i < 2000; i++) fn(locale);
// The fastest of many short batches: what else the machine is doing can only slow one down.
let warm = Infinity;
for (let batch = 0; batch < 40; batch++) {
  const t = performance.now(); for (let i = 0; i < 100; i++) fn(locale);
  warm = Math.min(warm, (performance.now() - t) * 10);
}
console.log(JSON.stringify({ first: (t1 - t0) * 1000, warm }));`,
);

const sweepScript = join(dir, "sweep.js");
writeFileSync(
  sweepScript,
  `const locales = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const before = { rss: ${rss}, anon: ${anon} };
const t0 = performance.now();
for (const l of locales) {
  new Intl.DateTimeFormat(l, { dateStyle: "full", timeStyle: "full" }).format(0);
  new Intl.NumberFormat(l, { style: "currency", currency: "EUR", currencyDisplay: "name" }).format(2);
  new Intl.NumberFormat(l, { style: "unit", unit: "kilometer", unitDisplay: "long" }).format(2);
  new Intl.DisplayNames(l, { type: "region" }).of("JP");
  new Intl.DisplayNames(l, { type: "language" }).of("fr");
  new Intl.Collator(l).compare("a", "b");
}
const ms = performance.now() - t0;
Bun.gc(true);
console.log(JSON.stringify({ ms, rss: ${rss} - before.rss, anon: ${anon} - before.anon }));`,
);

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", LANG: "en_US.UTF-8" };
function measure(exe: string, args: string[]): Record<string, number> {
  const r = spawnSync(exe, args, { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]!;
const cell = (n: number, digits = 0) => n.toFixed(digits).padStart(9);

console.log(`median of ${runs} processes each\n`);
const header = (unit: string) => "".padEnd(30) + builds.map(([n]) => `${n} ${unit}`.padStart(16)).join("");

// ─── First use, per API, for English and averaged over other locales ───
for (const group of wanted("first") ? [["en-US"], LOCALES.slice(1)] : []) {
  console.log(`first call in a new process, ${group.length === 1 ? group[0] : `mean over ${group.join(" ")}`}`);
  console.log(header("µs"));
  const totals = builds.map(() => 0);
  for (const name of Object.keys(first)) {
    const sums = builds.map(() => 0);
    for (const locale of group) {
      const samples = builds.map(() => [] as number[]);
      for (let i = 0; i < runs; i++)
        builds.forEach(([, exe], b) => samples[b]!.push(measure(exe, [firstScript, name, locale]).first!));
      samples.forEach((s, b) => (sums[b]! += median(s) / group.length));
    }
    sums.forEach((s, b) => (totals[b]! += s));
    console.log(name.padEnd(30) + sums.map(s => cell(s).padStart(16)).join(""));
  }
  console.log("sum".padEnd(30) + totals.map(s => cell(s).padStart(16)).join("") + "\n");
}

// ─── Warm ───
if (wanted("warm")) {
  console.log("construct and use once warm, mean over " + LOCALES.join(" "));
  console.log(header("µs"));
}
for (const name of wanted("warm") ? Object.keys(first) : []) {
  const sums = builds.map(() => 0);
  for (const locale of LOCALES) {
    const samples = builds.map(() => [] as number[]);
    for (let i = 0; i < 5; i++)
      builds.forEach(([, exe], b) => samples[b]!.push(measure(exe, [firstScript, name, locale]).warm!));
    samples.forEach((s, b) => (sums[b]! += Math.min(...s) / LOCALES.length));
  }
  console.log(name.padEnd(30) + sums.map(s => cell(s, 2).padStart(16)).join(""));
}

// ─── Many locales in one process ───
const inputs = process.env.ORACLE_INPUTS;
if (inputs && wanted("sweep")) {
  console.log("\nsix formatters in each of every locale, one process");
  for (const metric of ["ms", "rss", "anon"] as const) {
    const samples = builds.map(() => [] as number[]);
    for (let i = 0; i < 7; i++)
      builds.forEach(([, exe], b) =>
        samples[b]!.push(measure(exe, [sweepScript, join(inputs, "locales.json")])[metric]!),
      );
    const label = { ms: "time, ms", rss: "resident memory added, KB", anon: "of which private (heap), KB" }[metric];
    console.log(label.padEnd(30) + samples.map(s => cell(median(s)).padStart(16)).join(""));
  }
}

// ─── Nothing to do with ICU ───
const empty = join(dir, "empty.js");
writeFileSync(empty, `console.log(JSON.stringify({ rss: ${rss} }))`);
if (wanted("idle")) {
  console.log("\nprocess that never touches Intl");
  const wall = builds.map(() => [] as number[]);
  const mem = builds.map(() => [] as number[]);
  for (let i = 0; i < runs * 2; i++) {
    builds.forEach(([, exe], b) => {
      const t = performance.now();
      mem[b]!.push(measure(exe, [empty]).rss!);
      wall[b]!.push(performance.now() - t);
    });
  }
  console.log("wall, ms".padEnd(30) + wall.map(s => cell(median(s), 2).padStart(16)).join(""));
  console.log("resident memory, KB".padEnd(30) + mem.map(s => cell(median(s)).padStart(16)).join(""));
}
