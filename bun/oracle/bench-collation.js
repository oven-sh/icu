// Nanoseconds per Intl.Collator comparison, of text in a dozen scripts.
//
//   taskset -c <core> <bun> bench-collation.js en,de,zh,ja,ko,th
//
// Prints "<locale>\t<text>\t<ns>": the fastest of many batches, since what else the machine is doing can only slow one
// down. To compare builds, let them take turns a few times and keep the fastest of each.

let seed = 12345;
const random = n => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
/** 4000 strings of 2 to `length` + 1 characters out of `ranges`. */
const words = (ranges, length, prefix = "") =>
  Array.from({ length: 4000 }, () => {
    const characters = Array.from({ length: 2 + random(length) }, () => {
      const [first, last] = ranges[random(ranges.length)];
      return String.fromCodePoint(first + random(last - first + 1));
    });
    return prefix + characters.join("");
  });

const lowercase = [0x61, 0x7a];
const han = [0x4e00, 0x9fa5];
const cyrillic = [0x430, 0x44f];
const texts = {
  "ASCII": words([lowercase], 8),
  "Latin-1 accents": words([lowercase, [0xe0, 0xfc]], 8),
  "Latin ext (Vietnamese)": words([lowercase, [0x1ea0, 0x1ef9]], 8),
  "Cyrillic": words([cyrillic], 8),
  "Greek": words([[0x3b1, 0x3c9]], 8),
  "Arabic": words([[0x627, 0x64a]], 8),
  "Devanagari": words([[0x905, 0x939]], 8),
  "Thai": words([[0xe01, 0xe2e]], 8),
  "Han": words([han], 4),
  "Hangul": words([[0xac00, 0xd7a3]], 4),
  "Kana": words(
    [
      [0x3041, 0x3096],
      [0x30a1, 0x30fa],
    ],
    6,
  ),
  "Emoji / supplementary": words(
    [
      [0x1f600, 0x1f64f],
      [0x20000, 0x2a6d6],
    ],
    4,
  ),
  "shared prefix, Han": words([han], 3, "中文字符串"),
  "shared prefix, Cyrillic": words([cyrillic], 3, "приветмир"),
};

let sink = 0;
for (const locale of process.argv[2].split(",")) {
  const { compare } = new Intl.Collator(locale);
  for (const [name, text] of Object.entries(texts)) {
    let fastest = Infinity;
    for (let batch = 0; batch < 60; batch++) {
      const start = performance.now();
      for (let i = 0; i + 1 < text.length; i++) sink += compare(text[i], text[i + 1]);
      fastest = Math.min(fastest, ((performance.now() - start) * 1e6) / (text.length - 1));
    }
    console.log(`${locale}\t${name}\t${fastest.toFixed(1)}`);
  }
}
if (Number.isNaN(sink)) throw new Error();
