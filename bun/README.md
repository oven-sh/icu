# Bun's ICU

`bun-release-<version>` is ICU's `release-<version>` with the changes Bun ships on top. `main` mirrors
unicode-org/icu and has none of them. Everything that is not a change to ICU's own files is in this directory.

macOS is not concerned: there Bun uses the system's ICU.

## What is different

**It reads its largest data in smaller forms**, in place, with nothing decompressed. The C API is meant to return what
ICU's returns, status codes included; where it is known not to is below. Each form is specified where it is read:

| data | form | specified in | written by |
| ---- | ---- | ------------ | ---------- |
| resource bundles of the locale trees | formatVersion 4: one archive per tree, shared key sets, strings in sequence, text as one or two bytes per letter or phrase of the language | `common/uresdata.h` | `data/icu-res.ts` |
| the Chinese and Japanese break dictionary | a trie in level order, without pointers | `common/dictionarydata.h` | `data/icu-dict.ts` |
| collation tailorings | formatVersion 6: a sparse table of what they map, without copies of the root's mappings | `i18n/collationmappings.h` | genrb |

Resource bundles and dictionaries in ICU's forms are still read, and the root collation data is ICU's.

What is not read in place:

- A string of a formatVersion 4 bundle is written out in UTF-16 on the heap the first time it is asked for, and stays.
  ICU's API hands out `const char16_t *`, and ICU keeps them. Reading every string of the package leaves 23 MB.
- A tailoring that is opened gets 3 kB of tables that say where things are (`CollationMappings::bmpBlocks`,
  `CollationData::latin1CE32s`).

**It does not count who uses a resource bundle.** Every `UResourceBundle` counted itself in and out of its cache entry,
and its parents', under a mutex, though nothing but `u_cleanup()` ever acted on the count. Entries stay until then
without being counted. Reading a bundle of formatVersion 4 takes longer than reading ICU's, and this takes more off.

**It can leave code out.** `UCONFIG_NO_PARSING` and `UCONFIG_NO_UNIT_CONVERSION` (`common/unicode/uconfig.h`), off
unless a build defines them.

## Known differences from ICU

- Tailorings in ICU's form (formatVersion 5), such as `ucol_cloneBinary()` of ICU wrote, are refused, with
  `U_INVALID_FORMAT_ERROR`. `ucol_swap()` swaps both.
- A file with the name of a bundle that is inside an archive does not take its place, as it does an item of a package.
  The files of a time zone update (`ICU_TIMEZONE_FILES_DIR`) do.
- With `genrb --omitCollationRules`, `ucol_getRules()` returns a space for a tailoring rather than nothing.
- Building a collator from rules (`ucol_openRules()`) takes 2 to 11 times as long, for making the sparse table.
- `RuleBasedCollator::hashCode()` of a tailoring is another number: it goes by CE32s, which are indexes.
- A resource bundle that is still open when `u_cleanup()` is called refers to memory that has been freed.
  In ICU its entry leaked instead.
- A process reads at most 128 archives, counting one for each spelling of a path.

## The data

`data/icu-data.ts` builds the package Bun ships from ICU's text sources, with ICU's own compilers. It says at its top
how to run it, and next to each thing it leaves out why nothing in Bun can reach it. It took 9 seconds on 32 cores.

| the data of ICU 78.3, bytes | |
| --- | --- |
| all of it, as ICU builds it | 33,107,232 |
| what Bun can reach, as this ICU's tools write it (`--uncompacted`) | 17,990,848 |
| the same, as packaged | 8,353,040 |

`icu-res.ts` and `icu-dict.ts` read back what they wrote, with a reader of their own, and compare it with what genrb
and gendict wrote before they return. That the runtime reads the same is what `oracle/native/resources.cpp` is for.

`configure && make` still works and still builds all of ICU's data, in ICU's forms but for tailorings. That is what
ICU's tests run on.

## Checking a change

`oracle/README.md`. In short: ICU's `intltest` and `cintltst`, on the data as its makefiles build it and again with
`oracle/reencode.ts`; `oracle/native/` against a build of the unchanged release; `oracle/run.ts` on two builds of Bun.

## Moving to another release of ICU

Branch from its tag and bring the commits over. `data/icu-data.ts` was written for one release, so it fails rather than
leave something out, or in, by accident: on a rule that finds nothing to apply to, a key it leaves out for being named
nowhere in ICU4C that now is, a file or directory under `data/` that it has not heard of, a numbering system whose
rules are in a bundle it does not build, a unit ECMA-402 sanctions that the data lacks, a dictionary it has no options
for. What it cannot check is what it calls unlinked and refused: that goes by what JavaScriptCore and Bun call.
