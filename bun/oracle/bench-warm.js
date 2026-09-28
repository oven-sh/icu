// Nanoseconds per call of what ICU is behind, once everything has been used before.
//
//   taskset -c <core> <bun> bench-warm.js en,de,ja,zh,ar,hi,th
//
// Prints "<locale>\t<what>\t<ns>": the fastest of many batches, since what else the machine is doing can only slow one
// down. To compare builds, let them take turns a few times and keep the fastest of each.
// Most of these allocate, and one build against itself differs by 10% and more in some: see --call below.

const date = new Date(Date.UTC(2024, 2, 5, 14, 7, 9, 123));
const later = new Date(Date.UTC(2024, 4, 17, 3, 30));
const texts = {
  en: "The quick brown fox jumps over the lazy dog. It didn't mind, e.g. at 3 p.m.",
  de: "Falsches Üben von Xylophonmusik quält jeden größeren Zwerg. Z. B. um 15 Uhr.",
  ja: "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
  zh: "我们在北京学习中文。今天天气很好，我们去公园散步吧。",
  ar: "الخط العربي فن وتصميم الكتابة في مختلف اللغات التي تستعمل الحروف العربية.",
  hi: "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता प्राप्त है।",
  th: "มนุษย์ทั้งหลายเกิดมามีอิสระและเสมอภาคกันในเกียรติศักดิ์และสิทธิ",
};

/** What is made once, and then what is timed. */
const cases = locale => {
  const text = texts[locale.split("-")[0]] ?? texts.en;
  const made = {};
  const once = (key, make) => (made[key] ??= make());
  const dtf = options => once("dtf" + JSON.stringify(options), () => new Intl.DateTimeFormat(locale, options));
  const nf = options => once("nf" + JSON.stringify(options), () => new Intl.NumberFormat(locale, options));
  const names = type => once("dn" + type, () => new Intl.DisplayNames(locale, { type }));
  const segmenter = granularity => once("seg" + granularity, () => new Intl.Segmenter(locale, { granularity }));
  return {
    // Using what has been made.
    "DateTimeFormat.format": () => dtf({}).format(date),
    "DateTimeFormat.format full": () => dtf({ dateStyle: "full", timeStyle: "full", timeZone: "Europe/Berlin" }).format(date),
    "DateTimeFormat.format zone long": () => dtf({ timeZoneName: "long", timeZone: "Asia/Tokyo" }).format(date),
    "DateTimeFormat.format zone generic": () => dtf({ timeZoneName: "longGeneric", timeZone: "America/Chicago" }).format(date),
    "DateTimeFormat.format japanese": () => dtf({ calendar: "japanese", dateStyle: "long" }).format(date),
    "DateTimeFormat.format islamic": () => dtf({ calendar: "islamic-umalqura", dateStyle: "long" }).format(date),
    "DateTimeFormat.format chinese": () => dtf({ calendar: "chinese", dateStyle: "long" }).format(date),
    "DateTimeFormat.formatToParts": () => dtf({ dateStyle: "medium", timeStyle: "short" }).formatToParts(date),
    "DateTimeFormat.formatRange": () => dtf({ dateStyle: "medium" }).formatRange(date, later),
    "DateTimeFormat.resolvedOptions": () => dtf({}).resolvedOptions(),
    "NumberFormat.format": () => nf({}).format(1234567.891),
    "NumberFormat.format currency": () => nf({ style: "currency", currency: "EUR" }).format(-1234.5),
    "NumberFormat.format currency name": () => nf({ style: "currency", currency: "JPY", currencyDisplay: "name" }).format(3),
    "NumberFormat.format unit": () => nf({ style: "unit", unit: "kilometer-per-hour", unitDisplay: "long" }).format(88),
    "NumberFormat.format compact": () => nf({ notation: "compact", compactDisplay: "long" }).format(1234567),
    "NumberFormat.format percent": () => nf({ style: "percent", maximumFractionDigits: 1 }).format(0.1234),
    "NumberFormat.format BigInt": () => nf({}).format(123456789012345678901234567890n),
    "NumberFormat.formatToParts": () => nf({ style: "currency", currency: "USD" }).formatToParts(1234.5),
    "NumberFormat.formatRange": () => nf({ style: "unit", unit: "meter" }).formatRange(3, 5),
    "PluralRules.select": () => once("pr", () => new Intl.PluralRules(locale)).select(21),
    "PluralRules.select ordinal": () => once("pro", () => new Intl.PluralRules(locale, { type: "ordinal" })).select(3),
    "RelativeTimeFormat.format": () => once("rtf", () => new Intl.RelativeTimeFormat(locale)).format(-3, "day"),
    "RelativeTimeFormat.format auto": () => once("rtfa", () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" })).format(-1, "day"),
    "ListFormat.format": () => once("lf", () => new Intl.ListFormat(locale)).format(["a", "b", "c", "d"]),
    "DurationFormat.format": () => once("df", () => new Intl.DurationFormat(locale, { style: "long" })).format({ hours: 1, minutes: 46, seconds: 40 }),
    "DisplayNames.of region": () => names("region").of("JP"),
    "DisplayNames.of language": () => names("language").of("pt-BR"),
    "DisplayNames.of script": () => names("script").of("Cyrl"),
    "DisplayNames.of currency": () => names("currency").of("CHF"),
    "DisplayNames.of calendar": () => names("calendar").of("buddhist"),
    "DisplayNames.of dateTimeField": () => names("dateTimeField").of("weekOfYear"),
    "Segmenter grapheme": () => [...segmenter("grapheme").segment(text)].length,
    "Segmenter word": () => [...segmenter("word").segment(text)].length,
    "Segmenter sentence": () => [...segmenter("sentence").segment(text)].length,
    "Collator.compare": () => once("co", () => new Intl.Collator(locale)).compare(text, text + "a"),
    "Collator.compare numeric": () => once("con", () => new Intl.Collator(locale, { numeric: true })).compare("a10b" + text, "a9b" + text),
    "Collator.compare base": () => once("cob", () => new Intl.Collator(locale, { sensitivity: "base" })).compare(text, text.toUpperCase()),
    // Making it, and using it once.
    "new DateTimeFormat": () => new Intl.DateTimeFormat(locale).format(date),
    "new DateTimeFormat skeleton": () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", weekday: "long", hour: "numeric" }).format(date),
    "new DateTimeFormat zone": () => new Intl.DateTimeFormat(locale, { timeZone: "Australia/Sydney", timeZoneName: "short" }).format(date),
    "new NumberFormat": () => new Intl.NumberFormat(locale).format(1234.5),
    "new NumberFormat unit": () => new Intl.NumberFormat(locale, { style: "unit", unit: "liter", unitDisplay: "long" }).format(2),
    "new PluralRules": () => new Intl.PluralRules(locale).select(2),
    "new RelativeTimeFormat": () => new Intl.RelativeTimeFormat(locale).format(2, "month"),
    "new ListFormat": () => new Intl.ListFormat(locale, { type: "disjunction" }).format(["a", "b"]),
    "new DurationFormat": () => new Intl.DurationFormat(locale).format({ minutes: 5 }),
    "new DisplayNames": () => new Intl.DisplayNames(locale, { type: "region" }).of("BR"),
    "new Collator": () => new Intl.Collator(locale).compare("a", "b"),
    "new Segmenter": () => [...new Intl.Segmenter(locale, { granularity: "word" }).segment("a b")].length,
    "new Locale": () => new Intl.Locale(locale).toString(),
    "Locale.maximize": () => new Intl.Locale(locale).maximize().toString(),
    "Locale.minimize": () => new Intl.Locale(locale + "-Latn-US").minimize().toString(),
    "Locale.getCalendars": () => new Intl.Locale(locale).getCalendars(),
    "Locale.getCollations": () => new Intl.Locale(locale).getCollations(),
    "Locale.getHourCycles": () => new Intl.Locale(locale).getHourCycles(),
    "Locale.getNumberingSystems": () => new Intl.Locale(locale).getNumberingSystems(),
    "Locale.getTimeZones": () => new Intl.Locale(locale + "-US").getTimeZones(),
    "Locale.getWeekInfo": () => new Intl.Locale(locale).getWeekInfo(),
    "Locale.getTextInfo": () => new Intl.Locale(locale).getTextInfo(),
    "getCanonicalLocales": () => Intl.getCanonicalLocales([locale, "zh-hant-tw", "en-latn-us-u-ca-gregory"]),
    "supportedLocalesOf": () => Intl.NumberFormat.supportedLocalesOf([locale, "xx", "pt-PT"]),
    "supportedValuesOf timeZone": () => Intl.supportedValuesOf("timeZone").length,
    "supportedValuesOf currency": () => Intl.supportedValuesOf("currency").length,
    "supportedValuesOf calendar": () => Intl.supportedValuesOf("calendar").length,
    // Without Intl in the name.
    "Date.toLocaleString": () => date.toLocaleString(locale),
    "Date.toLocaleDateString options": () => date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" }),
    "Date.toLocaleTimeString": () => date.toLocaleTimeString(locale),
    "Date.toString": () => date.toString(),
    "Date local fields": () => new Date(2024, 5, 1, 12).getTimezoneOffset(),
    "Number.toLocaleString": () => (9876.54).toLocaleString(locale),
    "BigInt.toLocaleString": () => 98765432109876543210n.toLocaleString(locale),
    "String.localeCompare": () => text.localeCompare(text + "b", locale),
    "String.toLocaleUpperCase": () => text.toLocaleUpperCase(locale),
    "String.toLocaleLowerCase": () => text.toLocaleLowerCase(locale),
    "String.normalize NFC": () => text.normalize("NFC"),
    "String.normalize NFD": () => text.normalize("NFD"),
    "String.normalize NFKC": () => text.normalize("NFKC"),
    "String.normalize NFKD": () => text.normalize("NFKD"),
    "Array.toLocaleString": () => [1234.5, date].toLocaleString(locale),
    "Temporal.ZonedDateTime": () => new Temporal.ZonedDateTime(1709647629123000000n, "America/Sao_Paulo").hour,
    "Temporal.PlainDate calendar": () => new Temporal.PlainDate(2024, 3, 5, "hebrew").month,
    "Temporal.PlainDateTime.toLocaleString": () => new Temporal.PlainDateTime(2024, 3, 5, 14, 7).toLocaleString(locale),
    "Temporal.Instant.toLocaleString": () => Temporal.Instant.fromEpochMilliseconds(1709647629123).toLocaleString(locale),
    "URL IDNA": () => new URL("https://bücher.例え.テスト/").hostname,
    "Bun.stringWidth": () => Bun.stringWidth(text + "👩‍👩‍👧‍👦🇯🇵"),
    "RegExp property": () => /\p{Script=Han}+|\p{Lu}\p{Ll}+/u.test(text),
    "RegExp ignoreCase unicode": () => /ÜBEN|猫|الكتابة/iu.test(text),
  };
};

let sink = 0;
if (process.argv[3] === "--call") {
  // For counting instructions, which what else the machine is doing does not change: `<locale> --call <what> <n>`,
  // under perf stat, with two values of n. What the process does besides is the same for both.
  const call = cases(process.argv[2])[process.argv[4]];
  for (let i = Number(process.argv[5]); i > 0; i--) sink += call() ? 1 : 0;
  process.exit(sink < 0 ? 1 : 0);
}
for (const locale of process.argv[2].split(",")) {
  for (const [what, call] of Object.entries(cases(locale))) {
    try {
      call();
    } catch (error) {
      console.log(`${locale}\t${what}\t${error.constructor.name}`);
      continue;
    }
    // About a millisecond a batch.
    let n = 1;
    for (;;) {
      const start = performance.now();
      for (let i = 0; i < n; i++) sink += call() ? 1 : 0;
      if (performance.now() - start > 0.5) break;
      n *= 2;
    }
    let best = Infinity;
    for (let batch = 0; batch < 40; batch++) {
      const start = performance.now();
      for (let i = 0; i < n; i++) sink += call() ? 1 : 0;
      best = Math.min(best, (performance.now() - start) / n);
    }
    console.log(`${locale}\t${what}\t${(best * 1e6).toFixed(1)}`);
  }
}
if (sink < 0) console.log(sink);
