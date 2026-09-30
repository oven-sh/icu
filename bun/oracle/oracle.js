// Prints a hash of what every ICU-backed JavaScript API returns, one line per (section, subject).
// Two builds of Bun whose output is the same behave the same for everything asked here.
//
//   bun oracle.js <inputs dir> <section> <shard> <shards> [--dump <key prefix>]
//
// Plain JavaScript with no imports beyond node:fs, so that any build of Bun can run it.

const fs = require("node:fs");
const [inputsDir, section, shardArg, shardsArg, dumpFlag, dumpPrefix] = process.argv.slice(2);
const shard = Number(shardArg);
const shards = Number(shardsArg);
const dumping = dumpFlag === "--dump";

const input = name => JSON.parse(fs.readFileSync(`${inputsDir}/${name}.json`, "utf8"));
const mine = list => list.filter((_, i) => i % shards === shard);
const out = [];

/** Collects the strings for one key; what is printed is their hash, or with --dump the strings. */
function record(key, fill) {
  if (dumping && !key.startsWith(dumpPrefix)) return;
  const hasher = new Bun.CryptoHasher("md5");
  let count = 0;
  const add = value => {
    count++;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (dumping) out.push(`${key}\t${count}\t${text}`);
    hasher.update(text);
    hasher.update("\0");
  };
  /** The result, or how it failed: an API that starts throwing is a difference. */
  add.try = fn => {
    try {
      add(fn());
    } catch (e) {
      add(`!${e?.name}: ${e?.message}`);
    }
  };
  try {
    fill(add);
  } catch (e) {
    add(`!!${e?.name}: ${e?.message}`);
  }
  if (!dumping) out.push(`${key}\t${count}\t${hasher.digest("hex")}`);
  if (out.length > 2000) flush();
}
function flush() {
  if (out.length) fs.writeSync(1, out.join("\n") + "\n");
  out.length = 0;
}

const parts = list => list.map(p => `${p.type}${p.source ? "@" + p.source : ""}=${p.value}`).join("|");
const supported = key => Intl.supportedValuesOf(key);
const DAY = 86400000;

// Dates chosen for what selects different data: both halves of the year (daylight time), a leap day, the last second
// of a year, before 1970, before common era, the far future, and each side of the Japanese era changes.
const DATES = [
  0,
  200.5 * DAY,
  951782400000,
  1e12,
  1700000000000,
  1735689599000,
  -1e12,
  4102444800000,
  -62135596800001,
  -3218832000000,
  -1812153600000,
  -1357603200000,
  600220800000,
  1556668800000,
  1556668799000,
];

const sections = {
  // ─── Intl.DateTimeFormat ───

  "dtf-style"() {
    const styles = [undefined, "full", "long", "medium", "short"];
    for (const locale of mine(input("locales"))) {
      for (const calendar of supported("calendar")) {
        record(`dtf-style/${locale}/${calendar}`, add => {
          for (const dateStyle of styles) {
            for (const timeStyle of styles) {
              if (!dateStyle && !timeStyle) continue;
              for (const timeZone of ["UTC", "America/Los_Angeles"]) {
                const f = new Intl.DateTimeFormat(locale, { calendar, dateStyle, timeStyle, timeZone });
                for (const d of DATES) add.try(() => f.format(d));
                add.try(() => parts(f.formatToParts(DATES[3])));
              }
            }
          }
          add(new Intl.DateTimeFormat(locale, { calendar }).resolvedOptions());
        });
      }
    }
  },

  // Every name a calendar has: a step of 29 days through 3 years visits every month (leap months too) and weekday.
  "dtf-names"() {
    const widths = ["long", "short", "narrow"];
    for (const locale of mine(input("locales"))) {
      for (const calendar of supported("calendar")) {
        record(`dtf-names/${locale}/${calendar}`, add => {
          const formats = [];
          for (const w of widths) {
            formats.push({ month: w }, { weekday: w }, { era: w }, { dayPeriod: w, hour: "numeric" });
            formats.push(
              { month: w, day: "numeric" },
              { month: w, year: "numeric", era: w },
              { weekday: w, month: w, day: "numeric", year: "numeric" },
            );
          }
          formats.push(
            { month: "numeric" },
            { month: "2-digit", day: "2-digit", year: "2-digit" },
            { year: "numeric" },
          );
          for (const options of formats) {
            const f = new Intl.DateTimeFormat(locale, { calendar, timeZone: "UTC", ...options });
            for (let i = 0; i < 40; i++) add.try(() => f.format(1600000000000 + i * 29 * DAY + i * 3700000));
            for (const d of DATES) add.try(() => f.format(d));
          }
        });
      }
    }
  },

  // Skeletons, which is what exercises the pattern generator and its per-locale availableFormats/appendItems.
  "dtf-skeleton"() {
    const n = "numeric";
    const skeletons = [
      { hour: n },
      { hour: n, minute: n },
      { hour: n, minute: n, second: n },
      { minute: n, second: n },
      { hour: "2-digit", minute: "2-digit" },
      { hour: n, hour12: true },
      { hour: n, hour12: false },
      { hour: n, minute: n, hourCycle: "h11" },
      { hour: n, minute: n, hourCycle: "h12" },
      { hour: n, minute: n, hourCycle: "h23" },
      { hour: n, minute: n, hourCycle: "h24" },
      { hour: n, minute: n, second: n, fractionalSecondDigits: 3 },
      { second: n, fractionalSecondDigits: 1 },
      { minute: n, second: n, fractionalSecondDigits: 2 },
      { hour: n, dayPeriod: "long" },
      { hour: n, minute: n, dayPeriod: "short" },
      { year: n, month: n },
      { year: n, month: "short" },
      { year: n, month: "long" },
      { year: n, month: n, day: n },
      { year: "2-digit", month: n, day: n },
      { month: n, day: n },
      { month: "short", day: n },
      { month: "long", day: n },
      { weekday: "short", day: n },
      { weekday: "long", month: "long", day: n },
      { weekday: "short", month: "short", day: n },
      { weekday: "short", year: n, month: "short", day: n },
      { weekday: "long", year: n, month: "long", day: n },
      { weekday: "narrow", year: n, month: "narrow", day: n },
      { era: "short", year: n },
      { era: "long", year: n, month: "long" },
      { era: "narrow", year: n, month: n, day: n },
      { year: n, month: n, day: n, hour: n, minute: n },
      { year: n, month: "short", day: n, hour: n, minute: n, second: n },
      { weekday: "long", hour: n },
      { weekday: "short", hour: n, minute: n },
      { month: "long", day: n, hour: n, minute: n, timeZoneName: "short" },
      { day: n },
      { day: "2-digit" },
      { day: n, hour: n },
      { year: n, hour: n },
      { month: "long", hour: n, minute: n },
      { year: n, month: "long", day: n, weekday: "long", hour: n, minute: n, second: n, timeZoneName: "long" },
      {
        era: "short",
        weekday: "short",
        year: n,
        month: "short",
        day: n,
        hour: n,
        minute: n,
        second: n,
        fractionalSecondDigits: 3,
        timeZoneName: "shortOffset",
      },
    ];
    for (const locale of mine(input("locales"))) {
      const calendars = new Set([
        "gregory",
        new Intl.DateTimeFormat(locale).resolvedOptions().calendar,
        "japanese",
        "chinese",
        "islamic-civil",
        "hebrew",
      ]);
      for (const calendar of calendars) {
        record(`dtf-skeleton/${locale}/${calendar}`, add => {
          for (const skeleton of skeletons) {
            const f = new Intl.DateTimeFormat(locale, { calendar, timeZone: "Europe/Berlin", ...skeleton });
            for (const d of [DATES[1], DATES[3], DATES[5], 1700000000000 + 11 * 3600000]) add.try(() => f.format(d));
            add.try(() => parts(f.formatToParts(DATES[4])));
            const r = f.resolvedOptions();
            add(`${r.hourCycle} ${r.hour12} ${r.numberingSystem}`);
          }
        });
      }
    }
  },

  "dtf-range"() {
    const n = "numeric";
    const skeletons = [
      { dateStyle: "full" },
      { dateStyle: "long" },
      { dateStyle: "medium" },
      { dateStyle: "short" },
      { timeStyle: "short" },
      { timeStyle: "medium" },
      { dateStyle: "medium", timeStyle: "short" },
      { year: n },
      { year: n, month: n },
      { year: n, month: "short" },
      { year: n, month: "long" },
      { year: n, month: n, day: n },
      { year: n, month: "short", day: n },
      { year: n, month: "long", day: n, weekday: "long" },
      { month: n },
      { month: "long" },
      { month: n, day: n },
      { month: "short", day: n },
      { month: "short", day: n, weekday: "short" },
      { day: n },
      { hour: n },
      { hour: n, minute: n },
      { hour: n, hour12: false },
      { hour: n, minute: n, hour12: false },
      { hour: n, minute: n, timeZoneName: "short" },
      { hour: n, dayPeriod: "short" },
      { era: "short", year: n, month: "short", day: n },
      { year: n, month: "short", day: n, hour: n, minute: n },
    ];
    const start = 1700000000000;
    const ends = [
      start,
      start + 60000,
      start + 3600000,
      start + 9 * 3600000,
      start + DAY,
      start + 20 * DAY,
      start + 70 * DAY,
      start + 400 * DAY,
      start + 40000 * DAY,
    ];
    for (const locale of mine(input("locales"))) {
      for (const calendar of supported("calendar")) {
        record(`dtf-range/${locale}/${calendar}`, add => {
          for (const skeleton of skeletons) {
            const f = new Intl.DateTimeFormat(locale, { calendar, timeZone: "UTC", ...skeleton });
            for (const end of ends) add.try(() => f.formatRange(start, end));
            add.try(() => parts(f.formatRangeToParts(start, ends[5])));
          }
        });
      }
    }
  },

  // Every zone's every kind of name.
  "dtf-zone"() {
    const kinds = ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"];
    const zones = supported("timeZone");
    for (const locale of mine(input("locales"))) {
      for (const timeZoneName of kinds) {
        record(`dtf-zone/${locale}/${timeZoneName}`, add => {
          for (const timeZone of zones) {
            const f = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName, hour: "numeric" });
            add.try(() => f.format(1705000000000));
            add.try(() => f.format(1720000000000));
          }
        });
      }
    }
  },

  // The names a zone had in the metazones it has since left.
  "dtf-zone-history"() {
    const periods = Object.entries(input("zonePeriods"));
    for (const locale of mine(input("locales"))) {
      for (const timeZoneName of ["short", "long", "shortGeneric", "longGeneric"]) {
        record(`dtf-zone-history/${locale}/${timeZoneName}`, add => {
          for (const [timeZone, instants] of periods) {
            let f;
            try {
              f = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName, year: "numeric" });
            } catch (e) {
              add(`!${e.name}: ${e.message}`);
              continue;
            }
            for (const t of instants) add(f.format(t));
          }
        });
      }
    }
  },

  "dtf-numbering"() {
    for (const locale of mine(input("locales"))) {
      record(`dtf-numbering/${locale}`, add => {
        for (const numberingSystem of supported("numberingSystem")) {
          const f = new Intl.DateTimeFormat(locale, {
            numberingSystem,
            dateStyle: "short",
            timeStyle: "medium",
            timeZone: "UTC",
          });
          add.try(() => f.format(DATES[4]));
        }
      });
    }
  },

  // ─── Time zone rules ───

  "zone-rules"() {
    for (const timeZone of mine(input("zones"))) {
      record(`zone-rules/${timeZone}`, add => {
        let f;
        try {
          f = new Intl.DateTimeFormat("en", {
            timeZone,
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            timeZoneName: "longOffset",
            hourCycle: "h23",
          });
        } catch (e) {
          return add(`!${e.name}: ${e.message}`);
        }
        add(f.resolvedOptions().timeZone);
        for (const spelling of [timeZone.toLowerCase(), timeZone.toUpperCase()]) {
          add.try(() => new Intl.DateTimeFormat("en", { timeZone: spelling }).resolvedOptions().timeZone);
        }
        for (let t = -3786825600000; t < 5680281600000; t += 13.37 * DAY) add(f.format(t));
      });
    }
  },

  // ─── Intl.NumberFormat ───

  "nf-basic"() {
    const values = [
      0,
      -0,
      1,
      -1,
      1.5,
      2,
      5,
      12,
      123.456,
      1234,
      12345.678,
      1234567.891,
      1e9,
      1e15,
      1e21,
      1e-7,
      NaN,
      Infinity,
      -Infinity,
      123456789012345678901234567890n,
      "0.1000000000000000000001",
    ];
    const variants = [
      {},
      { style: "percent" },
      { style: "percent", maximumFractionDigits: 2 },
      { useGrouping: false },
      { useGrouping: "always" },
      { useGrouping: "min2" },
      { signDisplay: "always" },
      { signDisplay: "exceptZero" },
      { signDisplay: "never" },
      { signDisplay: "negative" },
      { notation: "scientific" },
      { notation: "engineering" },
      { notation: "scientific", signDisplay: "always" },
      { minimumIntegerDigits: 4 },
      { minimumFractionDigits: 3 },
      { maximumSignificantDigits: 3 },
      { roundingIncrement: 5, maximumFractionDigits: 2, minimumFractionDigits: 2 },
      { trailingZeroDisplay: "stripIfInteger", minimumFractionDigits: 2 },
      { roundingPriority: "morePrecision", maximumSignificantDigits: 2, maximumFractionDigits: 2 },
    ];
    for (const locale of mine(input("locales"))) {
      record(`nf-basic/${locale}`, add => {
        for (const options of variants) {
          const f = new Intl.NumberFormat(locale, options);
          for (const v of values) add.try(() => f.format(v));
          add.try(() => parts(f.formatToParts(-12345.678)));
          add.try(() => f.formatRange(3, 5));
          add.try(() => f.formatRange(-3, 12345));
          add.try(() => f.formatRange(2.9, 3.1));
          add.try(() => parts(f.formatRangeToParts(1, 1000000)));
        }
        add(new Intl.NumberFormat(locale).resolvedOptions());
      });
    }
  },

  "nf-compact"() {
    for (const locale of mine(input("locales"))) {
      record(`nf-compact/${locale}`, add => {
        for (const compactDisplay of ["short", "long"]) {
          for (const extra of [
            {},
            { style: "currency", currency: "USD" },
            { style: "currency", currency: "JPY", currencyDisplay: "name" },
            { style: "currency", currency: "EUR", currencyDisplay: "code" },
            { style: "currency", currency: "CHF" },
            { style: "currency", currency: "SEK", currencyDisplay: "narrowSymbol" },
            { style: "currency", currency: "USD", currencySign: "accounting", signDisplay: "always" },
            { style: "unit", unit: "meter" },
            { style: "percent" },
          ]) {
            const f = new Intl.NumberFormat(locale, { notation: "compact", compactDisplay, ...extra });
            for (let e = 0; e <= 16; e++) for (const m of [1, 2, 5, 1.5, 9.99]) add.try(() => f.format(m * 10 ** e));
            add.try(() => f.formatRange(1000, 5000000));
          }
        }
      });
    }
  },

  "nf-numbering"() {
    for (const locale of mine(input("locales"))) {
      record(`nf-numbering/${locale}`, add => {
        for (const numberingSystem of supported("numberingSystem")) {
          for (const options of [
            {},
            { style: "percent" },
            { style: "currency", currency: "EUR" },
            { notation: "scientific" },
            { notation: "compact" },
          ]) {
            const f = new Intl.NumberFormat(locale, { numberingSystem, ...options });
            for (const v of [-1234567.891, 0, NaN, Infinity]) add.try(() => f.format(v));
          }
        }
      });
    }
  },

  "nf-currency"() {
    const currencies = [
      ...new Set([...supported("currency"), ...input("codes").currencies, "XXX", "XTS", "ZZZ", "AAA"]),
    ].filter(c => /^[A-Z]{3}$/.test(c));
    for (const locale of mine(input("locales"))) {
      for (const currencyDisplay of ["symbol", "narrowSymbol", "code", "name"]) {
        record(`nf-currency/${locale}/${currencyDisplay}`, add => {
          for (const currency of currencies) {
            const f = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay });
            for (const v of [0, 1, 2, 3, 5.5, 11, 1234567.891]) add.try(() => f.format(v));
            const g = new Intl.NumberFormat(locale, {
              style: "currency",
              currency,
              currencyDisplay,
              currencySign: "accounting",
            });
            add.try(() => g.format(-1234.5));
          }
        });
      }
    }
  },

  "nf-unit"() {
    const units = supported("unit");
    for (const locale of mine(input("locales"))) {
      for (const unitDisplay of ["long", "short", "narrow"]) {
        record(`nf-unit/${locale}/${unitDisplay}`, add => {
          for (const unit of units) {
            const f = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay });
            for (const v of [0, 1, 2, 3, 5, 11, 21, 100, 1.5, 1234567.891]) add.try(() => f.format(v));
            add.try(() => parts(f.formatToParts(2)));
            add.try(() => f.formatRange(1, 5));
          }
        });
      }
    }
  },

  // Every pair: some have a name of their own in the data, the rest are put together from patterns, and in
  // languages with grammatical case from inflected forms.
  "nf-unit-per"() {
    const units = supported("unit");
    for (const locale of mine(input("locales"))) {
      for (const unitDisplay of ["long", "short", "narrow"]) {
        record(`nf-unit-per/${locale}/${unitDisplay}`, add => {
          for (const a of units) {
            for (const b of units) {
              const f = new Intl.NumberFormat(locale, { style: "unit", unit: `${a}-per-${b}`, unitDisplay });
              add.try(() => f.format(1));
              add.try(() => f.format(2.5));
            }
          }
        });
      }
    }
  },

  // ─── The smaller formatters ───

  plural() {
    const values = [];
    for (let i = 0; i <= 220; i++) values.push(i);
    values.push(
      1000,
      1001,
      10000,
      100000,
      1e6,
      2e6,
      1e6 + 1,
      1e9,
      1e12,
      0.1,
      0.5,
      1.1,
      1.5,
      2.1,
      10.1,
      0.01,
      1.01,
      1.21,
      100.5,
    );
    for (const locale of mine(input("locales"))) {
      record(`plural/${locale}`, add => {
        for (const type of ["cardinal", "ordinal"]) {
          for (const options of [
            {},
            { minimumFractionDigits: 1 },
            { minimumFractionDigits: 2 },
            { notation: "compact" },
            { maximumSignificantDigits: 1 },
          ]) {
            const p = new Intl.PluralRules(locale, { type, ...options });
            add(values.map(v => p.select(v)[0]).join(""));
            add(p.resolvedOptions().pluralCategories);
            for (const a of [0, 1, 2, 3, 5, 11, 21, 100, 1.5])
              for (const b of [1, 2, 3, 5, 11, 21, 101, 1e6, 2.5]) if (a <= b) add.try(() => p.selectRange(a, b));
          }
        }
      });
    }
  },

  relative() {
    const units = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
    const values = [-1000, -100, -21, -11, -5, -3, -2, -1, -0, 0, 1, 2, 3, 5, 11, 21, 100, 1000, 1.5, -1.5, 12345.678];
    for (const locale of mine(input("locales"))) {
      record(`relative/${locale}`, add => {
        for (const style of ["long", "short", "narrow"]) {
          for (const numeric of ["always", "auto"]) {
            const f = new Intl.RelativeTimeFormat(locale, { style, numeric });
            for (const unit of units) {
              for (const v of values) add.try(() => f.format(v, unit));
              add.try(() => parts(f.formatToParts(-3, unit)));
            }
          }
        }
        add(new Intl.RelativeTimeFormat(locale).resolvedOptions());
      });
    }
  },

  list() {
    // Spanish and Hebrew choose the conjunction by how the next word starts.
    const lists = [
      [],
      ["a"],
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
      ["a", "b", "c", "d", "e", "f"],
      ["x", "iglesia"],
      ["x", "hielo"],
      ["x", "otro"],
      ["x", "8"],
      ["x", "11"],
      ["x", "y", "ocho"],
      ["א", "ב"],
      ["א", "b"],
      ["x", "hola", "Inés"],
    ];
    for (const locale of mine(input("locales"))) {
      record(`list/${locale}`, add => {
        for (const type of ["conjunction", "disjunction", "unit"]) {
          for (const style of ["long", "short", "narrow"]) {
            const f = new Intl.ListFormat(locale, { type, style });
            for (const l of lists) add.try(() => f.format(l));
            add.try(() => parts(f.formatToParts(lists[3])));
          }
        }
      });
    }
  },

  duration() {
    if (typeof Intl.DurationFormat !== "function") return record("duration/unsupported", add => add("none"));
    const durations = [
      {
        years: 1,
        months: 2,
        weeks: 3,
        days: 4,
        hours: 5,
        minutes: 6,
        seconds: 7,
        milliseconds: 8,
        microseconds: 9,
        nanoseconds: 10,
      },
      { hours: 1, minutes: 1, seconds: 1 },
      { hours: 2, minutes: 30 },
      { minutes: 5, seconds: 3, milliseconds: 250 },
      { days: 1 },
      { years: 5, days: 21 },
      { seconds: 0 },
      { hours: -1, minutes: -30 },
      { hours: 12345, seconds: 1.0 },
      { weeks: 2, nanoseconds: 1 },
      { months: 11, milliseconds: 1500 },
    ];
    for (const locale of mine(input("locales"))) {
      record(`duration/${locale}`, add => {
        for (const style of ["long", "short", "narrow", "digital"]) {
          for (const extra of [
            {},
            { fractionalDigits: 2 },
            { hours: "2-digit" },
            { secondsDisplay: "always", minutesDisplay: "always" },
          ]) {
            let f;
            try {
              f = new Intl.DurationFormat(locale, { style, ...extra });
            } catch (e) {
              add(`!${e.name}: ${e.message}`);
              continue;
            }
            for (const d of durations) add.try(() => f.format(d));
            add.try(() => parts(f.formatToParts(durations[0])));
          }
        }
      });
    }
  },

  // What the specification does not let through to ICU. That these are refused is why the data behind them is not needed.
  refused() {
    const codes = input("codes");
    const sanctioned = new Set(supported("unit"));
    for (const locale of mine(input("locales"))) {
      record(`refused/${locale}`, add => {
        for (const unit of input("unitIds")) {
          if (sanctioned.has(unit)) continue;
          add.try(() => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(2));
        }
        for (const unit of [
          "square-meter",
          "cubic-meter",
          "meter-per-square-second",
          "kilowatt-hour",
          "meter-meter",
          "pow2-meter",
          "kibibyte",
          "per-second",
          "meter-and-centimeter",
          "meter-per-second-per-second",
        ]) {
          add.try(() => new Intl.NumberFormat(locale, { style: "unit", unit }).format(2));
        }
        const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
        for (const unit of [
          "sunday",
          "sun",
          "monday",
          "weekday",
          "dayOfWeek",
          "era",
          "dayperiod",
          "zone",
          "millisecond",
          "weekOfMonth",
          "days",
          "quarters",
        ]) {
          add.try(() => relative.format(-1, unit));
        }
        const language = new Intl.DisplayNames(locale, { type: "language" });
        const extensions = [
          "en-u-nu-arab",
          "de-u-co-phonebk",
          "en-u-ca-buddhist-hc-h12",
          "zh-u-nu-hanidec",
          "en-u-cf-account",
          "en-u-lb-strict",
          "en-u-ms-metric",
          "en-t-hi",
          "en-x-private",
          "en-u-va-posix",
          "en-a-bbb",
        ];
        for (const tag of extensions) add.try(() => language.of(tag));
        for (const type of [
          "key",
          "numberingSystem",
          "collation",
          "variant",
          "unit",
          "timeZone",
          "measurementSystem",
          "characterLabel",
        ]) {
          add.try(() => new Intl.DisplayNames(locale, { type }).of("latn"));
        }
        for (const key of codes.keys) add.try(() => new Intl.DisplayNames(locale, { type: "dateTimeField" }).of(key));
        for (const field of ["quarter", "weekOfYear", "dayOfYear", "weekdayOfMonth", "weekOfMonth", "zone"]) {
          add.try(() => new Intl.DateTimeFormat(locale, { [field]: "long" }).format(0));
        }
        for (const nu of [
          "hant",
          "hans",
          "jpan",
          "roman",
          "grek",
          "hebr",
          "armn",
          "ethi",
          "taml",
          "cyrl",
          "geor",
          "hantfin",
          "jpanfin",
          "romanlow",
          "finance",
          "native",
          "traditio",
        ]) {
          add.try(() => new Intl.NumberFormat(locale, { numberingSystem: nu }).format(1234));
          add.try(() => new Intl.NumberFormat(`${locale}-u-nu-${nu}`).resolvedOptions().numberingSystem);
          add.try(() =>
            new Intl.DateTimeFormat(`${locale}-u-nu-${nu}`, { dateStyle: "long", timeZone: "UTC" }).format(0),
          );
        }
        for (const granularity of ["line", "title", "character", "paragraph"])
          add.try(() => new Intl.Segmenter(locale, { granularity }).resolvedOptions().granularity);
        for (const tag of [
          `${locale}-u-lb-strict`,
          `${locale}-u-lw-phrase`,
          `${locale}-u-ss-standard`,
          `${locale}-u-dx-thai`,
        ]) {
          add.try(() => {
            const s = new Intl.Segmenter(tag, { granularity: "sentence" });
            return (
              s.resolvedOptions().locale +
              [...s.segment("Mr. Smith left. Dr. Jones e.g. stayed. 東京都に行きました。")].map(x => x.index).join()
            );
          });
        }
      });
    }
  },

  // ─── Intl.DisplayNames ───

  "names-language"() {
    const codes = input("codes");
    const tags = [...codes.languages];
    for (const v of codes.variants) tags.push(`en-${v}`, `de-CH-${v}`);
    for (const s of codes.scripts) tags.push(`zh-${s}`, `und-${s}`);
    for (const r of codes.regions) tags.push(`en-${r}`, `es-${r}`, `zh-Hant-${r}`);
    tags.push("xx", "qaa", "zz-Zzzz-ZZ", "en-Latn-US-fonipa-scouse", "sr-Cyrl-RS", "root", "i-klingon", "zh-min-nan");
    for (const locale of mine(input("locales"))) {
      for (const style of ["long", "short", "narrow"]) {
        record(`names-language/${locale}/${style}`, add => {
          for (const languageDisplay of ["dialect", "standard"]) {
            const f = new Intl.DisplayNames(locale, { type: "language", style, languageDisplay, fallback: "none" });
            for (const tag of tags) add.try(() => f.of(tag) ?? "∅");
          }
        });
      }
    }
  },

  "names-other"() {
    const codes = input("codes");
    const regions = new Set(codes.regions);
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) regions.add(String.fromCharCode(a, b));
    for (let i = 0; i < 1000; i++) regions.add(String(i).padStart(3, "0"));
    const wanted = {
      region: [...regions],
      script: [...codes.scripts, "Xxxx", "Qaaa", "Zzzz"],
      currency: [...codes.currencies.filter(c => /^[A-Z]{3}$/.test(c)), "XXX", "ZZZ"],
      calendar: [
        ...new Set([
          ...supported("calendar"),
          ...(codes.types.calendar ?? []),
          "islamicc",
          "ethiopic-amete-alem",
          "unknown",
        ]),
      ],
      dateTimeField: [
        "era",
        "year",
        "quarter",
        "month",
        "weekOfYear",
        "weekday",
        "day",
        "dayPeriod",
        "hour",
        "minute",
        "second",
        "timeZoneName",
      ],
    };
    for (const locale of mine(input("locales"))) {
      for (const type of Object.keys(wanted)) {
        record(`names-other/${locale}/${type}`, add => {
          for (const style of ["long", "short", "narrow"]) {
            const f = new Intl.DisplayNames(locale, { type, style, fallback: "none" });
            for (const code of wanted[type]) add.try(() => f.of(code) ?? "∅");
          }
        });
      }
    }
  },

  // ─── Intl.Collator ───

  // The order each tailoring gives to everything it mentions, among a background of every script.
  "collator-tailoring"() {
    const tailored = input("tailored");
    const background = [];
    for (let c = 0x20; c < 0x3000; c += 3) background.push(String.fromCharCode(c));
    for (let c = 0x3000; c < 0xd7a4; c += 97) background.push(String.fromCharCode(c));
    for (let c = 0x10000; c < 0x1fa00; c += 211) background.push(String.fromCodePoint(c));
    const jobs = [];
    for (const [id, types] of Object.entries(tailored)) for (const type of Object.keys(types)) jobs.push([id, type]);
    for (const [id, type] of mine(jobs)) {
      if (type.startsWith("private-")) continue;
      const base = id === "root" ? "und" : id.replace(/__.*|_$/, "").replaceAll("_", "-");
      record(`collator-tailoring/${id}/${type}`, add => {
        const words = [...new Set([...tailored[id][type], ...background])];
        for (const w of tailored[id][type].slice(0, 400)) words.push(w + "a", "a" + w, w + w);
        const c = new Intl.Collator(`${base}-u-co-${type}`);
        add(c.resolvedOptions());
        add(words.sort(c.compare).join("\u0001"));
      });
    }
  },

  "collator-options"() {
    const words = [
      "a",
      "A",
      "á",
      "Á",
      "ä",
      "ae",
      "b",
      "B",
      "z",
      "Z",
      "ß",
      "ss",
      "æ",
      "œ",
      "ø",
      "å",
      "ñ",
      "ch",
      "ll",
      "c",
      "d",
      "h",
      "i",
      "ı",
      "İ",
      "I",
      "co-op",
      "coop",
      "co op",
      "résumé",
      "resume",
      "Résumé",
      "1",
      "2",
      "10",
      "9",
      "a1",
      "a2",
      "a10",
      "a09",
      "٣",
      "３",
      "",
      " ",
      "-",
      "_",
      ".",
      "か",
      "が",
      "カ",
      "ｶ",
      "ゝ",
      "한",
      "韓",
      "中",
      "一",
      "丁",
      "😀",
      "é",
      "é",
      "­",
      "à́",
      "á̀",
      "ǆ",
      "Ǆ",
      "ǅ",
      "dž",
      "ⅷ",
      "viii",
      "™",
      "tm",
    ];
    const collations = supported("collation");
    for (const locale of mine(input("locales"))) {
      record(`collator-options/${locale}`, add => {
        for (const usage of ["sort", "search"]) {
          for (const sensitivity of [undefined, "base", "accent", "case", "variant"]) {
            for (const extra of [
              {},
              { numeric: true },
              { caseFirst: "upper" },
              { caseFirst: "lower" },
              { ignorePunctuation: true },
              { ignorePunctuation: false },
            ]) {
              const c = new Intl.Collator(locale, { usage, sensitivity, ...extra });
              add([...words].sort(c.compare).join("\u0001"));
              add(words.map(w => (c.compare(w, "a") === 0 ? 1 : 0)).join(""));
            }
          }
        }
        for (const collation of collations) {
          const c = new Intl.Collator(locale, { collation });
          add(c.resolvedOptions());
          add([...words].sort(c.compare).join("\u0001"));
        }
        add([...words].sort((a, b) => a.localeCompare(b, locale)).join("\u0001"));
      });
    }
  },

  // The conformance file is in root order already, so what is hashed is the sign of each neighbouring comparison.
  "collator-root"() {
    const lines = input("collationTest");
    const size = Math.ceil(lines.length / shards);
    const from = shard * size;
    record(`collator-root/${shard}`, add => {
      for (const options of [{}, { ignorePunctuation: true }, { sensitivity: "base" }]) {
        const c = new Intl.Collator("und", options);
        let signs = "";
        for (let i = Math.max(1, from); i < Math.min(lines.length, from + size); i++)
          signs += Math.sign(c.compare(lines[i - 1], lines[i])) + 1;
        add(signs);
      }
    });
  },

  // ─── Intl.Segmenter ───

  // Every dictionary word, run together in an order that puts each next to several others.
  "segmenter-dictionary"() {
    const dictionaries = { thaidict: "th", laodict: "lo", khmerdict: "km", burmesedict: "my", cjdict: "ja" };
    const chunk = 500;
    const jobs = [];
    for (const [dict, locale] of Object.entries(dictionaries)) jobs.push([dict, locale]);
    jobs.push(["cjdict", "zh"], ["cjdict", "en"], ["thaidict", "en"]);
    for (const [dict, locale] of jobs) {
      const words = input("dict-" + dict);
      const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      const count = Math.ceil(words.length / chunk);
      for (let k = shard; k < count; k += shards) {
        record(`segmenter-dictionary/${dict}/${locale}/${k}`, add => {
          const slice = words.slice(k * chunk, (k + 1) * chunk);
          for (const stride of [1, 7, 31]) {
            let text = "";
            for (let i = 0; i < slice.length; i++) text += slice[(i * stride) % slice.length];
            let cuts = "";
            for (const s of segmenter.segment(text)) cuts += s.index + (s.isWordLike ? "w" : "n");
            add(cuts);
          }
          for (const w of slice) {
            let cuts = "";
            for (const s of segmenter.segment(w)) cuts += s.index + ",";
            add(cuts);
          }
        });
      }
    }
  },

  "segmenter-rules"() {
    const tests = input("breakTests");
    const samples = [
      "Hello, world! It's 3.14 o'clock. Mr. Smith went to Washington, D.C. He said: \"Hi.\" Really? Yes!",
      "Dr. Müller z.B. sagt u.a. dass es ca. 5 Mio. sind. Nr. 5 ist da.",
      "Ε.Ε. είναι; Ναι. Τι κάνεις; Καλά.",
      "Это т.е. пример. Он сказал: «Да». И т.д.",
      "can't won't e.g. i.e. U.S.A. a.m. 10:30 1,234.56 foo_bar foo-bar foo.bar user@example.com http://example.com/a?b=c",
      "👨‍👩‍👧‍👦🇺🇸🇬🇧👍🏽 é 각 ก็ नमस्ते क्षि \r\n\t 🏴󠁧󠁢󠁥󠁮󠁧󠁿",
      "東京都に行きました。今日は天気がいいですね！明日も晴れるでしょうか？",
      "我们去北京。今天天气很好！你好吗？",
      "한국어 문장입니다. 두 번째 문장. 세 번째!",
      "สวัสดีครับ วันนี้อากาศดีมาก",
      "ສະບາຍດີ ມື້ນີ້ອາກາດດີ",
      "សួស្តី ថ្ងៃនេះអាកាសធាតុល្អ",
      "မင်္ဂလာပါ ဒီနေ့ရာသီဥတုကောင်းတယ်",
      "مرحبا بالعالم. كيف حالك؟ بخير!",
      "שלום עולם. מה שלומך? טוב!",
      "L'été, c'est aujourd'hui. Qu'est-ce que c'est ? M. Dupont arrive.",
      "¿Qué tal? ¡Bien! El Sr. García vive en EE.UU. desde 1990.",
    ];
    for (const locale of mine(input("locales"))) {
      record(`segmenter-rules/${locale}`, add => {
        for (const granularity of ["grapheme", "word", "sentence"]) {
          const s = new Intl.Segmenter(locale, { granularity });
          add(s.resolvedOptions());
          for (const text of [...samples, ...tests[granularity]]) {
            let cuts = "";
            for (const piece of s.segment(text)) cuts += piece.index + (piece.isWordLike ? "w" : "") + ",";
            add(cuts);
          }
        }
      });
    }
  },

  // ─── Intl.Locale and canonicalization ───

  locale() {
    const codes = input("codes");
    const tags = new Set(input("locales"));
    for (const l of codes.languages) tags.add(l);
    for (const s of codes.scripts) tags.add(`und-${s}`);
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) tags.add(`und-${String.fromCharCode(a, b)}`);
    for (const r of codes.regions) (tags.add(`en-${r}`), tags.add(`ar-${r}`), tags.add(`zh-${r}`), tags.add(`sr-${r}`));
    const list = mine([...tags].sort());
    for (let i = 0; i < list.length; i += 50) {
      record(`locale/${shard}/${i}`, add => {
        for (const tag of list.slice(i, i + 50)) {
          add.try(() => {
            const l = new Intl.Locale(tag);
            const info = [l.maximize().toString(), l.minimize().toString()];
            for (const m of [
              "getCalendars",
              "getCollations",
              "getHourCycles",
              "getNumberingSystems",
              "getTimeZones",
              "getTextInfo",
              "getWeekInfo",
            ]) {
              info.push(typeof l[m] === "function" ? JSON.stringify(l[m]()) : "-");
            }
            return `${tag}: ${info.join(" ")}`;
          });
        }
      });
    }
  },

  canonicalize() {
    const a = input("aliases");
    const tags = [];
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (const x of letters) for (const y of letters) tags.push(x + y);
    for (const x of letters) for (const y of letters) for (const z of letters) tags.push(x + y + z);
    for (const l of a.language) tags.push(l, `${l}-Latn`, `${l}-US`);
    for (const s of a.script) tags.push(`und-${s}`);
    for (const t of a.territory) tags.push(`und-${t}`, `ru-${t}`, `hy-${t}`, `az-${t}`, `sr-${t}`, `uz-${t}`);
    for (const v of a.variant) tags.push(`en-${v}`, `hy-${v}`, `ja-Latn-${v}`);
    for (const s of a.subdivision) tags.push(`en-u-sd-${s}`, `en-u-rg-${s}`);
    for (const [key, types] of Object.entries(a.typeMap)) {
      const bcp = a.keyMap[a.keyMap.indexOf(key) + 1] ?? key;
      for (const k of new Set([key, bcp])) {
        if (!/^[a-z0-9]{2}$/.test(k)) continue;
        for (const t of types) if (/^[a-z0-9-]{3,}$/i.test(t)) tags.push(`en-u-${k}-${String(t).toLowerCase()}`);
      }
    }
    for (const table of [a.typeAlias, a.bcpTypeAlias]) {
      for (const [key, types] of Object.entries(table)) {
        const k = key.length === 2 ? key : a.keyMap[a.keyMap.indexOf(key) + 1];
        for (const t of types)
          tags.push(`en-u-${k}-${String(t).toLowerCase().replaceAll(":", "-").replaceAll("_", "-")}`);
      }
    }
    tags.push(
      "en-t-hi-latn",
      "en-t-m0-names",
      "und-t-d0-ascii",
      "en-u-ca-islamicc",
      "en-u-tz-cnckg",
      "en-u-kn-true",
      "en-u-ks-primary",
      "art-lojban",
      "cel-gaulish",
      "zh-guoyu",
      "sgn-BE-FR",
      "no-bok",
      "en-GB-oed",
      "x-private",
      "en-x-a-b",
      "de-DE-1996-1901",
      "sl-rozaj-biske-1994",
    );
    const list = mine(tags);
    for (let i = 0; i < list.length; i += 500) {
      record(`canonicalize/${shard}/${i}`, add => {
        for (const tag of list.slice(i, i + 500)) add.try(() => `${tag}→${Intl.getCanonicalLocales(tag)[0]}`);
      });
    }
  },

  supported() {
    if (shard !== 0) return;
    record("supported/values", add => {
      for (const key of ["calendar", "collation", "currency", "numberingSystem", "timeZone", "unit"])
        add(supported(key));
    });
    const locales = input("locales");
    for (const name of [
      "Collator",
      "DateTimeFormat",
      "DisplayNames",
      "DurationFormat",
      "ListFormat",
      "NumberFormat",
      "PluralRules",
      "RelativeTimeFormat",
      "Segmenter",
    ]) {
      record(`supported/${name}`, add => {
        if (!Intl[name]) return add("none");
        for (const localeMatcher of ["lookup", "best fit"])
          add(Intl[name].supportedLocalesOf(locales, { localeMatcher }));
        for (const l of locales)
          add.try(
            () => new Intl[name](l, name === "DisplayNames" ? { type: "region" } : undefined).resolvedOptions().locale,
          );
      });
    }
    record("supported/versions", add =>
      add([process.versions.icu, process.versions.unicode, process.versions.tz, process.versions.cldr]),
    );
  },

  // ─── Strings ───

  normalize() {
    const block = 0x1000;
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`normalize/${start.toString(16)}`, add => {
        for (const form of ["NFC", "NFD", "NFKC", "NFKD"]) {
          let all = "";
          for (let c = start; c < start + block; c++) {
            if (c >= 0xd800 && c <= 0xdfff) continue;
            const s = String.fromCodePoint(c);
            all += s.normalize(form) + "," + ("a" + s + "̣́").normalize(form) + ";";
          }
          add(all);
        }
      });
    }
    if (shard === 0) {
      record("normalize/conformance", add => {
        for (const s of input("normalizationTest"))
          for (const form of ["NFC", "NFD", "NFKC", "NFKD"]) add(s.normalize(form));
      });
    }
  },

  casing() {
    const block = 0x1000;
    const locales = [undefined, "tr", "az", "lt", "el", "nl", "hy", "en", "de"];
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`casing/${start.toString(16)}`, add => {
        let plain = "";
        const perLocale = locales.map(() => "");
        for (let c = start; c < start + block; c++) {
          if (c >= 0xd800 && c <= 0xdfff) continue;
          const s = String.fromCodePoint(c);
          plain += s.toUpperCase() + s.toLowerCase() + ("a" + s + "b").toUpperCase() + ("A" + s + "Σ").toLowerCase();
          locales.forEach(
            (l, i) =>
              (perLocale[i] +=
                s.toLocaleUpperCase(l) +
                s.toLocaleLowerCase(l) +
                ("i" + s + "̇").toLocaleUpperCase(l) +
                ("I" + s + "J̀").toLocaleLowerCase(l)),
          );
        }
        add(plain);
        perLocale.forEach(add);
      });
    }
  },

  // Which characters may be in an identifier is asked of ICU by the lexer.
  identifiers() {
    const block = 0x1000;
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`identifiers/${start.toString(16)}`, add => {
        let bits = "";
        for (let c = start; c < start + block; c++) {
          if (c >= 0xd800 && c <= 0xdfff) continue;
          const s = String.fromCodePoint(c);
          let bit = 0;
          try {
            new Function(`var ${s};`);
            bit |= 1;
          } catch {}
          try {
            new Function(`var a${s};`);
            bit |= 2;
          } catch {}
          bits += bit;
        }
        add(bits);
        let space = "";
        for (let c = start; c < start + block; c++)
          if (c < 0xd800 || c > 0xdfff) space += String.fromCodePoint(c).trim().length ? 0 : 1;
        add(space);
      });
    }
  },

  idna() {
    const url = require("node:url");
    const block = 0x1000;
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`idna/${start.toString(16)}`, add => {
        let all = "";
        for (let c = start; c < start + block; c++) {
          if (c >= 0xd800 && c <= 0xdfff) continue;
          const s = String.fromCodePoint(c);
          all += url.domainToASCII(`a${s}b.example`) + "," + url.domainToASCII(`${s}.example`) + ";";
          try {
            all += new URL(`http://x${s}y.example/`).hostname;
          } catch {
            all += "!";
          }
        }
        add(all);
      });
    }
    if (shard === 0) {
      record("idna/conformance", add => {
        for (const s of input("idnaTest")) {
          if (!s.isWellFormed()) continue;
          add(url.domainToASCII(s));
          add(url.domainToUnicode(s));
          add.try(() => new URL(`https://${s}/`).host);
        }
      });
    }
  },

  // ─── Bun's own callers of ICU ───

  "bun-string-width"() {
    const block = 0x1000;
    // perCodePoint is what asks ICU: the width node:readline and util.inspect go by. The rest is Bun's own tables.
    const variants = [
      undefined,
      { ambiguousIsNarrow: false },
      { countAnsiEscapeCodes: true },
      { perCodePoint: true },
      { perCodePoint: true, ambiguousIsNarrow: false },
    ];
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`bun-string-width/${start.toString(16)}`, add => {
        for (const options of variants) {
          let widths = "";
          for (let c = start; c < start + block; c++) {
            if (c >= 0xd800 && c <= 0xdfff) continue;
            const s = String.fromCodePoint(c);
            widths += `${Bun.stringWidth(s, options)}${Bun.stringWidth("a" + s + "\ufe0f", options)}${Bun.stringWidth(s + "\u{1f3fd}", options)}${Bun.stringWidth(s + "\u200d" + s, options)}`;
          }
          add(widths);
        }
      });
    }
    if (shard === 0) {
      record("bun-string-width/sequences", add => {
        for (const s of input("emojiSequences"))
          add(
            `${Bun.stringWidth(s)} ${Bun.stringWidth(s + s)} ${Bun.stringWidth("x" + s + "y", { ambiguousIsNarrow: false })} ${Bun.stringWidth(s, { perCodePoint: true })}`,
          );
      });
    }
  },

  // The characters a group's name may have are ICU's ID_Start and ID_Continue.
  "url-pattern"() {
    if (typeof URLPattern !== "function")
      return shard === 0 ? record("url-pattern/unsupported", add => add("none")) : undefined;
    const block = 0x1000;
    for (let start = shard * block; start < 0x110000; start += shards * block) {
      record(`url-pattern/${start.toString(16)}`, add => {
        let bits = "";
        for (let c = start; c < start + block; c++) {
          if (c >= 0xd800 && c <= 0xdfff) continue;
          const s = String.fromCodePoint(c);
          let bit = 0;
          try {
            if (
              Object.keys(new URLPattern({ pathname: `/:${s}` }).exec({ pathname: "/v" })?.pathname.groups ?? {})[0] ===
              s
            )
              bit |= 1;
          } catch {}
          try {
            if (
              Object.keys(
                new URLPattern({ pathname: `/:a${s}` }).exec({ pathname: "/v" })?.pathname.groups ?? {},
              )[0] ===
              "a" + s
            )
              bit |= 2;
          } catch {}
          bits += bit;
        }
        add(bits);
      });
    }
  },

  // ─── Date, and the Intl-backed methods of the built-ins ───

  builtins() {
    for (const locale of mine(input("locales"))) {
      record(`builtins/${locale}`, add => {
        for (const d of DATES) {
          const date = new Date(d);
          add.try(() => date.toLocaleString(locale, { timeZone: "Asia/Tokyo" }));
          add.try(() => date.toLocaleDateString(locale, { timeZone: "Asia/Tokyo" }));
          add.try(() => date.toLocaleTimeString(locale, { timeZone: "Asia/Tokyo" }));
        }
        for (const v of [0, 1234.5, -1e21, 1e-7]) add.try(() => v.toLocaleString(locale));
        add.try(() => 12345678901234567890n.toLocaleString(locale));
        add.try(() => [1234.5, new Date(0), "x"].toLocaleString(locale, { timeZone: "UTC" }));
        add.try(() => new Float64Array([1234.5, 0.25]).toLocaleString(locale));
      });
    }
  },

  // The zone's name in parentheses is asked of ICU directly, not through a formatter.
  "date-to-string"() {
    for (const timeZone of mine(supported("timeZone"))) {
      record(`date-to-string/${timeZone}`, add => {
        process.env.TZ = timeZone;
        for (const t of [1705000000000, 1720000000000, 0, 200.5 * DAY, -1e12, 4102444800000]) {
          const d = new Date(t);
          add(
            `${d.toString()} | ${d.toTimeString()} | ${d.getTimezoneOffset()} | ${d.toLocaleString("en")} | ${d.getHours()}`,
          );
        }
        add(new Intl.DateTimeFormat().resolvedOptions().timeZone);
      });
    }
    process.env.TZ = "UTC";
  },

  // Bun's default locale is en-US whatever the environment says, but ICU's own comes from it, and a locale that has no
  // bundle in one of the trees falls back to that one before root.
  "default-locale"() {
    const script = `console.log(JSON.stringify([new Intl.DateTimeFormat().resolvedOptions().locale, new Intl.NumberFormat().resolvedOptions().numberingSystem, new Date(1720000000000).toString(), new Date(0).toLocaleString(), (1234567.891).toLocaleString(), ["b", "a", "ä", "z"].sort((x, y) => x.localeCompare(y)).join(""), "I\u0130i".toLocaleLowerCase(), new Intl.PluralRules().select(2), ...["agq", "kok", "xx", "en"].flatMap(l => [new Intl.DisplayNames(l, { type: "region" }).of("JP"), new Intl.DisplayNames(l, { type: "language" }).of("fr"), new Intl.NumberFormat(l, { style: "unit", unit: "meter", unitDisplay: "long" }).format(2), new Intl.NumberFormat(l, { style: "currency", currency: "JPY", currencyDisplay: "name" }).format(2), new Intl.DateTimeFormat(l, { timeZoneName: "long", timeZone: "Asia/Tokyo" }).format(0)])]))`;
    for (const locale of mine(input("locales"))) {
      record(`default-locale/${locale}`, add => {
        const posix = locale.replace(/-u-.*/, "").replaceAll("-", "_");
        for (const variable of ["LC_ALL", "LANG"]) {
          const child = Bun.spawnSync([process.execPath, "-e", script], {
            env: {
              ...process.env,
              LC_ALL: undefined,
              LANG: undefined,
              LC_MESSAGES: undefined,
              [variable]: `${posix}.UTF-8`,
              TZ: "Europe/Berlin",
            },
          });
          add(`${child.exitCode} ${child.stdout.toString().trim()}`);
        }
      });
    }
  },

  temporal() {
    if (typeof Temporal !== "object")
      return shard === 0 ? record("temporal/unsupported", add => add("none")) : undefined;
    for (const timeZone of mine(input("zones"))) {
      record(`temporal/zone/${timeZone}`, add => {
        for (let t = -3786825600000; t < 5680281600000; t += 97.3 * DAY) {
          add.try(() => Temporal.Instant.fromEpochMilliseconds(Math.round(t)).toZonedDateTimeISO(timeZone).toString());
        }
        add.try(() => {
          let z = Temporal.Instant.fromEpochMilliseconds(-3786825600000).toZonedDateTimeISO(timeZone);
          const found = [];
          for (let i = 0; i < 400 && z; i++) {
            z = z.getTimeZoneTransition("next");
            if (z) found.push(z.epochMilliseconds);
          }
          return found;
        });
      });
    }
    for (const calendar of mine(supported("calendar"))) {
      record(`temporal/calendar/${calendar}`, add => {
        for (let d = -800000; d < 800000; d += 173) {
          add.try(() => {
            const p = Temporal.PlainDate.from("1970-01-01").add({ days: d }).withCalendar(calendar);
            return `${p.era} ${p.eraYear} ${p.year} ${p.monthCode} ${p.month} ${p.day} ${p.daysInMonth} ${p.daysInYear} ${p.monthsInYear} ${p.inLeapYear} ${p.dayOfYear} ${p.weekOfYear}`;
          });
        }
      });
    }
  },
};

if (section === "--list") {
  console.log(Object.keys(sections).join("\n"));
} else {
  sections[section]();
  flush();
}
