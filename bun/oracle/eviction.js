// One process that uses every locale, so that ICU's cache of shared objects fills up and evicts.
// What it evicts may refer to other things in the cache. Prints a hash of all that was formatted.
// usage: <bun> eviction.js <locale>...
const locales = process.argv.slice(2).filter(locale => {
  try {
    return Intl.NumberFormat.supportedLocalesOf(locale).length === 1;
  } catch {
    return false;
  }
});
let hash = 0n;
let used = 0;
const add = s => {
  for (let i = 0; i < s.length; i++) hash = ((hash ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
};
for (let round = 0; round < 2; round++) {
  for (const locale of locales) {
    // ICU's own shared number format is what formats these. It works out how to format for good with the third number.
    const relative = new Intl.RelativeTimeFormat(locale);
    for (let i = 1; i <= 5; i++) add(relative.format(-i * 1000, "day"));
    const number = new Intl.NumberFormat(locale);
    for (let i = 1; i <= 5; i++) add(number.format(i * 1234.5));
    add(new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long", timeZone: "UTC" }).format(0));
    add(new Intl.PluralRules(locale).select(round));
    add(new Intl.ListFormat(locale).format(["a", "b", "c"]));
    // ICU evicts only what nothing uses, and these objects use it until they are collected.
    if (++used % 20 === 0) Bun.gc(true);
  }
}
console.log(locales.length, "locales", hash.toString(16));
