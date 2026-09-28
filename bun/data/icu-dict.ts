/**
 * Rewrites a break dictionary that gendict wrote as a UCharsTrie, the one for Chinese and Japanese, into a form that
 * only this ICU reads. `icu4c/source/common/dictionarydata.h` has the specification; this is the only writer.
 *
 * A UCharsTrie spends four and a half bytes on each of the dictionary's 440,000 nodes: two on a character, of which
 * a few hundred make up half of the text, and most of the rest on saying where other nodes are.
 * Here the nodes are in level order, the children of a node next to each other, so that where they are follows from
 * how many nodes before theirs have children: it takes counting bits to find, and half a byte a node to store.
 * A character is one byte, or two for the less frequent, of which siblings share the first.
 *
 * Nothing is left out: `succinctDictionary` reads back what it wrote and compares.
 */

/** As in dictionarydata.h. */
const IX_STRING_TRIE_OFFSET = 0;
const IX_TOTAL_SIZE = 3;
const IX_TRIE_TYPE = 4;
const TRIE_TYPE_UCHARS = 1;
const TRIE_TYPE_SUCCINCT = 2;
const TRIE_TYPE_MASK = 7;

/** 32-bit words at the start: the number of nodes, the number of one-byte codes, and where each part starts. */
const Header = {
  Nodes: 0,
  Singles: 1,
  UnitIndex: 2,
  UnitBlocks: 3,
  Labels: 4,
  Blocks: 5,
  Values: 6,
  Length: 8,
} as const;

/** What is stored for each 64 nodes, in bytes: three bits for each, and two numbers. */
const BLOCK = 32;
const Block = { HasChildren: 0, IsLast: 8, IsWord: 16, FirstChild: 24, Words: 28 } as const;

/** A group of at least so many siblings has a bit for each byte there is, in place of its first labels. */
const DENSE = 32;

class Bits {
  readonly words: Uint32Array;

  constructor(n: number) {
    this.words = new Uint32Array(Math.ceil(n / 64) * 2);
  }

  set(i: number): void {
    this.words[i >> 5]! |= 1 << (i & 31);
  }

  test(i: number): boolean {
    return ((this.words[i >> 5]! >> (i & 31)) & 1) !== 0;
  }
}

/** The words of a dictionary's source: a word, and a value after a tab, on each line that is not a comment. */
export function dictionaryWords(text: string): Map<string, number> {
  const words = new Map<string, number>();
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    const [word, value] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (word) words.set(word, value === undefined ? 0 : Number(value));
  }
  return words;
}

interface Trie {
  singles: number;
  /** By UTF-16 unit, its place in the order of frequency. */
  order: Map<number, number>;
  labels: number[];
  hasChildren: Bits;
  isLast: Bits;
  isWord: Bits;
  values: number[];
  /** For each node that has children, in the order of the nodes, the first of them. */
  firstChildren: number[];
}

function build(words: Map<string, number>, singles: number, order: Map<number, number>): Trie {
  const encoded = [...words].map(([word, value]) => {
    const bytes: number[] = [];
    for (let i = 0; i < word.length; i++) {
      const place = order.get(word.charCodeAt(i))!;
      if (place < singles) bytes.push(place);
      else bytes.push(singles + ((place - singles) >> 8), (place - singles) & 0xff);
    }
    return { bytes: Buffer.from(bytes), value };
  });
  encoded.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  const total = encoded.reduce((sum, e) => sum + e.bytes.length, 0);
  const trie: Trie = {
    singles,
    order,
    labels: [],
    hasChildren: new Bits(total),
    isLast: new Bits(total),
    isWord: new Bits(total),
    values: [],
    firstChildren: [],
  };
  // Each is the words that begin with the same `depth` bytes and go on, whose next bytes are siblings.
  const groups: { from: number; to: number; depth: number }[] = [{ from: 0, to: encoded.length, depth: 0 }];
  for (let g = 0; g < groups.length; g++) {
    const { from, to, depth } = groups[g]!;
    if (g) trie.firstChildren.push(trie.labels.length);
    for (let i = from; i < to; ) {
      const label = encoded[i]!.bytes[depth]!;
      let end = i;
      while (end < to && encoded[end]!.bytes[depth] === label) end++;
      const node = trie.labels.push(label) - 1;
      // The word that ends here comes before the ones that go on.
      if (encoded[i]!.bytes.length === depth + 1) {
        trie.isWord.set(node);
        trie.values.push(encoded[i]!.value);
        i++;
      }
      if (i < end) {
        trie.hasChildren.set(node);
        groups.push({ from: i, to: end, depth: depth + 1 });
      }
      i = end;
    }
    trie.isLast.set(trie.labels.length - 1);
  }
  return trie;
}

function write(trie: Trie): Buffer {
  const parts: Buffer[] = [];
  const header = new Int32Array(Header.Length);
  let top = Header.Length * 4;
  const add = (which: number, array: Uint8Array | Uint16Array | Uint32Array) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    // The runtime reads bits 64 at a time.
    const padded = Buffer.concat([bytes, Buffer.alloc(-bytes.length & 7)]);
    header[which] = top;
    parts.push(padded);
    top += padded.length;
  };
  header[Header.Nodes] = trie.labels.length;
  header[Header.Singles] = trie.singles;

  // For each 64 units, where its block is; block 0 is for those that have none of the dictionary's.
  const unitIndex = new Uint16Array(0x10000 >> 6);
  const unitBlocks: number[] = new Array<number>(64).fill(0);
  for (const [unit, place] of [...trie.order].sort((a, b) => a[0] - b[0])) {
    if (!unitIndex[unit >> 6]) {
      unitIndex[unit >> 6] = unitBlocks.length >> 6;
      for (let i = 0; i < 64; i++) unitBlocks.push(0);
    }
    unitBlocks[(unitIndex[unit >> 6]! << 6) + (unit & 63)] = place + 1;
  }
  add(Header.UnitIndex, unitIndex);
  add(Header.UnitBlocks, Uint16Array.from(unitBlocks));
  const nodes = trie.labels.length;
  const labels = Uint8Array.from(trie.labels);
  for (let first = 0, node = 0; node < nodes; node++) {
    if (!trie.isLast.test(node)) continue;
    if (node + 1 - first >= DENSE) {
      const group = trie.labels.slice(first, node + 1);
      labels.fill(0, first, node + 1);
      for (const label of group) labels[first + (label >> 3)]! |= 1 << (label & 7);
    }
    first = node + 1;
  }
  // The runtime looks at 8 labels at a time.
  add(Header.Labels, Uint8Array.from([...labels, ...new Array<number>(8).fill(0)]));
  // One more, where a search for the end of a group ends at the latest.
  const blocks = Buffer.alloc((Math.ceil(nodes / 64) + 1) * BLOCK);
  let [parents, words] = [0, 0];
  for (let node = 0; node < nodes; node++) {
    const block = (node >> 6) * BLOCK;
    if ((node & 63) === 0) {
      // Of the first node from here on that has any.
      blocks.writeUInt32LE(trie.firstChildren[parents] ?? nodes, block + Block.FirstChild);
      blocks.writeUInt32LE(words, block + Block.Words);
    }
    const set = (which: number) => (blocks[block + which + ((node & 63) >> 3)]! |= 1 << (node & 7));
    if (trie.hasChildren.test(node)) (set(Block.HasChildren), parents++);
    if (trie.isLast.test(node)) set(Block.IsLast);
    if (trie.isWord.test(node)) (set(Block.IsWord), words++);
  }
  blocks.fill(0xff, blocks.length - BLOCK + Block.IsLast, blocks.length - BLOCK + Block.IsLast + 8);
  add(Header.Blocks, blocks);
  if (trie.values.some(value => value < 0 || value > 0xff)) throw new Error("a value does not fit a byte");
  add(Header.Values, Uint8Array.from(trie.values));
  return Buffer.concat([Buffer.from(header.buffer), ...parts]);
}

/** What the runtime has to do, and the proof that nothing was lost. */
function read(data: Buffer): Map<string, number> {
  const at = (which: number) => data.readInt32LE(which * 4);
  const singles = at(Header.Singles);
  const unitOf = new Map<number, number>();
  for (let unit = 0; unit < 0x10000; unit++) {
    const block = data.readUInt16LE(at(Header.UnitIndex) + (unit >> 6) * 2);
    const place = data.readUInt16LE(at(Header.UnitBlocks) + ((block << 6) + (unit & 63)) * 2);
    if (place) unitOf.set(place - 1, unit);
  }
  const block = (node: number) => at(Header.Blocks) + (node >> 6) * BLOCK;
  const test = (which: number, node: number) => ((data[block(node) + which + ((node & 63) >> 3)]! >> (node & 7)) & 1) !== 0;
  /** How many of the nodes of its block before this one have the bit set. */
  const before = (which: number, node: number) => {
    let count = 0;
    for (let k = node & ~63; k < node; k++) if (test(which, k)) count++;
    return count;
  };
  const firstChild = (node: number) => {
    let child = data.readUInt32LE(block(node) + Block.FirstChild);
    for (let groups = before(Block.HasChildren, node); groups > 0; groups--) while (!test(Block.IsLast, child++));
    return child;
  };
  const labelsOf = (first: number) => {
    let last = first;
    while (!test(Block.IsLast, last)) last++;
    const stored = at(Header.Labels) + first;
    if (last + 1 - first < DENSE) return [...data.subarray(stored, stored + last + 1 - first)];
    return Array.from({ length: 0x100 }, (_, label) => label).filter(label => (data[stored + (label >> 3)]! >> (label & 7)) & 1);
  };
  const words = new Map<string, number>();
  const walk = (first: number, prefix: string, lead: number) => {
    labelsOf(first).forEach((label, i, all) => {
      const node = first + i;
      if (test(Block.IsLast, node) !== (i === all.length - 1)) throw new Error("a group has other labels than nodes");
      const isLead = lead < 0 && label >= singles;
      const text = isLead
        ? prefix
        : prefix + String.fromCharCode(unitOf.get(lead < 0 ? label : singles + ((lead - singles) << 8) + label)!);
      if (test(Block.IsWord, node)) {
        if (isLead) throw new Error("a word ends in the middle of a character");
        words.set(text, data[at(Header.Values) + data.readUInt32LE(block(node) + Block.Words) + before(Block.IsWord, node)]!);
      }
      if (test(Block.HasChildren, node)) walk(firstChild(node), text, isLead ? label : -1);
    });
  };
  walk(0, "", -1);
  return words;
}

/**
 * @param dictionary what gendict --uchars wrote
 * @param words what it wrote it from
 * @returns what takes its place in the package
 */
export function succinctDictionary(dictionary: Buffer, words: Map<string, number>): Buffer {
  const indexes = dictionary.readUInt16LE(0);
  const index = (i: number) => dictionary.readInt32LE(indexes + i * 4);
  if ((index(IX_TRIE_TYPE) & TRIE_TYPE_MASK) !== TRIE_TYPE_UCHARS) throw new Error("not a UCharsTrie dictionary");

  const counts = new Map<number, number>();
  for (const word of words.keys()) {
    for (let i = 0; i < word.length; i++) counts.set(word.charCodeAt(i), (counts.get(word.charCodeAt(i)) ?? 0) + 1);
  }
  const order = new Map([...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([unit], place) => [unit, place]));
  // More one-byte codes make fewer nodes, but leave fewer bytes to lead the two-byte codes.
  let singles = 0x100 - Math.ceil(order.size / 0x100);
  while (singles + Math.ceil((order.size - singles) / 0x100) > 0x100) singles--;
  const data = write(build(words, singles, order));

  const back = read(data);
  if (back.size !== words.size || [...words].some(([word, value]) => back.get(word) !== value)) {
    throw new Error("the dictionary does not read back as it was");
  }

  const head = Buffer.from(dictionary.subarray(0, indexes + index(IX_STRING_TRIE_OFFSET)));
  head.writeInt32LE(index(IX_STRING_TRIE_OFFSET) + data.length, indexes + IX_TOTAL_SIZE * 4);
  head.writeInt32LE((index(IX_TRIE_TYPE) & ~TRIE_TYPE_MASK) | TRIE_TYPE_SUCCINCT, indexes + IX_TRIE_TYPE * 4);
  return Buffer.concat([head, data]);
}
