// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

/*
 * oven-sh/icu
 *
 * convuca in.icu out.icu
 *
 * ICU's source has the root collator's data as binary files (data/in/coll/ucadata-*.icu, made by genuca,
 * which is not part of ICU4C), with a UTrie2 in them. Here the root collator's data has a UCPTrie,
 * see collationdatareader.h. This puts one in the place of the other. Everything else in the file stays as it is.
 *
 * data/in/coll/ucadata-unihan.icu and ucadata-implicithan.icu here are what this made of ICU's.
 * No build runs it: it is for when ICU's files change. After make -C stubdata, common and i18n in a build directory,
 *
 *   c++ -std=c++17 -I<source>/common -I<source>/i18n <source>/tools/convuca/convuca.cpp -Llib -Lstubdata \
 *       -licui18n -licuuc -licudata -o convuca
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include "unicode/utypes.h"
#include "unicode/localpointer.h"
#include "unicode/ucptrie.h"
#include "collationdatabuilder.h"
#include "collationdatareader.h"
#include "utrie2.h"

using icu::CollationDataBuilder;
using icu::CollationDataReader;

static void die(const char *what, const char *name) {
    fprintf(stderr, "convuca: %s %s\n", what, name);
    exit(1);
}

int main(int argc, char *argv[]) {
    if (argc != 3) { die("usage:", "convuca in.icu out.icu"); }
    FILE *f = fopen(argv[1], "rb");
    if (f == nullptr) { die("cannot open", argv[1]); }
    std::vector<uint8_t> in;
    uint8_t buffer[65536];
    for (size_t n; (n = fread(buffer, 1, sizeof(buffer), f)) > 0;) { in.insert(in.end(), buffer, buffer + n); }
    fclose(f);

    // DataHeader: uint16_t headerSize, then among others char dataFormat[4] at 12.
    if (in.size() < 24 || memcmp(&in[12], "UCol", 4) != 0) { die("not collation data:", argv[1]); }
    uint16_t headerSize;
    memcpy(&headerSize, &in[0], 2);
    int32_t *indexes = reinterpret_cast<int32_t *>(&in[headerSize]);
    if (indexes[CollationDataReader::IX_INDEXES_LENGTH] <= CollationDataReader::IX_TOTAL_SIZE) {
        die("too few indexes in", argv[1]);
    }
    int32_t start = indexes[CollationDataReader::IX_TRIE_OFFSET];
    int32_t limit = indexes[CollationDataReader::IX_TRIE_OFFSET + 1];

    UErrorCode errorCode = U_ZERO_ERROR;
    UTrie2 *trie2 = utrie2_openFromSerialized(
        UTRIE2_32_VALUE_BITS, &in[headerSize + start], limit - start, nullptr, &errorCode);
    icu::LocalUCPTriePointer trie(CollationDataBuilder::toCodePointTrie(trie2, errorCode));
    utrie2_close(trie2);
    if (U_FAILURE(errorCode)) { die(u_errorName(errorCode), argv[1]); }
    // Room for the padding that keeps what follows at a multiple of 8, as CollationDataWriter does.
    std::vector<uint8_t> bytes(ucptrie_toBinary(trie.getAlias(), nullptr, 0, &errorCode) + 7 & ~7);
    errorCode = U_ZERO_ERROR;
    ucptrie_toBinary(trie.getAlias(), bytes.data(), static_cast<int32_t>(bytes.size()), &errorCode);
    if (U_FAILURE(errorCode)) { die(u_errorName(errorCode), argv[1]); }

    int32_t delta = static_cast<int32_t>(bytes.size()) - (limit - start);
    for (int32_t i = CollationDataReader::IX_TRIE_OFFSET + 1; i <= CollationDataReader::IX_TOTAL_SIZE; ++i) {
        indexes[i] += delta;
    }

    f = fopen(argv[2], "wb");
    if (f == nullptr) { die("cannot write", argv[2]); }
    size_t head = headerSize + start, tail = headerSize + limit;
    if (fwrite(in.data(), 1, head, f) != head || fwrite(bytes.data(), 1, bytes.size(), f) != bytes.size() ||
            fwrite(in.data() + tail, 1, in.size() - tail, f) != in.size() - tail || fclose(f) != 0) {
        die("cannot write", argv[2]);
    }
    return 0;
}
