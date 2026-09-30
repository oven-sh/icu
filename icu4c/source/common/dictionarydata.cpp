// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2014-2016, International Business Machines
* Corporation and others.  All Rights Reserved.
*******************************************************************************
* dictionarydata.h
*
* created on: 2012may31
* created by: Markus W. Scherer & Maxime Serrano
*/

#include "dictionarydata.h"
#include "unicode/ucharstrie.h"
#include "unicode/bytestrie.h"
#include "unicode/udata.h"
#include "cmemory.h"

#if !UCONFIG_NO_BREAK_ITERATION

U_NAMESPACE_BEGIN

const int32_t  DictionaryData::TRIE_TYPE_BYTES = 0;
const int32_t  DictionaryData::TRIE_TYPE_UCHARS = 1;
const int32_t  DictionaryData::TRIE_TYPE_SUCCINCT = 2;
const int32_t  DictionaryData::TRIE_TYPE_MASK = 7;
const int32_t  DictionaryData::TRIE_HAS_VALUES = 8;

const int32_t  DictionaryData::TRANSFORM_NONE = 0;
const int32_t  DictionaryData::TRANSFORM_TYPE_OFFSET = 0x1000000;
const int32_t  DictionaryData::TRANSFORM_TYPE_MASK = 0x7f000000;
const int32_t  DictionaryData::TRANSFORM_OFFSET_MASK = 0x1fffff;
    
DictionaryMatcher::~DictionaryMatcher() {
}

UCharsDictionaryMatcher::~UCharsDictionaryMatcher() {
    udata_close(file);
}

int32_t UCharsDictionaryMatcher::getType() const {
    return DictionaryData::TRIE_TYPE_UCHARS;
}

int32_t UCharsDictionaryMatcher::matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const {

    UCharsTrie uct(characters);
    int32_t startingTextIndex = static_cast<int32_t>(utext_getNativeIndex(text));
    int32_t wordCount = 0;
    int32_t codePointsMatched = 0;

    for (UChar32 c = utext_next32(text); c >= 0; c=utext_next32(text)) {
        UStringTrieResult result = (codePointsMatched == 0) ? uct.first(c) : uct.next(c);
        int32_t lengthMatched = static_cast<int32_t>(utext_getNativeIndex(text)) - startingTextIndex;
        codePointsMatched += 1;
        if (USTRINGTRIE_HAS_VALUE(result)) {
            if (wordCount < limit) {
                if (values != nullptr) {
                    values[wordCount] = uct.getValue();
                }
                if (lengths != nullptr) {
                    lengths[wordCount] = lengthMatched;
                }
                if (cpLengths != nullptr) {
                    cpLengths[wordCount] = codePointsMatched;
                }
                ++wordCount;
            }
            if (result == USTRINGTRIE_FINAL_VALUE) {
                break;
            }
        }
        else if (result == USTRINGTRIE_NO_MATCH) {
            break;
        }
        if (lengthMatched >= maxLength) {
            break;
        }
    }

    if (prefix != nullptr) {
        *prefix = codePointsMatched;
    }
    return wordCount;
}

namespace {

inline int32_t countBits(uint64_t x) {
#if defined(__GNUC__) || defined(__clang__)
    return __builtin_popcountll(x);
#else
    x = x - ((x >> 1) & 0x5555555555555555);
    x = (x & 0x3333333333333333) + ((x >> 2) & 0x3333333333333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f;
    return static_cast<int32_t>((x * 0x0101010101010101) >> 56);
#endif
}

/** @param x not 0 */
inline int32_t lowestBit(uint64_t x) {
#if defined(__GNUC__) || defined(__clang__)
    return __builtin_ctzll(x);
#else
    return countBits((x & (0 - x)) - 1);
#endif
}

/** The index of the i-th of the set bits of x, of which there are more than i. */
inline int32_t selectBit(uint64_t x, int32_t i) {
    while (i-- > 0) { x &= x - 1; }
    return lowestBit(x);
}

inline uint64_t bitsBelow(int32_t i) { return (uint64_t{1} << i) - 1; }

inline uint64_t load64(const uint8_t *p) {
    uint64_t x;
    uprv_memcpy(&x, p, 8);
    return x;
}

}  // namespace

SuccinctDictionaryMatcher::SuccinctDictionaryMatcher(const uint8_t *data, UDataMemory *f) : file(f) {
    const int32_t *header = reinterpret_cast<const int32_t *>(data);
    singles = header[1];
    unitIndex = reinterpret_cast<const uint16_t *>(data + header[2]);
    unitBlocks = reinterpret_cast<const uint16_t *>(data + header[3]);
    labels = data + header[4];
    blocks = reinterpret_cast<const Block *>(data + header[5]);
    wordValues = data + header[6];
    starts = reinterpret_cast<const uint32_t *>(data + header[7]);
}

SuccinctDictionaryMatcher::~SuccinctDictionaryMatcher() {
    udata_close(file);
}

int32_t SuccinctDictionaryMatcher::getType() const {
    return DictionaryData::TRIE_TYPE_SUCCINCT;
}

int32_t SuccinctDictionaryMatcher::find(int32_t first, uint32_t label) const {
    int32_t block = first >> 6;
    uint64_t bits = blocks[block].isLast >> (first & 63);
    int32_t length;
    if (bits != 0) {
        length = lowestBit(bits) + 1;
    } else {
        do { bits = blocks[++block].isLast; } while (bits == 0);
        length = (block << 6) + lowestBit(bits) + 1 - first;
    }
    const uint8_t *p = labels + first;
    if (length >= 32) {
        int32_t word = static_cast<int32_t>(label >> 6);
        bits = load64(p + (word << 3));
        if (((bits >> (label & 63)) & 1) == 0) { return -1; }
        first += countBits(bits & bitsBelow(label & 63));
        while (word > 0) { first += countBits(load64(p + (--word << 3))); }
        return first;
    }
    // 8 at a time. The lowest byte of x that is 0 is a label that is the same; what is above it may be wrong, and is not looked at.
    uint64_t same = label * 0x0101010101010101u;
    for (int32_t i = 0; i < length; i += 8) {
        uint64_t x = load64(p + i) ^ same;
        x = (x - 0x0101010101010101u) & ~x & 0x8080808080808080u;
        if (x != 0) {
            i += lowestBit(x) >> 3;
            return i < length ? first + i : -1;
        }
    }
    return -1;
}

int32_t SuccinctDictionaryMatcher::firstChild(int32_t node) const {
    const Block &b = blocks[node >> 6];
    // As many groups after the one that the block knows of as there are nodes with children before this one.
    int32_t groups = countBits(b.hasChildren & bitsBelow(node & 63));
    int32_t child = static_cast<int32_t>(b.firstChild);
    if (groups == 0) { return child; }
    int32_t block = child >> 6;
    uint64_t bits = blocks[block].isLast & ~bitsBelow(child & 63);
    for (int32_t count; (count = countBits(bits)) < groups; bits = blocks[++block].isLast) { groups -= count; }
    return (block << 6) + selectBit(bits, groups - 1) + 1;
}

int32_t SuccinctDictionaryMatcher::matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const {
    int32_t startingTextIndex = static_cast<int32_t>(utext_getNativeIndex(text));
    int32_t wordCount = 0;
    int32_t codePointsMatched = 0;
    // The group that the first byte of the next character is looked for in.
    int32_t first = 0;

    for (UChar32 c = utext_next32(text); c >= 0; c=utext_next32(text)) {
        int32_t lengthMatched = static_cast<int32_t>(utext_getNativeIndex(text)) - startingTextIndex;
        codePointsMatched += 1;
        // Like UCharsDictionaryMatcher, which looks for c among UTF-16 units.
        uint32_t place = c <= 0xffff ? unitBlocks[(unitIndex[c >> 6] << 6) + (c & 63)] : 0;
        if (place-- == 0) {
            break;
        }
        UBool isWord;
        int32_t value = 0;
        // The first child, 0 if there is none, -1 if that is yet to be found.
        int32_t child;
        int32_t node = 0;
        if (first == 0) {
            uint32_t start = starts[place];
            if (start == 0) {
                break;
            }
            isWord = (start >> 20) & 1;
            value = static_cast<int32_t>(start >> 24);
            child = static_cast<int32_t>(start & 0xfffff);
        } else {
            if (place < singles) {
                node = find(first, place);
            } else {
                place -= singles;
                node = find(first, singles + (place >> 8));
                if (node >= 0) {
                    node = find(firstChild(node), place & 0xff);
                }
            }
            if (node < 0) {
                break;
            }
            const Block &b = blocks[node >> 6];
            isWord = (b.isWord >> (node & 63)) & 1;
            if (isWord && values != nullptr) {
                value = wordValues[b.words + countBits(b.isWord & bitsBelow(node & 63))];
            }
            child = -static_cast<int32_t>((b.hasChildren >> (node & 63)) & 1);
        }
        if (isWord && wordCount < limit) {
            if (values != nullptr) {
                values[wordCount] = value;
            }
            if (lengths != nullptr) {
                lengths[wordCount] = lengthMatched;
            }
            if (cpLengths != nullptr) {
                cpLengths[wordCount] = codePointsMatched;
            }
            ++wordCount;
        }
        if (child == 0 || lengthMatched >= maxLength) {
            break;
        }
        first = child > 0 ? child : firstChild(node);
    }

    if (prefix != nullptr) {
        *prefix = codePointsMatched;
    }
    return wordCount;
}

BytesDictionaryMatcher::~BytesDictionaryMatcher() {
    udata_close(file);
}

UChar32 BytesDictionaryMatcher::transform(UChar32 c) const {
    if ((transformConstant & DictionaryData::TRANSFORM_TYPE_MASK) == DictionaryData::TRANSFORM_TYPE_OFFSET) {
        if (c == 0x200D) {
            return 0xFF;
        } else if (c == 0x200C) {
            return 0xFE;
        }
        int32_t delta = c - (transformConstant & DictionaryData::TRANSFORM_OFFSET_MASK);
        if (delta < 0 || 0xFD < delta) {
            return U_SENTINEL;
        }
        return static_cast<UChar32>(delta);
    }
    return c;
}

int32_t BytesDictionaryMatcher::getType() const {
    return DictionaryData::TRIE_TYPE_BYTES;
}

int32_t BytesDictionaryMatcher::matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const {
    BytesTrie bt(characters);
    int32_t startingTextIndex = static_cast<int32_t>(utext_getNativeIndex(text));
    int32_t wordCount = 0;
    int32_t codePointsMatched = 0;

    for (UChar32 c = utext_next32(text); c >= 0; c=utext_next32(text)) {
        UStringTrieResult result = (codePointsMatched == 0) ? bt.first(transform(c)) : bt.next(transform(c));
        int32_t lengthMatched = static_cast<int32_t>(utext_getNativeIndex(text)) - startingTextIndex;
        codePointsMatched += 1;
        if (USTRINGTRIE_HAS_VALUE(result)) {
            if (wordCount < limit) {
                if (values != nullptr) {
                    values[wordCount] = bt.getValue();
                }
                if (lengths != nullptr) {
                    lengths[wordCount] = lengthMatched;
                }
                if (cpLengths != nullptr) {
                    cpLengths[wordCount] = codePointsMatched;
                }
                ++wordCount;
            }
            if (result == USTRINGTRIE_FINAL_VALUE) {
                break;
            }
        }
        else if (result == USTRINGTRIE_NO_MATCH) {
            break;
        }
        if (lengthMatched >= maxLength) {
            break;
        }
    }

    if (prefix != nullptr) {
        *prefix = codePointsMatched;
    }
    return wordCount;
}


U_NAMESPACE_END

U_NAMESPACE_USE

U_CAPI int32_t U_EXPORT2
udict_swap(const UDataSwapper *ds, const void *inData, int32_t length,
           void *outData, UErrorCode *pErrorCode) {
    const UDataInfo *pInfo;
    int32_t headerSize;
    const uint8_t *inBytes;
    uint8_t *outBytes;
    const int32_t *inIndexes;
    int32_t indexes[DictionaryData::IX_COUNT];
    int32_t i, offset, size;

    headerSize = udata_swapDataHeader(ds, inData, length, outData, pErrorCode);
    if (pErrorCode == nullptr || U_FAILURE(*pErrorCode)) return 0;
    pInfo = (const UDataInfo *)((const char *)inData + 4);
    if (!(pInfo->dataFormat[0] == 0x44 && 
          pInfo->dataFormat[1] == 0x69 && 
          pInfo->dataFormat[2] == 0x63 && 
          pInfo->dataFormat[3] == 0x74 && 
          pInfo->formatVersion[0] == 1)) {
        udata_printError(ds, "udict_swap(): data format %02x.%02x.%02x.%02x (format version %02x) is not recognized as dictionary data\n",
                         pInfo->dataFormat[0], pInfo->dataFormat[1], pInfo->dataFormat[2], pInfo->dataFormat[3], pInfo->formatVersion[0]);
        *pErrorCode = U_UNSUPPORTED_ERROR;
        return 0;
    }

    inBytes = (const uint8_t *)inData + headerSize;
    outBytes = (outData == nullptr) ? nullptr : (uint8_t *)outData + headerSize;

    inIndexes = (const int32_t *)inBytes;
    if (length >= 0) {
        length -= headerSize;
        if (length < (int32_t)(sizeof(indexes))) {
            udata_printError(ds, "udict_swap(): too few bytes (%d after header) for dictionary data\n", length);
            *pErrorCode = U_INDEX_OUTOFBOUNDS_ERROR;
            return 0;
        }
    }

    for (i = 0; i < DictionaryData::IX_COUNT; i++) {
        indexes[i] = udata_readInt32(ds, inIndexes[i]);
    }

    size = indexes[DictionaryData::IX_TOTAL_SIZE];

    if (length >= 0) {
        if (length < size) {
            udata_printError(ds, "udict_swap(): too few bytes (%d after header) for all of dictionary data\n", length);
            *pErrorCode = U_INDEX_OUTOFBOUNDS_ERROR;
            return 0;
        }

        if (inBytes != outBytes) {
            uprv_memcpy(outBytes, inBytes, size);
        }

        offset = 0;
        ds->swapArray32(ds, inBytes, sizeof(indexes), outBytes, pErrorCode);
        offset = (int32_t)sizeof(indexes);
        int32_t trieType = indexes[DictionaryData::IX_TRIE_TYPE] & DictionaryData::TRIE_TYPE_MASK;
        int32_t nextOffset = indexes[DictionaryData::IX_RESERVED1_OFFSET];

        if (trieType == DictionaryData::TRIE_TYPE_UCHARS) {
            ds->swapArray16(ds, inBytes + offset, nextOffset - offset, outBytes + offset, pErrorCode);
        } else if (trieType == DictionaryData::TRIE_TYPE_BYTES) {
            // nothing to do
        } else {
            udata_printError(ds, "udict_swap(): unknown trie type!\n");
            *pErrorCode = U_UNSUPPORTED_ERROR;
            return 0;
        }

        // these next two sections are empty in the current format,
        // but may be used later.
        offset = nextOffset;
        nextOffset = indexes[DictionaryData::IX_RESERVED2_OFFSET];
        offset = nextOffset;
        nextOffset = indexes[DictionaryData::IX_TOTAL_SIZE];
        offset = nextOffset;
    }
    return headerSize + size;
}
#endif
