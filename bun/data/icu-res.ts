/**
 * Rewrites the resource bundles of one ICU data tree (all locales of `zone/`, of `curr/`, …, and whatever other
 * bundles are next to them) from the format genrb writes, formatVersion 3, into formatVersion 4, which only
 * this ICU reads. `icu4c/source/common/uresdata.h` has the specification; this is the only writer.
 *
 * What version 3 spends its bytes on, and what version 4 does about each:
 *
 * - The locales of a tree have the same tables with the same keys, and every table repeats its key offsets.
 *   Here a table names a keyset that the tree has once, or a master keyset and a bit for each of its keys.
 * - Every string has an offset stored for it that says no more than where the string before it ended.
 *   Here the strings of a table follow each other, and every 8th has an offset.
 * - Text is UTF-16, though a language seldom uses more than a hundred characters, and says the same words
 *   over and over: "Central European Standard Time", "Central European Summer Time".
 *   Here a bundle's text is a byte per character, or one or two per phrase that its language has a use for.
 *   The runtime writes a string out in UTF-16 when it is first asked for.
 * - Every bundle is an item of the package: a name, a header, indexes, padding, more than a hundred bytes for each
 *   of thousands. Here the tree is one item, in place of its pool bundle.
 *
 * Nothing is left out or approximated: `compactTree` reads back what it wrote and compares.
 */

// ─── What a bundle says ───

export type Node =
  /** `pool`: the offset of the string in the version 3 pool bundle, for a string that is there. */
  | { is: "string"; text: string; pool?: number }
  | { is: "alias"; text: string }
  /** 28 bits, as stored. */
  | { is: "int"; value: number }
  | { is: "intvector"; values: number[] }
  | { is: "table"; keys: string[]; items: Node[] }
  | { is: "array"; items: Node[] };

type StringNode = Extract<Node, { is: "string" }>;
type Table = Extract<Node, { is: "table" }>;
type ArrayNode = Extract<Node, { is: "array" }>;

interface Bundle {
  name: string;
  noFallback: boolean;
  root: Node;
}

/** Resource types, as in uresdata.h. */
const Type = {
  String: 0,
  Binary: 1,
  Table: 2,
  Alias: 3,
  Table32: 4,
  Table16: 5,
  StringV2: 6,
  Int: 7,
  Array: 8,
  Array16: 9,
  TableCompact: 10,
  ArrayCompact: 11,
  /** In a keyset only: a TableCompact or ArrayCompact that is stored where the table has its items. */
  TableInline: 12,
  ArrayInline: 13,
  IntVector: 14,
} as const;

const resource = (type: number, offset: number) => ((type << 28) | offset) >>> 0;

// ─── Reading version 3 ───

const ATT_NO_FALLBACK = 1;
/** Bits 3..2 of a bundle's attributes: how far a field that is an offset in the compact area is shifted. */
const ATT_SHIFT = 2;
const ATT_IS_POOL = 2;

interface Pool3 {
  bytes: Buffer;
  header: Buffer;
  keys: number;
  strings: number;
}

function stringV2(bytes: Buffer, at: number): string {
  const first = bytes.readUInt16LE(at);
  let length = 0;
  let prefix = 0;
  if ((first & 0xfc00) !== 0xdc00) while (bytes.readUInt16LE(at + length * 2) !== 0) length++;
  else if (first < 0xdfef) [length, prefix] = [first & 0x3ff, 1];
  else if (first < 0xdfff) [length, prefix] = [((first - 0xdfef) << 16) | bytes.readUInt16LE(at + 2), 2];
  else [length, prefix] = [(bytes.readUInt16LE(at + 2) << 16) | bytes.readUInt16LE(at + 4), 3];
  return bytes.toString("utf16le", at + prefix * 2, at + (prefix + length) * 2);
}

const cString = (bytes: Buffer, at: number) => bytes.toString("latin1", at, bytes.indexOf(0, at));

function readPool3(bytes: Buffer): Pool3 {
  const root = bytes.readUInt16LE(0);
  const indexLength = bytes.readInt32LE(root + 4) & 0xff;
  if (bytes[16] !== 3 || !(bytes.readInt32LE(root + 4 + 5 * 4) & ATT_IS_POOL)) throw new Error("not a version 3 pool");
  return {
    bytes,
    header: bytes.subarray(0, root),
    keys: root + (1 + indexLength) * 4,
    strings: root + bytes.readInt32LE(root + 8) * 4,
  };
}

/**
 * Whether the bundle is one this module rewrites: any, whether it uses the pool bundle or not,
 * but one with binary data, which whoever reads it may expect at a multiple of 16 bytes.
 */
export function canCompact(bytes: Buffer): boolean {
  const root = bytes.readUInt16LE(0);
  const all = (n: number, first: number) => Array.from({ length: n }, (_, i) => bytes.readUInt32LE(first + i * 4)).every(walk);
  const walk = (res: number): boolean => {
    const at = root + (res & 0xfffffff) * 4;
    if (at === root) return true;
    switch (res >>> 28) {
      case Type.Binary:
        return false;
      case Type.Table:
        return all(bytes.readUInt16LE(at), at + ((2 + bytes.readUInt16LE(at) * 2 + 3) & ~3));
      case Type.Table32:
        return all(bytes.readInt32LE(at), at + 4 + bytes.readInt32LE(at) * 4);
      case Type.Array:
        return all(bytes.readInt32LE(at), at + 4);
    }
    return true;
  };
  return walk(bytes.readUInt32LE(root));
}

function readBundle3(name: string, bytes: Buffer, pool: Pool3): Bundle {
  // genrb writes version 2 for a bundle that has no use for what 3 added, whose fields are then 0.
  if (bytes[16] !== 2 && bytes[16] !== 3) throw new Error(`${name}: formatVersion ${bytes[16]}`);
  const root = bytes.readUInt16LE(0);
  const index = (i: number) => bytes.readInt32LE(root + 4 + i * 4);
  const indexLength = index(0) & 0xff;
  const attributes = index(5);
  const keysTop = index(1);
  const poolLimit = ((index(0) >>> 8) & 0xffffff) | ((attributes & 0xf000) << 12);
  const poolLimit16 = attributes >>> 16;
  const units = root + keysTop * 4;
  // Undocumented: 0, not the end of the indexes, in a bundle without keys of its own.
  const localKeyLimit = keysTop > 1 + indexLength ? keysTop * 4 : 0;

  const key16 = (k: number) =>
    k < localKeyLimit ? cString(bytes, root + k) : cString(pool.bytes, pool.keys + k - localKeyLimit);
  const key32 = (k: number) => (k >= 0 ? cString(bytes, root + k) : cString(pool.bytes, pool.keys + (k & 0x7fffffff)));
  const string = (offset: number): Node =>
    offset < poolLimit
      ? { is: "string", text: stringV2(pool.bytes, pool.strings + offset * 2), pool: offset }
      : { is: "string", text: stringV2(bytes, units + (offset - poolLimit) * 2) };
  const string16 = (r: number) => string(r < poolLimit16 ? r : r - poolLimit16 + poolLimit);
  const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

  const walk = (res: number): Node => {
    const type = res >>> 28;
    const offset = res & 0xfffffff;
    const at = root + offset * 4;
    const at16 = units + offset * 2;
    switch (type) {
      case Type.StringV2:
        return string(offset);
      case Type.String:
        // How genrb writes the empty string. With an offset, a string as in version 1.
        return {
          is: "string",
          text: offset ? bytes.toString("utf16le", at + 4, at + 4 + bytes.readInt32LE(at) * 2) : "",
        };
      case Type.Int:
        return { is: "int", value: offset };
      case Type.Alias:
        return {
          is: "alias",
          text: offset ? bytes.toString("utf16le", at + 4, at + 4 + bytes.readInt32LE(at) * 2) : "",
        };
      case Type.IntVector:
        return {
          is: "intvector",
          values: offset ? times(bytes.readInt32LE(at), i => bytes.readInt32LE(at + 4 + i * 4)) : [],
        };
      case Type.Table: {
        const n = offset ? bytes.readUInt16LE(at) : 0;
        const items = at + ((2 + n * 2 + 3) & ~3);
        return {
          is: "table",
          keys: times(n, i => key16(bytes.readUInt16LE(at + 2 + i * 2))),
          items: times(n, i => walk(bytes.readUInt32LE(items + i * 4))),
        };
      }
      case Type.Table32: {
        const n = offset ? bytes.readInt32LE(at) : 0;
        return {
          is: "table",
          keys: times(n, i => key32(bytes.readInt32LE(at + 4 + i * 4))),
          items: times(n, i => walk(bytes.readUInt32LE(at + 4 + n * 4 + i * 4))),
        };
      }
      case Type.Table16: {
        const n = bytes.readUInt16LE(at16);
        return {
          is: "table",
          keys: times(n, i => key16(bytes.readUInt16LE(at16 + 2 + i * 2))),
          items: times(n, i => string16(bytes.readUInt16LE(at16 + 2 + n * 2 + i * 2))),
        };
      }
      case Type.Array:
        return {
          is: "array",
          items: offset ? times(bytes.readInt32LE(at), i => walk(bytes.readUInt32LE(at + 4 + i * 4))) : [],
        };
      case Type.Array16:
        return {
          is: "array",
          items: times(bytes.readUInt16LE(at16), i => string16(bytes.readUInt16LE(at16 + 2 + i * 2))),
        };
    }
    // Binaries do not occur in the trees that have a pool.
    throw new Error(`${name}: resource type ${type}`);
  };
  return { name, noFallback: (attributes & ATT_NO_FALLBACK) !== 0, root: walk(bytes.readUInt32LE(root)) };
}

// ─── Text ───

const ESCAPE = 0xff;
/** A language with fewer units of text than this shares a grammar with others, which together have at most so many letters. */
const OWN_GRAMMAR = 4000;
const SHARED_LETTERS = 160;
/** The cells that can stand for something: not 0, which ends a string, and not ESCAPE. */
const CODES = 0xfe;
/** Rules that one lead cell is for: the cell after it is not 0 either. */
const PER_LEAD = 0xff;
/** Bytes that a rule takes besides its body: an offset. */
const RULE_OVERHEAD = 2;

/**
 * What the cells of text stand for, in the bundles of a language or of a few:
 * - cells 1.. for one of the first `singleLetters` letters each;
 * - the next cells for one of the first `singleRules` rules each, a phrase;
 * - the cells after those, up to 0xfe, lead one more cell, and the two stand for one of the other letters or rules.
 * A rule's phrase is itself stored in cells, which may stand for shorter phrases.
 */
interface Grammar {
  letters: number[];
  singleLetters: number;
  rules: string[];
  singleRules: number;
}

/**
 * Phrases that occur over and over in `strings`, by Re-Pair (Larsson and Moffat): the pair of symbols that is
 * most frequent becomes a symbol, until none occurs twice. In time linear in the text.
 * @param isLetter units that are not letters are in no phrase
 * @returns each phrase and how often it, as a symbol, is left in the text or in another phrase
 */
function findPhrases(strings: string[], isLetter: (unit: number) => boolean): Map<string, number> {
  let n = 0;
  for (const s of strings) n += s.length + 1;
  // Symbols: 0 where no pair can be, a unit plus 1, or FIRST_RULE plus the number of a rule.
  const FIRST_RULE = 0x10001;
  const symbol = new Int32Array(n);
  let at = 0;
  for (const s of strings) {
    for (let i = 0; i < s.length; i++) symbol[at++] = isLetter(s.charCodeAt(i)) ? s.charCodeAt(i) + 1 : 0;
    at++;
  }
  // The symbols that are left are a linked list, and so are the places where a pair occurs, by that of its first symbol.
  const next = Int32Array.from({ length: n }, (_, i) => i + 1);
  const previous = Int32Array.from({ length: n }, (_, i) => i - 1);
  const nextPlace = new Int32Array(n).fill(-1);
  const previousPlace = new Int32Array(n).fill(-1);
  interface Pair {
    a: number;
    b: number;
    count: number;
    first: number;
  }
  const pairs = new Map<number, Pair>();
  const key = (a: number, b: number) => a * 0x200000 + b;
  const byCount: Set<Pair>[] = [];
  const withCount = (count: number) => (byCount[count] ??= new Set());
  const pairAt = (i: number) => {
    const j = next[i]!;
    return j < n && symbol[i] && symbol[j] ? pairs.get(key(symbol[i]!, symbol[j]!)) : undefined;
  };
  const isListed = (i: number, pair: Pair) => pair.first === i || previousPlace[i] !== -1;
  const list = (i: number) => {
    const j = next[i]!;
    if (j >= n || !symbol[i] || !symbol[j]) return;
    const [a, b] = [symbol[i]!, symbol[j]!];
    let pair = pairs.get(key(a, b));
    if (pair) withCount(pair.count).delete(pair);
    else pairs.set(key(a, b), (pair = { a, b, count: 0, first: -1 }));
    nextPlace[i] = pair.first;
    if (pair.first >= 0) previousPlace[pair.first] = i;
    pair.first = i;
    withCount(++pair.count).add(pair);
  };
  const unlist = (i: number) => {
    const pair = pairAt(i);
    if (!pair || !isListed(i, pair)) return;
    withCount(pair.count).delete(pair);
    if (previousPlace[i]! >= 0) nextPlace[previousPlace[i]!] = nextPlace[i]!;
    else pair.first = nextPlace[i]!;
    if (nextPlace[i]! >= 0) previousPlace[nextPlace[i]!] = previousPlace[i]!;
    nextPlace[i] = previousPlace[i] = -1;
    if (--pair.count) withCount(pair.count).add(pair);
    else pairs.delete(key(pair.a, pair.b));
  };
  for (let i = 0; i + 1 < n; i++) {
    // Of aaa, only the first aa.
    const before = i > 0 && symbol[i - 1] === symbol[i] && symbol[i] === symbol[i + 1] ? pairAt(i - 1) : undefined;
    if (!before || !isListed(i - 1, before)) list(i);
  }

  const rules: [number, number][] = [];
  for (let count = byCount.length - 1; count >= 2; ) {
    const pair: Pair | undefined = byCount[count]?.values().next().value;
    if (!pair) {
      count--;
      continue;
    }
    const rule = FIRST_RULE + rules.push([pair.a, pair.b]) - 1;
    const places: number[] = [];
    for (let i = pair.first; i >= 0; i = nextPlace[i]!) places.push(i);
    withCount(pair.count).delete(pair);
    pairs.delete(key(pair.a, pair.b));
    for (const i of places) nextPlace[i] = previousPlace[i] = -1;
    for (const i of places.sort((x, y) => x - y)) {
      const j = next[i]!;
      // Unless one that overlaps has taken it.
      if (symbol[i] !== pair.a || j >= n || symbol[j] !== pair.b) continue;
      const [before, after] = [previous[i]!, next[j]!];
      if (before >= 0) unlist(before);
      if (after < n) unlist(j);
      symbol[i] = rule;
      symbol[j] = 0;
      next[i] = after;
      if (after < n) previous[after] = i;
      if (before >= 0) list(before);
      if (after < n) list(i);
    }
    count = byCount.length - 1;
  }

  const phrases: string[] = [];
  const text = (x: number) => (x < FIRST_RULE ? String.fromCharCode(x - 1) : phrases[x - FIRST_RULE]!);
  const uses = new Array<number>(rules.length).fill(0);
  const use = (x: number) => x >= FIRST_RULE && uses[x - FIRST_RULE]!++;
  for (const [a, b] of rules) {
    phrases.push(text(a) + text(b));
    use(a);
    use(b);
  }
  for (let i = 0; i < n; i = next[i]!) use(symbol[i]!);
  return new Map(phrases.map((phrase, i) => [phrase, uses[i]!]));
}

/** Writes strings in the cells of a grammar, in as few as can be. */
class Coder {
  readonly grammar: Grammar;
  /** By unit. */
  private readonly letter = new Map<number, number[]>();
  /** The rules by their phrases, a unit at a time. */
  private readonly trie: Trie = { next: new Map() };
  /** How often encode() has used each rule, and each letter by its unit. */
  readonly uses: number[];
  readonly letterUses = new Map<number, number>();

  constructor(grammar: Grammar) {
    this.grammar = grammar;
    grammar.letters.forEach((unit, i) =>
      this.letter.set(unit, i < grammar.singleLetters ? [1 + i] : this.two(i - grammar.singleLetters)),
    );
    grammar.rules.forEach((phrase, rule) => {
      let node = this.trie;
      for (let i = 0; i < phrase.length; i++) {
        let child = node.next.get(phrase.charCodeAt(i));
        if (!child) node.next.set(phrase.charCodeAt(i), (child = { next: new Map() }));
        node = child;
      }
      node.rule = rule;
    });
    this.uses = new Array<number>(grammar.rules.length).fill(0);
  }

  /** The two cells for the i-th of what has no cell of its own: the other letters, then the other rules. */
  private two(i: number): number[] {
    return [1 + this.grammar.singleLetters + this.grammar.singleRules + Math.floor(i / PER_LEAD), 1 + (i % PER_LEAD)];
  }

  private cellsOf(rule: number): number[] {
    const { letters, singleLetters, singleRules } = this.grammar;
    return rule < singleRules
      ? [1 + singleLetters + rule]
      : this.two(letters.length - singleLetters + rule - singleRules);
  }

  /** @param isPhrase `s` is the phrase of a rule, whose cells stand for shorter ones */
  encode(s: string, isPhrase = false): number[] {
    const n = s.length;
    /** The fewest cells for the units from i on, and the rule that the first of them stand for, if any. */
    const fewest = new Array<number>(n + 1).fill(0);
    const rules = new Array<number>(n).fill(-1);
    for (let i = n - 1; i >= 0; i--) {
      fewest[i] = fewest[i + 1]! + (this.letter.get(s.charCodeAt(i))?.length ?? 4);
      let node: Trie | undefined = this.trie;
      for (let j = i; j < n && (node = node.next.get(s.charCodeAt(j))); j++) {
        if (node.rule === undefined || (isPhrase && j - i + 1 === n)) continue;
        const cells = fewest[j + 1]! + (node.rule < this.grammar.singleRules ? 1 : 2);
        if (cells < fewest[i]!) [fewest[i], rules[i]] = [cells, node.rule];
      }
    }
    const cells: number[] = [];
    for (let i = 0; i < n; ) {
      const [unit, rule] = [s.charCodeAt(i), rules[i]!];
      if (rule >= 0) {
        cells.push(...this.cellsOf(rule));
        this.uses[rule]!++;
        i += this.grammar.rules[rule]!.length;
        continue;
      }
      cells.push(
        ...(this.letter.get(unit) ?? [ESCAPE, 0x80 | (unit & 0x7f), 0x80 | ((unit >> 7) & 0x7f), 0x80 | (unit >> 14)]),
      );
      this.letterUses.set(unit, (this.letterUses.get(unit) ?? 0) + 1);
      i++;
    }
    return cells;
  }
}

interface Trie {
  next: Map<number, Trie>;
  rule?: number;
}

/** How many of `n` letters and rules can have a cell of their own, when the others need a lead cell for every PER_LEAD. */
function singlesOf(n: number): number {
  let singles = Math.min(n, CODES);
  while (singles + Math.ceil((n - singles) / PER_LEAD) > CODES) singles--;
  if (singles < 0) throw new Error("more letters and rules than two cells can number");
  return singles;
}

/**
 * The grammar that makes `strings` and itself smallest, more or less.
 * @param strings each as often as it will be stored
 */
function makeGrammar(strings: string[]): Grammar {
  let letters = new Map<number, number>();
  for (const s of strings) for (let i = 0; i < s.length; i++) letters.set(s.charCodeAt(i), (letters.get(s.charCodeAt(i)) ?? 0) + 1);
  let rules = [...findPhrases(strings, () => true)].filter(([, uses]) => uses > 1);
  for (let round = 0; ; round++) {
    // A unit that occurs once takes no more cells escaped than as a letter that has to be stored too.
    const byUse = [
      ...[...letters].filter(([, uses]) => uses > 1).map(([unit, uses]) => ({ unit, phrase: "", uses })),
      ...rules.map(([phrase, uses]) => ({ unit: -1, phrase, uses })),
    ].sort((a, b) => b.uses - a.uses || a.unit - b.unit || (a.phrase < b.phrase ? -1 : 1));
    // The most used have a cell of their own.
    const singles = byUse.slice(0, singlesOf(byUse.length));
    const grammar = {
      letters: byUse.filter(x => x.unit >= 0).map(x => x.unit),
      singleLetters: singles.filter(x => x.unit >= 0).length,
      rules: byUse.filter(x => x.unit < 0).map(x => x.phrase),
      singleRules: singles.filter(x => x.unit < 0).length,
    };
    const coder = new Coder(grammar);
    for (const s of strings) coder.encode(s);
    const bodies = grammar.rules.map(phrase => coder.encode(phrase, true).length);
    // Without the rules that take more than they save.
    const kept = grammar.rules
      .map((phrase, i) => [phrase, coder.uses[i]!] as [string, number])
      .filter(([, uses], i) => uses * (bodies[i]! - (i < grammar.singleRules ? 1 : 2)) > bodies[i]! + RULE_OVERHEAD);
    if (kept.length === rules.length || round === 6) return grammar;
    [letters, rules] = [coder.letterUses, kept];
  }
}

/** Strings on their way into cells. */
class Text {
  readonly cells: number[];
  private readonly coder: Coder;
  private readonly encoded = new Map<string, number[]>();
  private readonly placed = new Map<string, number>();

  constructor(cells: number[], grammar: Grammar) {
    this.cells = cells;
    this.coder = new Coder(grammar);
  }

  private encode(s: string): number[] {
    let cells = this.encoded.get(s);
    if (cells) return cells;
    // The runtime finds the end of a string, and of the ones before it, by its 0.
    if (s.includes("\0")) throw new Error("a string contains U+0000");
    cells = [...this.coder.encode(s), 0];
    this.encoded.set(s, cells);
    return cells;
  }

  isNew(s: string): boolean {
    return !this.placed.has(s);
  }

  place(s: string): void {
    this.placed.set(s, this.cells.length);
    for (const cell of this.encode(s)) this.cells.push(cell);
  }

  /**
   * Stores what has not been, and returns where each string is.
   * @param alignment what that has to be a multiple of; a string that is somewhere else is stored again
   */
  finish(needed: Iterable<string>, alignment = 1): (s: string) => number {
    for (const s of needed) {
      if (!this.isNew(s) && this.placed.get(s)! % alignment === 0) continue;
      while (this.cells.length % alignment) this.cells.push(0);
      this.place(s);
    }
    return s => this.placed.get(s)!;
  }
}

// ─── What the tree shares ───

/** How the items of a container are stored, as in uresdata.cpp. */
const Mode = { Values: 0, Strings: 1, Inline: 2, Mixed: 3 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

/** Every 8th item of a sequence has its offset stored. */
const SKIP = 8;

/**
 * A table with fewer than one in this many of a master's keys gets a keyset of its own, unless the master is small:
 * the runtime searches all of the master's keys and counts its bits.
 */
const MASTER_RATIO = 8;

interface Keyset {
  keys: string[];
  types: number[];
  /** In 16-bit units, from the first keyset. */
  offset: number;
}

interface Shared {
  keys: Buffer;
  keyOffset: Map<string, number>;
  /** By `signature()`. */
  keysetOf: Map<string, { keyset: Keyset; master: boolean }>;
  keysets: number[];
  grammars: Grammar[];
  /** By bundle name. */
  grammarOf: Map<string, number>;
  poolGrammar: number;
  /** By offset in the version 3 pool. */
  ordinal: Map<number, number>;
  /** By ordinal, into `poolText`. */
  stringOffsets: number[];
  poolText: number[];
}

const allStrings = (node: Table | ArrayNode) => node.items.every(item => item.is === "string");

/** The type a node gets. A container that the compact area cannot hold stays as it was in version 3. */
function typeOf(node: Node): number {
  switch (node.is) {
    case "string":
      return Type.StringV2;
    case "int":
      return Type.Int;
    case "intvector":
      return Type.IntVector;
    case "alias":
      return Type.Alias;
    case "array":
      return node.items.length && node.items.length < 0x4000 && allStrings(node) ? Type.ArrayCompact : Type.Array;
    case "table":
      return node.items.length && node.items.every(item => item.is !== "int" || item.value < 0x10000)
        ? Type.TableCompact
        : Type.Table;
  }
}

/** Whether a resource of the type is in the compact area, so that its offset is one there. */
const isCompact = (type: number) => type === Type.TableCompact || type === Type.ArrayCompact;

/**
 * Whether the node is a container of nothing but strings, which a table has among its items rather than refer to.
 * Not the table at the root: what follows such an item is found by finding where the item ends, and there they are
 * the names of all languages, or of all regions.
 * @param parent the path of the table
 */
const isLeaf = (node: Node, parent: string) =>
  parent !== "" && (node.is === "table" || node.is === "array") && allStrings(node) && isCompact(typeOf(node));

/** The type that a table's keyset has for the node. */
const typeInTable = (node: Node, parent: string) =>
  isLeaf(node, parent) ? (node.is === "table" ? Type.TableInline : Type.ArrayInline) : typeOf(node);

const identity = (keys: string[], types: number[]) => `${keys.join("\0")}\x01${types.join()}`;
const signature = (path: string, keys: string[], types: number[]) => `${path}\x02${identity(keys, types)}`;
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));

function* stringsOf(node: Node): Generator<StringNode> {
  if (node.is === "string") yield node;
  else if (node.is === "table" || node.is === "array") for (const item of node.items) yield* stringsOf(item);
}

/** The units that are not ASCII, most frequent first, and how many units there are. */
function census(strings: Iterable<string>): { frequent: [unit: number, count: number][]; units: number } {
  const counts = new Map<number, number>();
  let units = 0;
  for (const s of strings) {
    units += s.length;
    for (let i = 0; i < s.length; i++) {
      const unit = s.charCodeAt(i);
      if (unit >= 0x80) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    }
  }
  return { frequent: [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]), units };
}

function share(bundles: Bundle[], pool: Pool3): Shared {
  // ── Keys: the pool's, and any that only one bundle had.
  let end = pool.strings;
  while (end > pool.keys && pool.bytes[end - 1] === 0xaa) end--;
  const keyParts = [pool.bytes.subarray(pool.keys, end)];
  let keysLength = keyParts[0]!.length;
  const keyOffset = new Map<string, number>();
  const needKey = (key: string) => {
    if (keyOffset.has(key)) return;
    const bytes = Buffer.from(key + "\0", "latin1");
    const at = keyParts[0]!.indexOf(bytes);
    keyOffset.set(key, at >= 0 ? at : keysLength);
    if (at >= 0) return;
    keyParts.push(bytes);
    keysLength += bytes.length;
  };
  for (const bundle of bundles) needKey(bundle.name);

  // ── Keysets.
  interface Use {
    path: string;
    keys: string[];
    types: number[];
    count: number;
  }
  const uses = new Map<string, Use>();
  /** path → key → type → how many tables have it so */
  const atPath = new Map<string, Map<string, Map<number, number>>>();
  const visit = (node: Node, path: string) => {
    if (node.is === "array") for (const item of node.items) visit(item, `${path}/#`);
    if (node.is !== "table") return;
    node.keys.forEach(needKey);
    if (typeOf(node) === Type.TableCompact) {
      const types = node.items.map(item => typeInTable(item, path));
      const id = signature(path, node.keys, types);
      const use = uses.get(id) ?? { path, keys: node.keys, types, count: 0 };
      use.count++;
      uses.set(id, use);
      let keys = atPath.get(path);
      if (!keys) atPath.set(path, (keys = new Map()));
      node.keys.forEach((key, i) => {
        let counts = keys.get(key);
        if (!counts) keys.set(key, (counts = new Map()));
        counts.set(types[i]!, (counts.get(types[i]!) ?? 0) + 1);
      });
    }
    node.items.forEach((item, i) => visit(item, `${path}/${node.keys[i]}`));
  };
  for (const bundle of bundles) visit(bundle.root, "");
  if (keysLength > 0xffff) throw new Error("the keys do not fit 16-bit offsets");

  const unitsOf = (n: number) => (1 + n + Math.ceil(n / 4) + 1) & ~1;
  // A keyset of a table's own is shared with every table that has the same keys, wherever it is.
  const sameKeys = new Map<string, number>();
  for (const use of uses.values()) {
    const id = identity(use.keys, use.types);
    sameKeys.set(id, (sameKeys.get(id) ?? 0) + use.count);
  }
  const masters = new Map<string, { keys: string[]; types: Map<string, number> }>();
  for (const [path, keys] of atPath) {
    const types = new Map(
      [...keys].map(([key, counts]) => [key, [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]]),
    );
    masters.set(path, { keys: [...keys.keys()].sort(byBytes), types });
  }
  const withMaster = new Set<string>();
  const saved = new Map<string, number>();
  for (const [id, use] of uses) {
    const master = masters.get(use.path)!;
    const bits = Math.ceil(master.keys.length / 16) * use.count;
    const own = (unitsOf(use.keys.length) * use.count) / sameKeys.get(identity(use.keys, use.types))!;
    if (bits >= own) continue;
    if (master.keys.length > 16 && use.keys.length * MASTER_RATIO < master.keys.length) continue;
    if (!use.keys.every((key, i) => master.types.get(key) === use.types[i])) continue;
    withMaster.add(id);
    saved.set(use.path, (saved.get(use.path) ?? 0) + own - bits);
  }

  const keysets: number[] = [];
  const made = new Map<string, Keyset>();
  const make = (keys: string[], types: number[]) => {
    const id = identity(keys, types);
    let keyset = made.get(id);
    if (keyset) return keyset;
    keyset = { keys, types, offset: keysets.length };
    keysets.push(keys.length, ...keys.map(key => keyOffset.get(key)!));
    for (let i = 0; i < keys.length; i += 4) {
      keysets.push(types[i]! | ((types[i + 1] ?? 0) << 4) | ((types[i + 2] ?? 0) << 8) | ((types[i + 3] ?? 0) << 12));
    }
    if (keysets.length & 1) keysets.push(0);
    made.set(id, keyset);
    return keyset;
  };
  const keysetOf = new Map<string, { keyset: Keyset; master: boolean }>();
  for (const [id, use] of uses) {
    const master = masters.get(use.path)!;
    // The master has to be stored too.
    if (withMaster.has(id) && saved.get(use.path)! > unitsOf(master.keys.length)) {
      keysetOf.set(id, {
        keyset: make(
          master.keys,
          master.keys.map(key => master.types.get(key)!),
        ),
        master: true,
      });
    } else keysetOf.set(id, { keyset: make(use.keys, use.types), master: false });
  }
  if (keysets.length >> 1 > MAX_HEADER >> 3) throw new Error("the keysets do not fit the offset in a header");

  // ── Grammars: one for the bundles of a language and script.
  // Those that have little text share one with others, while there is room for the letters of all of them.
  const stored = (bundle: Bundle) => {
    const local = new Set<string>();
    for (const s of stringsOf(bundle.root)) if (s.pool === undefined && s.text.length) local.add(s.text);
    return [...local];
  };
  const groups = new Map<string, { names: string[]; strings: string[] }>();
  for (const bundle of bundles) {
    const [language, script] = bundle.name.split("_");
    const id = script && /^[A-Z][a-z]{3}$/.test(script) ? `${language}_${script}` : language!;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { names: [], strings: [] }));
    group.names.push(bundle.name);
    group.strings.push(...stored(bundle));
  }
  const unitsOfText = (strings: string[]) => {
    const units = new Set<number>();
    for (const s of strings) for (let i = 0; i < s.length; i++) units.add(s.charCodeAt(i));
    return units;
  };
  const merged: { names: string[]; strings: string[]; units: Set<number>; open: boolean }[] = [];
  const sizeOf = (strings: string[]) => strings.reduce((sum, s) => sum + s.length, 0);
  for (const group of [...groups.values()].sort((a, b) => sizeOf(b.strings) - sizeOf(a.strings) || byBytes(a.names[0]!, b.names[0]!))) {
    const units = unitsOfText(group.strings);
    const small = sizeOf(group.strings) < OWN_GRAMMAR;
    let best: (typeof merged)[number] | undefined;
    let least = Infinity;
    for (const other of small ? merged : []) {
      if (!other.open) continue;
      const more = [...units].filter(unit => !other.units.has(unit)).length;
      if (other.units.size + more <= SHARED_LETTERS && more < least) [best, least] = [other, more];
    }
    if (!best) merged.push((best = { names: [], strings: [], units: new Set(), open: small }));
    best.names.push(...group.names);
    best.strings.push(...group.strings);
    for (const unit of units) best.units.add(unit);
  }
  const grammarOf = new Map<string, number>();
  const grammars = merged.map(({ names, strings }, i) => {
    for (const name of names) grammarOf.set(name, i);
    return makeGrammar(strings);
  });

  // ── The pool's strings, with a grammar of their own.
  const pooled = new Map<number, string>();
  for (const bundle of bundles)
    for (const s of stringsOf(bundle.root)) if (s.pool !== undefined) pooled.set(s.pool, s.text);
  const texts = [...new Set(pooled.values())].filter(s => s.length).sort();
  const poolGrammar = grammars.push(makeGrammar(texts)) - 1;
  // Cell 0 is the empty string.
  const poolText = [0];
  const where = new Text(poolText, grammars[poolGrammar]!).finish(texts);
  const located = [...pooled].map(([offset3, s]) => ({ offset3, offset: s.length ? where(s) : 0 }));
  located.sort((a, b) => a.offset - b.offset || a.offset3 - b.offset3);
  const ordinal = new Map<number, number>();
  const stringOffsets: number[] = [];
  located.forEach(({ offset3, offset }, i) => {
    // Two offsets in the version 3 pool can be the same string.
    if (located[i - 1]?.offset !== offset) stringOffsets.push(offset);
    ordinal.set(offset3, stringOffsets.length - 1);
  });
  if (grammars.length > 0xfff) throw new Error("more grammars than 12 bits can number");
  if (poolText.length > 0x20000) throw new Error("the pool's strings do not fit their offsets");

  return {
    keys: Buffer.concat(keyParts),
    keyOffset,
    keysetOf,
    keysets,
    grammars,
    grammarOf,
    poolGrammar,
    ordinal,
    stringOffsets,
    poolText,
  };
}

// ─── A bundle ───

/** 32-bit words before a bundle's 32-bit resources: the root, the limits and flags, the sizes. */
const BUNDLE_HEADER = 3;

/**
 * The headers of containers are few different numbers. The most frequent are known by a byte.
 * `count` is for finding out which those are.
 */
class Headers {
  readonly counts = new Map<number, number>();
  readonly codes = new Map<number, number>();
  readonly values: number[];

  constructor(before?: Headers) {
    this.values = [...(before?.counts ?? [])]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, HEADER_ESCAPE)
      .map(([value]) => value);
    this.values.forEach((value, code) => this.codes.set(value, code));
  }

  cells(value: number): number[] {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    const code = this.codes.get(value);
    if (value > MAX_HEADER) throw new Error("a header does not fit three bytes");
    return code === undefined ? [HEADER_ESCAPE, value & 0xff, (value >> 8) & 0xff, value >> 16] : [code];
  }
}
const HEADER_ESCAPE = 0xff;
const MAX_HEADER = 0xffffff;

class DoesNotFit extends Error {}
/** The most that a field's offset can be shifted by. */
const MAX_SHIFT = 3;

/** @param shift a field that is an offset in the compact area is in units of so many bits' worth of bytes */
function encodeBundle(
  bundle: Bundle,
  shared: Shared,
  headers: { table: Headers; array: Headers },
  shift: number,
): Buffer {
  const grammar = shared.grammarOf.get(bundle.name)!;
  // Cell 0 is the empty string.
  const cells = [0];
  const text = new Text(cells, shared.grammars[grammar]!);

  let poolLimit = 0;
  for (const s of stringsOf(bundle.root))
    if (s.pool !== undefined) poolLimit = Math.max(poolLimit, shared.ordinal.get(s.pool)! + 1);

  const setField = (at: number, value: number) => {
    if (value < 0 || value > 0xffff) throw new DoesNotFit(`${bundle.name}: ${value} does not fit a field`);
    [cells[at], cells[at + 1]] = [value & 0xff, value >> 8];
  };
  const field = (value: number) => setField(cells.length, value);
  const fields = (values: number[]) => values.forEach(field);
  const bitFields = (n: number, isSet: (i: number) => boolean) => {
    const words = new Array<number>(Math.ceil(n / 16)).fill(0);
    for (let i = 0; i < n; i++) if (isSet(i)) words[i >> 4]! |= 1 << (i & 15);
    fields(words);
  };

  /** Fields and words that wait for a string to have a place. */
  const later16: { at: number; text: string }[] = [];
  const later32: { at: number; text: string }[] = [];
  const stringField = (s: StringNode) => {
    if (s.pool !== undefined) return field(shared.ordinal.get(s.pool)!);
    if (s.text.length) later16.push({ at: cells.length, text: s.text });
    field(poolLimit);
  };

  /** Which of the strings would be stored here, in sequence, rather than be a value that says where else they are. */
  const inSequence = (items: StringNode[]) => {
    const here = new Set<string>();
    return items.map(s => {
      if (s.pool !== undefined) return false;
      if (s.text.length && (here.has(s.text) || !text.isNew(s.text))) return false;
      here.add(s.text);
      return true;
    });
  };
  const skips = (n: number) => Math.floor((n - 1) / SKIP);
  const modeOf = (items: StringNode[]): Mode => {
    const sequence = inSequence(items).filter(Boolean).length;
    const values = items.length - sequence;
    if (!sequence) return Mode.Values;
    const bytes = (values ? Math.ceil(items.length / 16) + values : 0) * 2 + skips(sequence) * 2;
    return bytes >= items.length * 2 ? Mode.Values : values ? Mode.Mixed : Mode.Strings;
  };
  /** The stored offsets, then each item by `emit`. */
  const sequence = <T>(items: T[], emit: (item: T) => void) => {
    const stored = cells.length;
    fields(new Array<number>(skips(items.length)).fill(0));
    const first = cells.length;
    items.forEach((item, i) => {
      if (i && i % SKIP === 0) setField(stored + (i / SKIP - 1) * 2, cells.length - first);
      emit(item);
    });
  };
  const strings = (mode: Mode, items: StringNode[]) => {
    if (mode === Mode.Values) return items.forEach(stringField);
    const here = inSequence(items);
    if (mode === Mode.Mixed) {
      bitFields(items.length, i => !here[i]);
      items.filter((_, i) => !here[i]).forEach(stringField);
    }
    sequence(
      items.filter((_, i) => here[i]),
      s => (s.text.length ? text.place(s.text) : cells.push(0)),
    );
  };

  const words: number[] = [];
  const push32 = (values: number[]) => {
    const at = BUNDLE_HEADER + words.length;
    for (const value of values) words.push(value >>> 0);
    return at;
  };
  /** The items of a version 3 container. */
  const items32 = (nodes: Node[], paths: string[]) =>
    nodes.map((node, i) => {
      if (node.is !== "string") return { res: emit(node, paths[i]!) };
      if (node.pool !== undefined) return { res: resource(Type.StringV2, shared.ordinal.get(node.pool)!) };
      return node.text.length ? { res: 0, text: node.text } : { res: resource(Type.StringV2, poolLimit) };
    });
  const container32 = (type: number, head: number[], items: { res: number; text?: string }[]) => {
    const at = push32([...head, ...items.map(item => item.res)]);
    items.forEach((item, i) => {
      if (item.text !== undefined) later32.push({ at: at - BUNDLE_HEADER + head.length + i, text: item.text });
    });
    return resource(type, at);
  };
  const words16 = (units: number[]) => {
    const bytes = Buffer.alloc((units.length * 2 + 3) & ~3);
    units.forEach((unit, i) => bytes.writeUInt16LE(unit, i * 2));
    return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
  };

  /** Where a container starts that is not among the items of another, so that a field may have to say where. */
  const aligned = () => {
    while (cells.length & ((1 << shift) - 1)) cells.push(0);
    return cells.length;
  };

  /** @param inline the node is being written among the items of a table */
  const emit = (node: Node, path: string, inline = false): number => {
    switch (node.is) {
      case "string":
        throw new Error("a string is written by what contains it");
      case "int":
        return resource(Type.Int, node.value);
      case "alias":
        return resource(
          Type.Alias,
          push32([node.text.length, ...words16([...Array.from(node.text, c => c.charCodeAt(0)), 0])]),
        );
      case "intvector":
        return resource(Type.IntVector, node.values.length ? push32([node.values.length, ...node.values]) : 0);
      case "array": {
        if (!node.items.length) return resource(Type.Array, 0);
        if (typeOf(node) === Type.Array) {
          return container32(
            Type.Array,
            [node.items.length],
            items32(
              node.items,
              node.items.map(() => `${path}/#`),
            ),
          );
        }
        const mode = modeOf(node.items as StringNode[]);
        const at = inline ? cells.length : aligned();
        cells.push(...headers.array.cells((node.items.length << 2) | mode));
        strings(mode, node.items as StringNode[]);
        return resource(Type.ArrayCompact, at);
      }
      case "table": {
        if (!node.items.length) return resource(Type.Table, 0);
        const paths = node.keys.map(key => `${path}/${key}`);
        if (typeOf(node) === Type.Table) {
          const head = words16([node.keys.length, ...node.keys.map(key => shared.keyOffset.get(key)!)]);
          return container32(Type.Table, head, items32(node.items, paths));
        }
        const { keyset, master } = shared.keysetOf.get(signature(path, node.keys, node.items.map(item => typeInTable(item, path))))!;
        const mode = allStrings(node)
          ? modeOf(node.items as StringNode[])
          : node.items.some(item => isLeaf(item, path))
            ? Mode.Inline
            : Mode.Values;
        // What a value points to comes first.
        const values = allStrings(node)
          ? []
          : node.items.map((item, i) =>
              item.is === "string" || isLeaf(item, path) ? undefined : emit(item, paths[i]!) & 0xfffffff,
            );
        const at = inline ? cells.length : aligned();
        cells.push(...headers.table.cells(((keyset.offset >> 1) << 3) | (master ? 4 : 0) | mode));
        if (master) {
          const has = new Set(node.keys);
          bitFields(keyset.keys.length, j => has.has(keyset.keys[j]!));
        }
        const value = (item: Node, i: number) =>
          item.is === "string"
            ? stringField(item)
            : field(isCompact(typeOf(item)) ? values[i]! >> shift : values[i]!);
        if (allStrings(node)) strings(mode, node.items as StringNode[]);
        else if (mode === Mode.Inline)
          sequence(
            node.items.map((item, i) => [item, i] as const),
            ([item, i]) => (isLeaf(item, path) ? emit(item, paths[i]!, true) : value(item, i)),
          );
        else node.items.forEach(value);
        return resource(Type.TableCompact, at);
      }
    }
  };

  const root = emit(bundle.root, "");
  const where = text.finish(
    [...later16, ...later32].map(l => l.text),
    1 << shift,
  );
  for (const { at, text: s } of later16) setField(at, poolLimit + (where(s) >> shift));
  for (const { at, text: s } of later32) words[at] = resource(Type.StringV2, poolLimit + where(s));

  const compactStart = BUNDLE_HEADER + words.length;
  const total = compactStart + Math.ceil(cells.length / 4);
  if (total > 0xffff) throw new Error(`${bundle.name}: too large`);
  const out = Buffer.alloc(total * 4);
  const flags = (bundle.noFallback ? ATT_NO_FALLBACK : 0) | (shift << ATT_SHIFT);
  [
    root,
    (poolLimit | (flags << 16) | (grammar << 20)) >>> 0,
    (compactStart | (total << 16)) >>> 0,
    ...words,
  ].forEach((word, i) => out.writeUInt32LE(word, i * 4));
  Buffer.from(cells).copy(out, compactStart * 4);
  return out;
}

// ─── The tree ───

/** indexes[], as in uresdata.h. */
const Index = {
  Length: 0,
  KeysTop: 1,
  ResourcesTop: 2,
  BundleTop: 3,
  MaxTableLength: 4,
  Attributes: 5,
  Units16Top: 6,
  PoolChecksum: 7,
  Keysets: 8,
  Grammars: 9,
  Headers: 10,
  StringOffsets: 11,
  StringOffsetsHighStart: 12,
  PoolText: 13,
  PoolGrammar: 14,
  Bundles: 15,
  BundleNames: 16,
  BundleOffsets: 17,
  Top: 18,
} as const;

function assemble(
  pool: Pool3,
  shared: Shared,
  headers: { table: Headers; array: Headers },
  bundles: { name: string; bytes: Buffer }[],
): Buffer {
  const units = (values: number[]) => {
    const bytes = Buffer.alloc((values.length * 2 + 3) & ~3);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 0xffff, i * 2));
    return bytes;
  };
  const padded = (bytes: Buffer, fill = 0) => Buffer.concat([bytes, Buffer.alloc(-bytes.length & 3, fill)]);

  const index = new Array<number>(Index.Top).fill(0);
  const parts: Buffer[] = [];
  let top = 1 + Index.Top;
  const add = (part: Buffer) => {
    const at = top;
    parts.push(part);
    top += part.length / 4;
    return at;
  };
  index[Index.Length] = Index.Top;
  index[Index.Attributes] = ATT_IS_POOL;
  add(padded(shared.keys, 0xaa));
  index[Index.KeysTop] = index[Index.Units16Top] = top;
  index[Index.Keysets] = add(units(shared.keysets));
  // Where each grammar starts, in 16-bit units from here, then the grammars.
  const grammars = shared.grammars.map(grammar => {
    const coder = new Coder(grammar);
    const bodies = grammar.rules.map(phrase => coder.encode(phrase, true));
    const offsets = [0];
    for (const body of bodies) offsets.push(offsets.at(-1)! + body.length);
    if (offsets.at(-1)! > 0xffff) throw new Error("the rules of a grammar do not fit 16-bit offsets");
    const head = [
      grammar.singleLetters,
      grammar.singleRules,
      grammar.letters.length - grammar.singleLetters,
      grammar.rules.length,
      ...grammar.letters,
      ...offsets,
    ];
    const bytes = Buffer.alloc(head.length * 2 + ((offsets.at(-1)! + 1) & ~1));
    head.forEach((value, i) => bytes.writeUInt16LE(value, i * 2));
    Buffer.from(bodies.flat()).copy(bytes, head.length * 2);
    return bytes;
  });
  const starts = Buffer.alloc(grammars.length * 4);
  let start = starts.length / 2;
  grammars.forEach((bytes, i) => {
    starts.writeUInt32LE(start, i * 4);
    start += bytes.length / 2;
  });
  index[Index.Grammars] = add(padded(Buffer.concat([starts, ...grammars])));
  // Room for all that a byte can number, so that the runtime need not know how many there are.
  const codebook = (h: Headers) => Array.from({ length: HEADER_ESCAPE + 1 }, (_, i) => h.values[i] ?? 0);
  const codebooks = Buffer.alloc((HEADER_ESCAPE + 1) * 2 * 4);
  [...codebook(headers.table), ...codebook(headers.array)].forEach((value, i) => codebooks.writeUInt32LE(value, i * 4));
  index[Index.Headers] = add(codebooks);
  index[Index.StringOffsets] = add(units(shared.stringOffsets));
  const high = shared.stringOffsets.findIndex(offset => offset >= 0x10000);
  index[Index.StringOffsetsHighStart] = high < 0 ? shared.stringOffsets.length : high;
  index[Index.PoolText] = add(padded(Buffer.from(shared.poolText)));
  index[Index.PoolGrammar] = shared.poolGrammar;
  index[Index.Bundles] = bundles.length;
  index[Index.BundleNames] = add(units(bundles.map(b => shared.keyOffset.get(b.name)!)));
  const offsets = Buffer.alloc(bundles.length * 4);
  index[Index.BundleOffsets] = add(offsets);
  // Many bundles of a tree say nothing, or the same few things.
  const added = new Map<string, number>();
  bundles.forEach((b, i) => {
    const id = b.bytes.toString("latin1");
    if (!added.has(id)) added.set(id, add(b.bytes));
    offsets.writeUInt32LE(added.get(id)!, i * 4);
  });
  // The runtime looks for the ends of strings 8 bytes at a time.
  add(Buffer.alloc(8));
  index[Index.ResourcesTop] = index[Index.BundleTop] = top;

  const head = Buffer.alloc(pool.header.length + (1 + Index.Top) * 4);
  pool.header.copy(head);
  head[16] = 4; // formatVersion[0]
  [resource(Type.Table, 0), ...index].forEach((word, i) => head.writeUInt32LE(word >>> 0, pool.header.length + i * 4));
  return Buffer.concat([head, ...parts]);
}

// ─── Reading version 4: what the runtime has to do, and the proof that nothing was lost ───

function readTree4(tree: Buffer): Map<string, Bundle> {
  const root = tree.readUInt16LE(0);
  const index = (i: number) => tree.readInt32LE(root + 4 + i * 4);
  const at = (i: number) => root + index(i) * 4;
  const keys = root + (1 + (index(Index.Length) & 0xff)) * 4;
  const key = (offset: number) => cString(tree, keys + offset);

  /** What the cells from `from` stand for, up to `to` or else to a 0. */
  const textAt = (from: number, grammar: number, to = Infinity): string => {
    const head = at(Index.Grammars) + tree.readUInt32LE(at(Index.Grammars) + grammar * 4) * 2;
    const [letters, singles, otherLetters, rules] = [0, 2, 4, 6].map(i => tree.readUInt16LE(head + i)) as number[] as [
      number,
      number,
      number,
      number,
    ];
    const letter = (i: number) => String.fromCharCode(tree.readUInt16LE(head + 8 + i * 2));
    const offsets = head + 8 + (letters + otherLetters) * 2;
    const bodies = offsets + (rules + 1) * 2;
    let s = "";
    for (let p = from; p < to; ) {
      const cell = tree[p++]!;
      if (cell === 0) return s;
      if (cell === ESCAPE) {
        s += String.fromCharCode((tree[p]! & 0x7f) | ((tree[p + 1]! & 0x7f) << 7) | ((tree[p + 2]! & 3) << 14));
        p += 3;
      } else if (cell <= letters) {
        s += letter(cell - 1);
      } else {
        let rule = cell - letters - 1;
        if (rule >= singles) {
          const other = (rule - singles) * PER_LEAD + tree[p++]! - 1;
          if (other < otherLetters) {
            s += letter(letters + other);
            continue;
          }
          rule = singles + other - otherLetters;
        }
        if (rule >= rules) throw new Error("a cell stands for no rule");
        s += textAt(
          bodies + tree.readUInt16LE(offsets + rule * 2),
          grammar,
          bodies + tree.readUInt16LE(offsets + rule * 2 + 2),
        );
      }
    }
    return s;
  };
  const poolString = (ordinal: number): Node => {
    const low = tree.readUInt16LE(at(Index.StringOffsets) + ordinal * 2);
    const offset = low + (ordinal >= index(Index.StringOffsetsHighStart) ? 0x10000 : 0);
    return { is: "string", text: textAt(at(Index.PoolText) + offset, index(Index.PoolGrammar)) };
  };

  const readBundle = (name: string, body: number): Bundle => {
    const poolLimit = tree.readUInt16LE(body + 4);
    const flags = tree[body + 6]! & 0xf;
    const shift = flags >> ATT_SHIFT;
    const grammar = tree.readUInt16LE(body + 6) >> 4;
    const compact = body + tree.readUInt16LE(body + 8) * 4;
    const place = (offset: number) => compact + offset;
    const field = (p: number) => tree.readUInt16LE(p);
    const bit = (bits: number, i: number) => (tree[bits + (i >> 3)]! >> (i & 7)) & 1;
    const local = (p: number): Node => ({ is: "string", text: textAt(p, grammar) });
    /** @param by `shift` for what a field says */
    const string = (value: number, by = 0) =>
      value < poolLimit ? poolString(value) : local(place((value - poolLimit) << by));
    const afterString = (p: number) => tree.indexOf(0, p) + 1;
    /** Checks the stored offsets on the way. */
    const sequence = (p: number, n: number, read: (p: number, i: number) => { node: Node; end: number }) => {
      const first = p + Math.floor((n - 1) / SKIP) * 2;
      const nodes: Node[] = [];
      let q = first;
      for (let i = 0; i < n; i++) {
        if (i && i % SKIP === 0 && field(p + (i / SKIP - 1) * 2) !== q - first)
          throw new Error(`${name}: a stored offset is wrong`);
        const { node, end } = read(q, i);
        nodes.push(node);
        q = end;
      }
      return { nodes, end: q };
    };
    const strings = (mode: Mode, p: number, n: number): { nodes: Node[]; end: number } => {
      if (mode === Mode.Values)
        return { nodes: Array.from({ length: n }, (_, i) => string(field(p + i * 2), shift)), end: p + n * 2 };
      const isValue = Array.from({ length: n }, (_, i) => mode === Mode.Mixed && bit(p, i) === 1);
      if (mode === Mode.Mixed) p += Math.ceil(n / 16) * 2;
      const values = isValue.filter(Boolean).map((_, i) => string(field(p + i * 2), shift));
      const rest = sequence(p + values.length * 2, n - values.length, q => ({ node: local(q), end: afterString(q) }));
      return { nodes: isValue.map(v => (v ? values : rest.nodes).shift()!), end: rest.end };
    };
    const compactAt = (type: number, p: number): { node: Node; end: number } => {
      const code = tree[p++]!;
      const header =
        code === HEADER_ESCAPE
          ? tree.readUIntLE(p, 3)
          : tree.readUInt32LE(at(Index.Headers) + ((type === Type.ArrayCompact ? HEADER_ESCAPE + 1 : 0) + code) * 4);
      if (code === HEADER_ESCAPE) p += 3;
      if (type === Type.ArrayCompact) {
        const { nodes, end } = strings((header & 3) as Mode, p, header >> 2);
        return { node: { is: "array", items: nodes }, end };
      }
      const keyset = at(Index.Keysets) + (header >> 3) * 4;
      const size = tree.readUInt16LE(keyset);
      let has = Array.from({ length: size }, (_, j) => j);
      if (header & 4) {
        has = has.filter(j => bit(p, j));
        p += Math.ceil(size / 16) * 2;
      }
      const tableKeys = has.map(j => key(tree.readUInt16LE(keyset + 2 + j * 2)));
      const types = has.map(j => (tree.readUInt16LE(keyset + 2 + size * 2 + (j >> 2) * 2) >> ((j & 3) * 4)) & 15);
      const mode = (header & 3) as Mode;
      const value = (t: number, q: number) =>
        t === Type.StringV2
          ? string(field(q), shift)
          : walk(resource(t, isCompact(t) ? field(q) << shift : field(q)));
      if (mode === Mode.Inline) {
        const { nodes, end } = sequence(p, has.length, (q, i) =>
          types[i] === Type.TableInline
            ? compactAt(Type.TableCompact, q)
            : types[i] === Type.ArrayInline
              ? compactAt(Type.ArrayCompact, q)
              : { node: value(types[i]!, q), end: q + 2 },
        );
        return { node: { is: "table", keys: tableKeys, items: nodes }, end };
      }
      if (mode !== Mode.Values) {
        const { nodes, end } = strings(mode, p, has.length);
        return { node: { is: "table", keys: tableKeys, items: nodes }, end };
      }
      const items = types.map((t, i) => value(t, p + i * 2));
      return { node: { is: "table", keys: tableKeys, items }, end: p + has.length * 2 };
    };
    const walk = (res: number): Node => {
      const type = res >>> 28;
      const offset = res & 0xfffffff;
      const p = body + offset * 4;
      const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
      switch (type) {
        case Type.StringV2:
          return string(offset);
        case Type.Int:
          return { is: "int", value: offset };
        case Type.Alias:
          return { is: "alias", text: tree.toString("utf16le", p + 4, p + 4 + tree.readInt32LE(p) * 2) };
        case Type.IntVector:
          return {
            is: "intvector",
            values: offset ? times(tree.readInt32LE(p), i => tree.readInt32LE(p + 4 + i * 4)) : [],
          };
        case Type.Array:
          return {
            is: "array",
            items: offset ? times(tree.readInt32LE(p), i => walk(tree.readUInt32LE(p + 4 + i * 4))) : [],
          };
        case Type.Table: {
          const n = offset ? tree.readUInt16LE(p) : 0;
          const items = p + ((2 + n * 2 + 3) & ~3);
          return {
            is: "table",
            keys: times(n, i => key(tree.readUInt16LE(p + 2 + i * 2))),
            items: times(n, i => walk(tree.readUInt32LE(items + i * 4))),
          };
        }
        case Type.TableCompact:
        case Type.ArrayCompact:
          return compactAt(type, place(offset)).node;
      }
      throw new Error(`${name}: resource type ${type}`);
    };
    return { name, noFallback: (flags & ATT_NO_FALLBACK) !== 0, root: walk(tree.readUInt32LE(body)) };
  };

  const bundles = new Map<string, Bundle>();
  for (let i = 0; i < index(Index.Bundles); i++) {
    const name = key(tree.readUInt16LE(at(Index.BundleNames) + i * 2));
    bundles.set(name, readBundle(name, root + tree.readUInt32LE(at(Index.BundleOffsets) + i * 4) * 4));
  }
  return bundles;
}

function same(a: Node, b: Node): boolean {
  if (a.is !== b.is) return false;
  const list = <T>(x: T[], y: T[], eq: (x: T, y: T) => boolean) =>
    x.length === y.length && x.every((v, i) => eq(v, y[i]!));
  const is = <T>(x: T, y: T) => x === y;
  switch (a.is) {
    case "string":
    case "alias":
      return a.text === (b as typeof a).text;
    case "int":
      return a.value === (b as typeof a).value;
    case "intvector":
      return list(a.values, (b as typeof a).values, is);
    case "array":
      return list(a.items, (b as typeof a).items, same);
    case "table":
      return list(a.keys, (b as typeof a).keys, is) && list(a.items, (b as typeof a).items, same);
  }
}

/**
 * @param pool the tree's version 3 pool bundle
 * @param bundles by name (`de_AT`), the version 3 bundles of the tree that canCompact()
 * @returns what takes the pool bundle's place in the package, and theirs
 */
export function compactTree(pool: Buffer, bundles: Map<string, Buffer>): Buffer {
  const pool3 = readPool3(pool);
  // The runtime finds a bundle by binary search.
  const read = [...bundles].sort((a, b) => byBytes(a[0], b[0])).map(([name, bytes]) => readBundle3(name, bytes, pool3));
  const shared = share(read, pool3);
  // Once to see which headers there are.
  const seen = { table: new Headers(), array: new Headers() };
  for (const bundle of read) encodeBundle(bundle, shared, seen, MAX_SHIFT);
  const headers = { table: new Headers(seen.table), array: new Headers(seen.array) };
  const encode = (bundle: Bundle) => {
    for (let shift = 0; ; shift++) {
      try {
        return encodeBundle(bundle, shared, headers, shift);
      } catch (error) {
        if (!(error instanceof DoesNotFit) || shift === MAX_SHIFT) throw error;
      }
    }
  };
  const tree = assemble(
    pool3,
    shared,
    headers,
    read.map(bundle => ({ name: bundle.name, bytes: encode(bundle) })),
  );

  const back = readTree4(tree);
  for (const bundle of read) {
    const again = back.get(bundle.name);
    if (!again || again.noFallback !== bundle.noFallback || !same(bundle.root, again.root)) {
      throw new Error(`${bundle.name} does not read back as it was`);
    }
  }
  return tree;
}
