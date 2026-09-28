// Fills ICU's cache of shared objects until it evicts, with objects in it that refer to other objects in it:
// the shared number format of a locale, once it has formatted a few numbers, refers to the locale's number data.
// Deleting the one lets go of the other, which takes the cache's mutex. Hangs if the cache still holds it.
//
// usage: ICU_DATA=<dir> eviction <threads>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

#include "unicode/uclean.h"
#include "unicode/udat.h"
#include "unicode/uloc.h"
#include "unicode/ureldatefmt.h"

static bool run(unsigned long long& hash, int& formatted) {
  for (int round = 0; round < 3; round++) {
    for (int32_t i = 0; i < uloc_countAvailable(); i++) {
      const char* locale = uloc_getAvailable(i);
      UErrorCode status = U_ZERO_ERROR;
      // Without a number format of its own it uses the shared one.
      URelativeDateTimeFormatter* relative =
        ureldatefmt_open(locale, nullptr, UDAT_STYLE_LONG, UDISPCTX_CAPITALIZATION_NONE, &status);
      for (int n = 1; n <= 5; n++) {
        char16_t buffer[200];
        int32_t length = ureldatefmt_formatNumeric(relative, -1000.5 * n, UDAT_REL_UNIT_DAY, buffer, 200, &status);
        if (U_FAILURE(status)) {
          fprintf(stderr, "%s: %s\n", locale, u_errorName(status));
          return false;
        }
        for (int32_t k = 0; k < length; k++) hash = (hash ^ buffer[k]) * 0x100000001b3ull;
        formatted++;
      }
      ureldatefmt_close(relative);
      UDateFormat* date = udat_open(UDAT_FULL, UDAT_FULL, locale, u"UTC", 3, nullptr, 0, &status);
      udat_close(date);
    }
  }
  return true;
}

int main(int argc, char** argv) {
  int count = argc > 1 ? atoi(argv[1]) : 1;
  std::vector<unsigned long long> hashes(count, 0xcbf29ce484222325ull);
  std::vector<int> formatted(count, 0);
  std::vector<char> ok(count, 0);
  std::vector<std::thread> threads;
  for (int t = 0; t < count; t++) threads.emplace_back([&, t] { ok[t] = run(hashes[t], formatted[t]); });
  for (auto& thread : threads) thread.join();
  // Wipes out the cache, with the same objects in it.
  u_cleanup();
  for (int t = 0; t < count; t++) {
    if (!ok[t] || hashes[t] != hashes[0] || formatted[t] == 0) {
      printf("thread %d DIFFERS\n", t);
      return 1;
    }
  }
  printf("%d threads, %d formatted each: all agree %016llx\n", count, formatted[0], hashes[0]);
}
