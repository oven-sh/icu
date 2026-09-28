// Is reading resource bundles safe from many threads at once?
//
// What is different from ICU there: a string is written out in UTF-16 when it is first asked for, bundles no longer
// count their users under a mutex, and Locale::getDefault() takes no mutex. So the threads here meet at a barrier before
// each bundle and then all read all of it for the first time at the same time. Each hashes what it reads. The hashes have
// to agree with each other, with one thread's, and with those from a package in ICU's own format.
//
// Meant to be built with -fsanitize=thread, ICU included: agreement alone was seen to hold with a race in the code.
//
//   threads <number of threads> < bundles.txt      with ICU_DATA=<directory of icudt<version>l.dat>

#include <atomic>
#include <barrier>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "unicode/udat.h"
#include "unicode/uldnames.h"
#include "unicode/uloc.h"
#include "unicode/unumberformatter.h"
#include "unicode/ures.h"
#include "unicode/ustring.h"

using Hash = unsigned long long;

static void mix(Hash& hash, const void* bytes, size_t length) {
  for (size_t i = 0; i < length; i++) hash = (hash ^ static_cast<const unsigned char*>(bytes)[i]) * 1099511628211ULL;
}

static void walk(UResourceBundle* bundle, Hash& hash, int depth) {
  UErrorCode status = U_ZERO_ERROR;
  UResType type = ures_getType(bundle);
  if (type == URES_STRING) {
    int32_t length;
    const char16_t* s = ures_getString(bundle, &length, &status);
    if (U_FAILURE(status)) return;
    if (s[length] != 0 || u_strlen(s) != length) {
      fprintf(stderr, "a string is not whole\n");
      abort();
    }
    mix(hash, &length, sizeof length);
    mix(hash, s, length * 2);
    return;
  }
  if ((type != URES_TABLE && type != URES_ARRAY) || depth > 10) return;
  ures_resetIterator(bundle);
  while (ures_hasNext(bundle)) {
    status = U_ZERO_ERROR;
    UResourceBundle* item = ures_getNextResource(bundle, nullptr, &status);
    if (U_SUCCESS(status)) {
      if (const char* key = ures_getKey(item)) mix(hash, key, strlen(key));
      walk(item, hash, depth + 1);
    }
    ures_close(item);
  }
}

// What reads bundles the way ICU's own code does, with fallback and caches of its own.
static void format(const char* locale, Hash& hash) {
  char16_t buffer[256];
  UErrorCode status = U_ZERO_ERROR;
  UNumberFormatter* number = unumf_openForSkeletonAndLocale(u"currency/EUR unit-width-full-name", -1, locale, &status);
  UFormattedNumber* result = unumf_openResult(&status);
  unumf_formatDouble(number, 1234.5, result, &status);
  int32_t length = unumf_resultToString(result, buffer, 256, &status);
  if (U_SUCCESS(status)) mix(hash, buffer, length * 2);
  unumf_closeResult(result);
  unumf_close(number);

  status = U_ZERO_ERROR;
  UDateFormat* date = udat_open(UDAT_FULL, UDAT_FULL, locale, u"Europe/Paris", -1, nullptr, 0, &status);
  length = udat_format(date, 0, buffer, 256, nullptr, &status);
  if (U_SUCCESS(status)) mix(hash, buffer, length * 2);
  udat_close(date);

  status = U_ZERO_ERROR;
  ULocaleDisplayNames* names = uldn_open(locale, ULDN_STANDARD_NAMES, &status);
  length = uldn_localeDisplayName(names, "fr_CA", buffer, 256, &status);
  if (U_SUCCESS(status)) mix(hash, buffer, length * 2);
  uldn_close(names);

  mix(hash, uloc_getDefault(), 2);
}

int main(int, char** argv) {
  int count = atoi(argv[1]);
  std::vector<std::pair<std::string, std::string>> bundles;
  for (std::string tree, name; std::cin >> tree >> name;) bundles.push_back({tree, name});

  std::vector<Hash> hashes(count, 1469598103934665603ULL);
  std::atomic<long> missing{0};
  std::barrier together(count);
  std::vector<std::thread> threads;
  for (int t = 0; t < count; t++) {
    threads.emplace_back([&, t] {
      for (auto& [tree, name] : bundles) {
        together.arrive_and_wait();
        UErrorCode status = U_ZERO_ERROR;
        std::string package = "icudt" U_ICU_VERSION_SHORT "l-" + tree;
        UResourceBundle* bundle = ures_open(tree == "-" ? nullptr : package.c_str(), name.c_str(), &status);
        if (U_SUCCESS(status)) walk(bundle, hashes[t], 0);
        else missing++;
        ures_close(bundle);
        if (tree == "-") format(name.c_str(), hashes[t]);
      }
    });
  }
  for (auto& thread : threads) thread.join();

  bool agree = true;
  for (Hash hash : hashes) agree = agree && hash == hashes[0];
  printf("%d threads, %zu bundles: %s %016llx\n", count, bundles.size(), agree ? "all agree" : "THREADS DISAGREE", hashes[0]);
  // Threads that read nothing agree.
  if (bundles.empty() || missing != 0) printf("%ld times a bundle could not be opened\n", missing.load());
  return agree && !bundles.empty() && missing == 0 ? 0 : 1;
}
