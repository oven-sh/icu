// How every supplementary code point and every unpaired surrogate sorts, under many collators. Prints a hash for each
// collator, to compare between two builds of Bun.
//
//   <bun> surrogates.js
//
// Collation looks up UTF-16 code units, and a lead surrogate is where a code unit is not a code point: ICU's data has a
// value for each. oracle.js has supplementary characters among what it sorts, but not all of them.

const locales = [
  ...["en", "und", "de", "de-u-co-phonebk", "sv", "cs", "es-u-co-trad", "fr-CA", "fi", "da", "tr", "lt", "hu", "vi"],
  ...["zh", "zh-u-co-stroke", "zh-u-co-zhuyin", "zh-u-co-unihan", "ja", "ko", "ko-u-co-search"],
  ...["th", "ar", "hi", "ru", "my", "km", "si", "ff-Adlm"],
  ...["und-u-co-emoji", "und-u-co-eor", "und-u-co-search", "en-u-kn", "en-u-ks-level1", "en-u-ka-shifted"],
];
const pivots = ["a", "一", "가", "\u{20000}", "\u{1F600}", "￿", "\u{10FFFF}", "\ud800", "\udc00"];

const inputs = [];
for (let c = 0x10000; c <= 0x10ffff; c++) inputs.push(String.fromCodePoint(c));
for (let unit = 0xd800; unit <= 0xdfff; unit++) {
  const s = String.fromCharCode(unit);
  inputs.push(s, "a" + s, s + "a", s + "́", s + s);
}
// A trail surrogate and then a lead surrogate.
for (let trail = 0xdc00; trail <= 0xdfff; trail += 3) inputs.push(String.fromCharCode(trail, 0xd800 + (trail & 0x3ff)));

let comparisons = 0;
for (const locale of locales) {
  const collator = new Intl.Collator(locale);
  let hash = 2166136261;
  const mix = order => (hash = Math.imul(hash ^ (order + 2), 16777619));
  for (const s of inputs) {
    for (const pivot of pivots) {
      mix(collator.compare(s, pivot));
      mix(collator.compare(pivot + s, s + pivot));
      comparisons += 2;
    }
  }
  const { locale: resolved, collation } = collator.resolvedOptions();
  console.log(locale, resolved, collation, (hash >>> 0).toString(16));
}
console.log(comparisons, "comparisons");
