// Runs test262's Intl tests under a build of Bun and writes each test's outcome, for comparing two builds.
// A test that fails the same way under both is not a difference: this is not a conformance run.
//
//   bun test262.ts <bun executable> <test262 dir> <output file>

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";

const [exe, root, output] = process.argv.slice(2);
if (!exe || !root || !output) throw new Error("usage: test262.ts <bun executable> <test262 dir> <output file>");

const DIRS = [
  "test/intl402",
  "test/built-ins/String/prototype/normalize",
  "test/built-ins/String/prototype/localeCompare",
  "test/built-ins/String/prototype/toLocaleLowerCase",
  "test/built-ins/String/prototype/toLocaleUpperCase",
  "test/built-ins/String/prototype/toLowerCase",
  "test/built-ins/String/prototype/toUpperCase",
  "test/built-ins/Date/prototype/toLocaleString",
  "test/built-ins/Date/prototype/toLocaleDateString",
  "test/built-ins/Date/prototype/toLocaleTimeString",
  "test/built-ins/Date/prototype/toString",
  "test/built-ins/Number/prototype/toLocaleString",
  "test/built-ins/Temporal/ZonedDateTime",
];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith(".js") && !e.name.includes("_FIXTURE")
        ? [join(dir, e.name)]
        : [],
  );
const tests = DIRS.flatMap(d => walk(join(root, d))).sort();

const harness = (name: string) => readFileSync(join(root, "harness", name), "utf8");
const work = mkdtempSync(join(tmpdir(), "test262-"));
// The test is a script, not a module, so it goes through indirect eval.
const runner = join(work, "runner.js");
writeFileSync(
  runner,
  `const source = require("node:fs").readFileSync(process.argv[2], "utf8");
globalThis.print = (...a) => console.log(...a);
globalThis.$262 = { global: globalThis, gc() { Bun.gc(true); }, evalScript(s) { return (0, eval)(s); }, detachArrayBuffer(b) { structuredClone(b, { transfer: [b] }); }, agent: {} };
try { (0, eval)(source); } catch (e) { console.log("THROWN " + (e && e.constructor && e.constructor.name) + ": " + (e && e.message)); process.exit(1); }`,
);

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TZ: "UTC",
  LANG: "en_US.UTF-8",
  ...(process.env.ICU_DATA ? { ICU_DATA: process.env.ICU_DATA } : {}),
};

async function run(path: string, index: number): Promise<string> {
  const text = readFileSync(path, "utf8");
  const front = /\/\*---([^]*?)---\*\//.exec(text)?.[1] ?? "";
  const list = (key: string) => {
    const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]`, "m").exec(front);
    if (inline)
      return inline[1]!
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-.*\\n?)+)`, "m").exec(front);
    return block
      ? block[1]!
          .split("\n")
          .map(s => s.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean)
      : [];
  };
  const flags = list("flags");
  if (flags.includes("module")) return "SKIP module";
  const includes = flags.includes("raw")
    ? []
    : ["assert.js", "sta.js", ...(flags.includes("async") ? ["doneprintHandle.js"] : []), ...list("includes")];
  const file = join(work, `${index}.js`);
  writeFileSync(
    file,
    (flags.includes("onlyStrict") ? '"use strict";\n' : "") + includes.map(harness).join("\n") + "\n" + text,
  );
  return new Promise(resolve => {
    const child = spawn(exe, [runner, file], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => out.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const said = Buffer.concat(out).toString().replaceAll(work, "").replace(/\s+/g, " ").trim().slice(0, 400);
      resolve(`${signal ?? code} ${said}`);
    });
  });
}

const results: string[] = new Array(tests.length);
let next = 0;
await Promise.all(
  Array.from({ length: availableParallelism() }, async () => {
    while (next < tests.length) {
      const i = next++;
      // The second column is what run.ts --compare adds up.
      results[i] = `${relative(root, tests[i]!)}\t1\t${await run(tests[i]!, i)}`;
    }
  }),
);
writeFileSync(output, results.join("\n") + "\n");
const clean = results.filter(r => /\t1\t0 ($|Test262:AsyncTestComplete)/.test(r)).length;
console.log(`${tests.length} tests, ${clean} pass`);
