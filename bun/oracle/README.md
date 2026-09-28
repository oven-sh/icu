# The oracle

Answers one question: do two builds of Bun behave the same wherever ICU is involved?

It exists for changes to ICU itself or to what `../data/icu-data.ts` leaves out of its data, where the expected
result is that nothing observable changes. It calls the ICU-backed APIs (`Intl.*`, `Temporal`, `Date`, `String`
normalization and casing, the lexer's identifier rules, IDNA, `Bun.stringWidth`, `URLPattern`) with every locale the
data has and the options that are known to select different data, and hashes what comes back per section and subject.
It is as good as what it asks: when a change is about something in particular, see whether that is asked.

```sh
bun prepare.ts ../.. /tmp/in                          # inputs, derived from ICU's sources
bun run.ts <bun before> /tmp/in /tmp/before.txt       # 80 s on 32 cores
bun run.ts <bun after>  /tmp/in /tmp/after.txt
bun run.ts --compare /tmp/before.txt /tmp/after.txt   # exits 1 and names the keys that differ

<bun> oracle.js /tmp/in <section> 0 1 --dump <key>    # what is behind a key, to diff
```

`test262.ts` does the same with test262's `intl402` tests, which someone else wrote: it compares each test's outcome,
so a test that fails under both builds is not a difference.

`bench.ts` compares builds on what the representation of the data can change: the first use of an API in a new
process, the same once warm, and the memory left behind. `bench-warm.js` times some ninety things once all has been
used before. Times of what allocates differ by 10% and more between two runs of one build, so it also runs one thing
a given number of times, for `perf stat` to count instructions or cycles: with two numbers of times, the difference
is what the calls took. One build against itself then stays within 2%. `bench-collation.js` times comparisons of text in a dozen
scripts (`<bun> bench-collation.js en,de,zh,ja,ko,th`, pinned to a core, builds taking turns, fastest of three).

`surrogates.js` compares every supplementary code point and every unpaired surrogate with pivots under 35 collators
and prints a hash for each, to compare between builds. Collation looks up UTF-16 code units, and lead surrogates are
where a code unit is not a code point.

## What a pass means

That nothing asked here changed. Two things keep that from being hollow:

- **The inputs come from the data.** `prepare.ts` reads ICU's sources for the locales, currency, language, script and
  region codes, time zones and the periods each spent in a metazone, alias tables, every string a collation tailoring
  mentions, and every word in the break dictionaries.
- **It has been seen to fail.** Removing single items from the data (a dictionary, one locale's bundle, `plurals.res`,
  the Greek sentence rules) is noticed. When adding a section, remove something it should depend on and check.

`refused` asks for what ECMA-402 rejects before ICU is reached: units that are not sanctioned, weekdays as relative
time units, extension keys in display names. Data is left out on the grounds that these are rejected.

## Below JavaScript

This ICU reads data in forms of its own (`../README.md`). What is here so far asks whether Bun still behaves the same.
The programs in `native/` ask whether ICU still reads the same data, of all of it rather than of what JavaScript
reaches, and each says at its top what it is for. They link with a build of ICU by its own makefiles:

```sh
icu=../../icu4c/source; build=<a build directory: configure --enable-static && make>
c++ -std=c++20 -O2 -DU_STATIC_IMPLEMENTATION -I$icu/common -I$icu/i18n native/resources.cpp \
  $build/lib/libicui18n.a $build/lib/libicuuc.a $build/stubdata/libicudata.a -lpthread -o resources
```

`stubdata` has no data, so `ICU_DATA` names the directory of a package to read, called `icudt<version>l.dat`: one that
`../data/icu-data.ts` wrote (`LD_LIBRARY_PATH=$build/lib node ../data/icu-data.ts --tools $build/bin …`), and for
comparison one that it wrote with `--uncompacted`. The list of bundles on stdin is
the `.res` files in the `--work` directory of the latter, as `curr de_AT`, or `- de_AT` for the tree that has no
directory.

- `resources.cpp`: every resource of every bundle, by index, by key, through `ResourceValue` and through `ures.h`.
- `threads.cpp`: the same from many threads at once. Build it and ICU with `-fsanitize=thread` (`configure` with
  `CFLAGS`, `CXXFLAGS` and `LDFLAGS`): with a race in how strings were written out, every thread still read the right
  strings, and ThreadSanitizer had 82 reports.
- `eviction.cpp`: fills ICU's cache of shared objects until it evicts, from many threads. What is kept in that cache
  here is referred to by other things in it, and deleting those with the cache's mutex held hung. Run it with a
  timeout. `eviction.js` is the same idea in one long-lived Bun, but JavaScriptCore does not use ICU in the way that
  hung.

This ICU also does less work than ICU to reach the same answers. Two programs ask whether they are the same answers.
They use nothing but the C API, so one binary runs with the shared libraries of the unchanged release and with those
of this branch, and the outputs are to be identical:

```sh
c++ -std=c++20 -O2 -I$icu/common -I$icu/i18n native/api.cpp -L<unchanged>/lib -licui18n -licuuc -licudata -o api
LD_LIBRARY_PATH=<unchanged>/lib ./api > unchanged.txt; LD_LIBRARY_PATH=<this>/lib ./api > this.txt
```

- `api.cpp` calls the C API for every locale and time zone and prints each result with the status it left. A status is
  part of the answer. Looking something up leaves a warning in it, such as that the locale fell back to root, and may
  clear the one that was there; not looking it up does neither. Nothing JavaScript can see depends on that, which is
  why nothing above notices. Run it under several default locales too (`LC_ALL=ar_SA.UTF-8`): what
  `ucal_setGregorianChange` leaves depends on that.
- `sortkeys.cpp` hashes the sort key of every code point under every collator.

**ICU's own tests** are the other half: `make -C test`, then `test/intltest/intltest` and `test/cintltst/cintltst`.
They read the data ICU's makefiles built, which is in ICU's forms but for collation. To have them read the others:

```sh
node reencode.ts $build/data/out/build/icudt<version>l <directory>/icudt<version>l
ICU_DATA=<directory> test/intltest/intltest
```

Put the wrong tree's `pool.res` in one place and see the tests fail, or they may not be reading it. Run them after
every change, with a timeout: the hang that `eviction.cpp` is for passed everything else here, ThreadSanitizer
included, and showed only after `intltest` had filled the cache.

ICU's makefiles do not track headers. After changing one, delete `common/*.o` and `i18n/*.o`: a stale object that has
a `ResourceTable` of another size on its stack does not fail where the mistake is.

## Trying data without linking

ICU reads `$ICU_DATA/icudt<version>l.dat` for what its built-in package lacks. A copy of a build whose built-in package
claims to have no items (its count is the `uint32` after the package's header) therefore takes all of its data from
there, and `run.ts` passes `ICU_DATA` on.

## What does not establish that data is unreachable

Learned the hard way; each of these named data as unused that was not.

- **ICU's resource tracing** (`U_ENABLE_TRACING`) does not see string arrays: month and weekday names look unread.
- **A key's absence from the executable.** Keys are put together at run time (`"units"` + `"Short"`).
- **An item never being opened while this runs.** `uemoji.icu` was not, until `Bun.stringWidth` was added here.
- **A missing symbol in an LTO build.** It may have been inlined. Look at call sites in a build without LTO.
