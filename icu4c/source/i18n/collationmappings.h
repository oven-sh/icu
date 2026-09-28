// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// oven-sh/icu

#ifndef __COLLATIONMAPPINGS_H__
#define __COLLATIONMAPPINGS_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_COLLATION

#include "cmemory.h"
#include "collation.h"

U_NAMESPACE_BEGIN

/**
 * The mappings of a tailoring, from code points to CE32s. The root data has a trie for this, and so has ICU here.
 * (The root's is ICU's: it is one, it maps most of Unicode, and all text that no tailoring maps is looked up in it.)
 *
 * A tailoring maps few code points, a few dozen as a rule, and a trie that is as fast as the root's takes kilobytes
 * however few they are: for its index, and for blocks of values that are mostly not there. This is such a trie,
 * an index of blocks of 64 code points, without either:
 *
 * - A bit for each 256 code points says whether any of them is mapped, and the index has entries only for those.
 *   Most text is not looked up any further, where a trie takes two steps to say that the root data has to be asked.
 * - A block has a bit for each code point, and the values of those that are mapped.
 *   Which of them is a code point's is how many bits below its own are set.
 *   If they all have the same value, as Hangul syllables do, the block has it once.
 *
 * The large tailorings order the characters that their language is written in, thousands of Han characters.
 * There bits save little, and text consists of what is mapped. So there can be one span of code points
 * that has a value for each, which one step finds. Most such values are a two-byte primary weight with common secondary
 * and tertiary weights, and the span has 16 bits for each. Blocks that have only such values do too.
 * There can be another span with whole CE32s.
 *
 * How a code point is looked up depends on what part of Unicode it is in, not on its block:
 * a processor predicts what is the same for all of a script, and takes long to recover where it cannot.
 *
 * Text that a tailoring does map is what its language is written in, so finding a block must not take long either.
 * For the BMP, bmpBlocks says where each is. That is made when the data is loaded, and takes 2 kB of memory, not of data.
 *
 * Unlike the root's trie, this has nothing for a lead surrogate as a code unit.
 */
struct CollationMappings {
    /** In blockValues: the index is into values16. */
    static constexpr uint32_t NARROW = 0x80000000;
    /** In blockValues: the value at the index is that of every mapped code point of the block. */
    static constexpr uint32_t SAME = 0x40000000;
    static constexpr uint32_t MAX_VALUE_INDEX = 0x3fffffff;

    /** What a 16-bit value leaves out. */
    static constexpr uint32_t NARROW_LOW_BITS = (Collation::COMMON_BYTE << 8) | Collation::COMMON_BYTE;
    /** No primary weight starts with a byte below 3: in span16, values below this are for something else. */
    static constexpr uint32_t MIN_NARROW = 0x300;

    static UBool isNarrow(uint32_t ce32) { return (ce32 & 0xffff) == NARROW_LOW_BITS && (ce32 >> 16) >= MIN_NARROW; }
    static uint32_t widen(uint32_t value) { return (value << 16) | NARROW_LOW_BITS; }

    /** One for each 64 ranges of 256 code points. */
    static constexpr int32_t RANGE_WORDS = 0x110000 >> 14;

    /** Bit (c >> 8) & 63 of rangeBits[c >> 14]: a code point of the 256 that c is one of is mapped. */
    uint64_t rangeBits[RANGE_WORDS] = {};
    /** How many bits are set in the words before this one. */
    uint16_t rangesBefore[RANGE_WORDS] = {};

    /**
     * 4 entries, one for each 64 code points, for each range that has a mapped code point:
     * the index of the block plus 1, or 0 if none of the 64 is mapped, or all that are are in a span.
     */
    const uint16_t *index = nullptr;
    /**
     * For each code point from SPAN16_START: 0 if it is not mapped, the upper half of a CE32 that isNarrow(),
     * or the index in values32 of any other CE32, plus 1.
     */
    const uint16_t *span16 = nullptr;
    /** For each code point from SPAN32_START: its CE32, FALLBACK_CE32 if it is not mapped. */
    const uint32_t *span32 = nullptr;
    /** For each block, 64 bits, in the platform's byte order, at any alignment. Bit i: the code point is mapped. */
    const uint8_t *blockBits = nullptr;
    /** For each block, the index of the value of its first mapped code point in values32, with NARROW and SAME. */
    const uint32_t *blockValues = nullptr;
    const uint32_t *values32 = nullptr;
    const uint16_t *values16 = nullptr;

    /** In bmpBlocks: all 64 code points are in span16, or in span32. */
    static constexpr uint16_t IN_SPAN16 = 0xffff;
    static constexpr uint16_t IN_SPAN32 = 0xfffe;
    /** In bmpBlocks: some of the 64 code points are in a span. */
    static constexpr uint16_t PARTLY_IN_SPAN = 0xfffd;
    static constexpr int32_t MAX_BLOCKS = 0xfffc;
    /**
     * Not in the data: where to look for the code points of the BMP, which most text consists of, in one step.
     * For each 64 of them, 0 if none is mapped, the index of their block plus 1, or one of the constants.
     */
    uint16_t bmpBlocks[0x10000 >> 6] = {};

    enum {
        /** The number of rangeBits that are not 0. Only those are written, each after its index. */
        RANGE_WORDS_LENGTH,
        INDEX_LENGTH,
        SPAN16_LENGTH,
        SPAN32_LENGTH,
        BLOCKS_LENGTH,
        VALUES32_LENGTH,
        VALUES16_LENGTH,
        SPAN16_START,
        SPAN32_START,
        RESERVED_LENGTH,
        LENGTHS_COUNT
    };
    int32_t lengths[LENGTHS_COUNT] = {};

    /** Whether get(c) has to be asked. */
    UBool isInMappedRange(UChar32 c) const {
        return (rangeBits[c >> 14] >> ((c >> 8) & 0x3f)) & 1;
    }

    static int32_t countBits(uint64_t bits) {
#if defined(__GNUC__) || defined(__clang__)
        return __builtin_popcountll(bits);
#else
        bits -= (bits >> 1) & 0x5555555555555555u;
        bits = (bits & 0x3333333333333333u) + ((bits >> 2) & 0x3333333333333333u);
        return static_cast<int32_t>((((bits + (bits >> 4)) & 0x0f0f0f0f0f0f0f0fu) * 0x0101010101010101u) >> 56);
#endif
    }

    /** getFromMappedRange(), for a function that does little else. */
    U_FORCE_INLINE uint32_t getFromMappedRangeInline(UChar32 c) const {
        uint32_t i = static_cast<uint32_t>(c - lengths[SPAN16_START]);
        if(i < static_cast<uint32_t>(lengths[SPAN16_LENGTH])) {
            uint32_t value = span16[i];
            return value >= MIN_NARROW ? widen(value) : value == 0 ? Collation::FALLBACK_CE32 : values32[value - 1];
        }
        i = static_cast<uint32_t>(c - lengths[SPAN32_START]);
        if(i < static_cast<uint32_t>(lengths[SPAN32_LENGTH])) { return span32[i]; }
        int32_t word = c >> 14;
        int32_t range = rangesBefore[word] + countBits(rangeBits[word] & ((uint64_t{1} << ((c >> 8) & 0x3f)) - 1));
        int32_t block = index[(range << 2) + ((c >> 6) & 3)];
        return block == 0 ? Collation::FALLBACK_CE32 : getFromBlock(block - 1, c);
    }

    U_FORCE_INLINE uint32_t getFromBlock(int32_t block, UChar32 c) const {
        uint64_t bits;
        uprv_memcpy(&bits, blockBits + block * 8, 8);
        uint32_t i = c & 0x3f;
        if(((bits >> i) & 1) == 0) { return Collation::FALLBACK_CE32; }
        uint32_t first = blockValues[block];
        i = (first & MAX_VALUE_INDEX) + ((first & SAME) != 0 ? 0 : countBits(bits & ((uint64_t{1} << i) - 1)));
        return (first & NARROW) != 0 ? widen(values16[i]) : values32[i];
    }

    /** @param place bmpBlocks[c >> 6], not 0 */
    U_FORCE_INLINE uint32_t getFromBMPInline(UChar32 c, uint32_t place) const {
        if(place <= static_cast<uint32_t>(MAX_BLOCKS)) { return getFromBlock(place - 1, c); }
        if(place == IN_SPAN16) {
            uint32_t value = span16[c - lengths[SPAN16_START]];
            return value >= MIN_NARROW ? widen(value) : value == 0 ? Collation::FALLBACK_CE32 : values32[value - 1];
        }
        return place == IN_SPAN32 ? span32[c - lengths[SPAN32_START]] : getFromMappedRangeInline(c);
    }

    /*
     * Not inline. What is worth having inline elsewhere is isInMappedRange();
     * the rest would make functions large that are small in ICU, and are compiled accordingly.
     */

    /** @param c a code point for which isInMappedRange() */
    U_I18N_API uint32_t getFromMappedRange(UChar32 c) const;

    U_I18N_API uint32_t get(UChar32 c) const;

    /** Calls f(c, ce32) for each mapped code point, ascending. Stops when that returns false. */
    template<typename F>
    void forEachCodePoint(F f) const {
        for(UChar32 start = 0; start <= 0x10ffff; start += 0x100) {
            if(!isInMappedRange(start)) { continue; }
            for(UChar32 c = start; c < start + 0x100; ++c) {
                uint32_t ce32 = getFromMappedRange(c);
                if(ce32 != Collation::FALLBACK_CE32 && !f(c, ce32)) { return; }
            }
        }
    }

    /** Sets rangesBefore and RANGE_WORDS_LENGTH from rangeBits. @return the number of ranges */
    U_I18N_API int32_t countRanges();

    /** Sets bmpBlocks from all else. */
    U_I18N_API void setBMPBlocks();

    /** The number of bytes that write() writes, a multiple of 8. INT32_MAX if that is too many. */
    U_I18N_API int32_t getBinaryLength() const;

    /**
     * Writes, in the platform's byte order:
     *
     * int32_t lengths[LENGTHS_COUNT];
     * struct { int32_t i; uint64_t rangeBits_i; } rangeWords[RANGE_WORDS_LENGTH]; -- 12 bytes each, ascending
     * uint64_t blockBits[BLOCKS_LENGTH]; -- at a multiple of 4
     * uint32_t blockValues[BLOCKS_LENGTH];
     * uint32_t span32[SPAN32_LENGTH];
     * uint32_t values32[VALUES32_LENGTH];
     * uint16_t index[INDEX_LENGTH];
     * uint16_t span16[SPAN16_LENGTH];
     * uint16_t values16[VALUES16_LENGTH];
     * and zeros up to a multiple of 8 bytes.
     *
     * ucol_swap() knows this too.
     */
    U_I18N_API void write(uint8_t *dest) const;

    /**
     * Points into the bytes.
     * @param bytes what write() wrote, at a multiple of 4
     * @return false if that cannot be
     */
    U_I18N_API UBool read(const uint8_t *bytes, int32_t length);
};

U_NAMESPACE_END

#endif  // !UCONFIG_NO_COLLATION
#endif  // __COLLATIONMAPPINGS_H__
