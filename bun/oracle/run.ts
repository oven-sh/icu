// Runs oracle.js under a build of Bun, in parallel, and writes its sorted output to one file.
//
//   bun run.ts <bun executable> <inputs dir> <output file> [section...]
//   bun run.ts --compare <a> <b>

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

const oracle = join(import.meta.dirname, "oracle.js");

if (process.argv[2] === "--compare") {
  const load = (path: string) =>
    new Map(
      readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => [l.slice(0, l.indexOf("\t")), l] as const),
    );
  const a = load(process.argv[3]!);
  const b = load(process.argv[4]!);
  const differing: string[] = [];
  for (const [key, line] of a) if (b.get(key) !== line) differing.push(key);
  for (const key of b.keys()) if (!a.has(key)) differing.push(key);
  const results = [...a.values()].reduce((sum, l) => sum + Number(l.split("\t")[1]), 0);
  console.log(`${a.size} keys (${results} results) vs ${b.size} keys: ${differing.length} differ`);
  const bySection = new Map<string, number>();
  for (const key of differing) bySection.set(key.split("/")[0]!, (bySection.get(key.split("/")[0]!) ?? 0) + 1);
  for (const [section, count] of bySection) console.log(`  ${section}: ${count}`);
  for (const key of differing.slice(0, 40)) console.log(`    ${key}`);
  process.exit(differing.length ? 1 : 0);
}

const [exe, inputs, output, ...only] = process.argv.slice(2);
if (!exe || !inputs || !output)
  throw new Error("usage: run.ts <bun executable> <inputs dir> <output file> [section...]");

// A fixed environment: the default locale and time zone are inputs of many of these APIs.
// ICU_DATA is passed on: a build whose own package is empty reads the one there, which tries out data without a link.
const env: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TZ: "UTC",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
};
for (const name of ["ICU_DATA", "BUN_ICU_TRACE"]) if (process.env[name]) env[name] = process.env[name];

const capture = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0
        ? resolve(Buffer.concat(out).toString())
        : reject(
            new Error(`${args.slice(2).join(" ")}: ${code ?? signal}\n${Buffer.concat(err).toString().slice(0, 2000)}`),
          ),
    );
  });

const sections = only.length ? only : (await capture([oracle, inputs, "--list"])).trim().split("\n");
const workers = availableParallelism();
// More shards than workers, so that one slow shard does not decide when a section ends.
const shards = workers * 4;
const tasks = sections.flatMap(section => Array.from({ length: shards }, (_, shard) => [section, shard] as const));

const started = performance.now();
const lines: string[] = [];
const seconds = new Map<string, number>();
let next = 0;
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (next < tasks.length) {
      const [section, shard] = tasks[next++]!;
      const t = performance.now();
      const text = await capture([oracle, inputs, section, String(shard), String(shards)]);
      seconds.set(section, (seconds.get(section) ?? 0) + (performance.now() - t) / 1000);
      for (const line of text.split("\n")) if (line) lines.push(line);
    }
  }),
);
lines.sort();
writeFileSync(output, lines.join("\n") + "\n");
const results = lines.reduce((sum, l) => sum + Number(l.split("\t")[1]), 0);
console.log(`${lines.length} keys, ${results} results, ${((performance.now() - started) / 1000).toFixed(0)}s wall`);
for (const [section, s] of seconds) console.log(`  ${section.padEnd(22)} ${s.toFixed(0).padStart(6)} cpu-s`);
