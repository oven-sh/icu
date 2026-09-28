// Does every collator still order every code point the same?
//
// For each locale that has collation data and each collation type it has, hashes the sort key of every code point:
// alone, before a letter and after one, with normalization off and on. Prints a hash per collator.
// Only the C API, so that one binary runs with the libraries of unchanged ICU and with those of this one:
// the two outputs are to be identical.
//
//   LD_LIBRARY_PATH=<build>/lib sortkeys [threads] > out.txt

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "unicode/ucol.h"
#include "unicode/uenum.h"
#include "unicode/uloc.h"
#include "unicode/utf16.h"

static uint64_t mix(uint64_t hash, const uint8_t *bytes, int32_t length) {
    for (int32_t i = 0; i < length; ++i) { hash = (hash ^ bytes[i]) * 1099511628211u; }
    return (hash ^ 0xff) * 1099511628211u;
}

static std::string hashOf(const std::string &locale) {
    UErrorCode status = U_ZERO_ERROR;
    UCollator *collator = ucol_open(locale.c_str(), &status);
    if (U_FAILURE(status)) { return u_errorName(status); }
    std::string opened = u_errorName(status);
    uint64_t hash = 14695981039346656037u;
    std::vector<uint8_t> key(256);
    for (UColAttributeValue normalization : { UCOL_OFF, UCOL_ON }) {
        ucol_setAttribute(collator, UCOL_NORMALIZATION_MODE, normalization, &status);
        for (UChar32 c = 1; c <= 0x10ffff; ++c) {
            // As UTF-16 code units, so unpaired surrogates too.
            char16_t text[4];
            int32_t length = 0;
            text[length++] = u'a';
            U16_APPEND_UNSAFE(text, length, c);
            text[length++] = u'a';
            const struct { int32_t start, limit; } parts[] = { { 1, length - 1 }, { 0, length - 1 }, { 1, length } };
            for (auto part : parts) {
                int32_t size = ucol_getSortKey(collator, text + part.start, part.limit - part.start, key.data(), static_cast<int32_t>(key.size()));
                if (size > static_cast<int32_t>(key.size())) {
                    key.resize(size);
                    size = ucol_getSortKey(collator, text + part.start, part.limit - part.start, key.data(), size);
                }
                hash = mix(hash, key.data(), size);
            }
        }
    }
    ucol_close(collator);
    char result[64];
    snprintf(result, sizeof(result), "%016llx %s", static_cast<unsigned long long>(hash), opened.c_str());
    return result;
}

int main(int argc, char **argv) {
    std::vector<std::string> locales { "root" };
    for (int32_t i = 0; i < ucol_countAvailable(); ++i) { locales.push_back(ucol_getAvailable(i)); }
    for (size_t i = 0, n = locales.size(); i < n; ++i) {
        UErrorCode status = U_ZERO_ERROR;
        UEnumeration *types = ucol_getKeywordValuesForLocale("collation", locales[i].c_str(), false, &status);
        while (const char *type = uenum_next(types, nullptr, &status)) { locales.push_back(locales[i] + "@collation=" + type); }
        uenum_close(types);
    }
    std::sort(locales.begin(), locales.end());

    std::vector<std::string> results(locales.size());
    std::atomic<size_t> next { 0 };
    std::vector<std::thread> threads;
    for (int i = 0, n = argc > 1 ? atoi(argv[1]) : static_cast<int>(std::thread::hardware_concurrency()); i < n; ++i) {
        threads.emplace_back([&] {
            for (size_t k; (k = next++) < locales.size();) { results[k] = hashOf(locales[k]); }
        });
    }
    for (auto &thread : threads) { thread.join(); }
    for (size_t k = 0; k < locales.size(); ++k) { printf("%s\t%s\n", locales[k].c_str(), results[k].c_str()); }
    return 0;
}
