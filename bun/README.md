# Bun's ICU

`bun-release-<version>` is ICU's `release-<version>` with the changes Bun ships on top. `main` mirrors
unicode-org/icu and has none of them. Everything that is not a change to ICU's own files is in this directory.

macOS is not concerned: there Bun uses the system's ICU.

## What is different

**It does less work to reach the same answers.** What a process pays for once (likely subtags, language and region
codes, time zone tables) and what every formatter paid for again (its locale's number symbols and patterns, a copy of
the date symbols) is decoded directly, looked up by hash, or read once and shared. The C API returns what ICU's
returns, status codes included.

**It reads its largest data in smaller forms**, in place, with nothing decompressed. Each is specified where it is read:

| data | form | specified in | written by |
| ---- | ---- | ------------ | ---------- |
| resource bundles of the locale trees | formatVersion 4: one archive per tree, shared key sets, strings in sequence, text as one or two bytes per letter or phrase of the language | `common/uresdata.h` | `data/icu-res.ts` |
| the Chinese and Japanese break dictionary | a trie in level order, without pointers | `common/dictionarydata.h` | `data/icu-dict.ts` |
| collation tailorings | a sparse table of what they map, without copies of the root's mappings | `i18n/collationmappings.h` | genrb |
| the root collator's mappings | a `UCPTrie` in place of a `UTrie2` | `i18n/collationdatareader.h` | `tools/convuca`, once |

Resource bundles and dictionaries in ICU's forms are still read. Collation data in ICU's form is not.

The one thing that is not read in place is a string of a formatVersion 4 bundle, which is written out in UTF-16 on the
heap the first time it is asked for, and stays.

**It can leave code out.** `UCONFIG_NO_PARSING` and `UCONFIG_NO_UNIT_CONVERSION` (`common/unicode/uconfig.h`), off
unless a build defines them.

## The data

`data/icu-data.ts` builds the package Bun ships from ICU's text sources, with ICU's own compilers. It says at its top
how to run it, and next to each thing it leaves out why nothing in Bun can reach it. It took 9 seconds on 32 cores.

| the data of ICU 78.3, bytes | |
| --- | --- |
| all of it, as ICU builds it | 33,107,232 |
| what Bun can reach, in ICU's forms (`--uncompacted`) | 17,937,744 |
| the same, as packaged | 8,232,880 |

Each writer reads back what it wrote and compares before it returns, so a package that exists holds what its sources
say.

`configure && make` still works and still builds all of ICU's data, in ICU's forms but for collation. That is what
ICU's tests run on.

## Checking a change

`oracle/README.md`. In short: ICU's `intltest` and `cintltst`, on the data as its makefiles build it and again with
`oracle/reencode.ts`; `oracle/native/` against a build of the unchanged release; `oracle/run.ts` on two builds of Bun.

## Moving to another release of ICU

Branch from its tag and bring the commits over. Then run `tools/convuca` on the new
`icu4c/source/data/in/coll/ucadata-unihan.icu` and `ucadata-implicithan.icu` and commit what it writes in their place:
until then no collator opens. `data/icu-data.ts` fails, rather than leaving something out, where the new data no longer
matches what it assumes: a numbering system whose rules are in a bundle it does not build, a unit ECMA-402 sanctions
that the data lacks, a dictionary it has no options for.
