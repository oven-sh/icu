// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2014, International Business Machines
* Corporation and others.  All Rights Reserved.
*******************************************************************************
* dictionarydata.h
*
* created on: 2012may31
* created by: Markus W. Scherer & Maxime Serrano
*/

#ifndef __DICTIONARYDATA_H__
#define __DICTIONARYDATA_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_BREAK_ITERATION

#include "unicode/utext.h"
#include "unicode/udata.h"
#include "udataswp.h"
#include "unicode/uobject.h"
#include "unicode/ustringtrie.h"

U_NAMESPACE_BEGIN

class UCharsTrie;
class BytesTrie;

class U_COMMON_API DictionaryData : public UMemory {
public:
    static const int32_t TRIE_TYPE_BYTES; // = 0;
    static const int32_t TRIE_TYPE_UCHARS; // = 1;
    /** oven-sh/icu: see SuccinctDictionaryMatcher. */
    static const int32_t TRIE_TYPE_SUCCINCT; // = 2;
    static const int32_t TRIE_TYPE_MASK; // = 7;
    static const int32_t TRIE_HAS_VALUES; // = 8;

    static const int32_t TRANSFORM_NONE; // = 0;
    static const int32_t TRANSFORM_TYPE_OFFSET; // = 0x1000000;
    static const int32_t TRANSFORM_TYPE_MASK; // = 0x7f000000;
    static const int32_t TRANSFORM_OFFSET_MASK; // = 0x1fffff;

    enum {
        // Byte offsets from the start of the data, after the generic header.
        IX_STRING_TRIE_OFFSET,
        IX_RESERVED1_OFFSET,
        IX_RESERVED2_OFFSET,
        IX_TOTAL_SIZE,

        // Trie type: TRIE_HAS_VALUES | TRIE_TYPE_BYTES etc.
        IX_TRIE_TYPE,
        // Transform specification: TRANSFORM_TYPE_OFFSET | 0xe00 etc.
        IX_TRANSFORM,

        IX_RESERVED6,
        IX_RESERVED7,
        IX_COUNT
    };
};

/**
 * Wrapper class around generic dictionaries, implementing matches().
 * getType() should return a TRIE_TYPE_??? constant from DictionaryData.
 * 
 * All implementations of this interface must be thread-safe if they are to be used inside of the
 * dictionary-based break iteration code.
 */
class U_COMMON_API DictionaryMatcher : public UMemory {
public:
    DictionaryMatcher() {}
    virtual ~DictionaryMatcher();
    // this should emulate CompactTrieDictionary::matches()
    /*  @param text      The text in which to look for matching words. Matching begins
     *                   at the current position of the UText.
     *  @param maxLength The max length of match to consider. Units are the native indexing
     *                   units of the UText.
     *  @param limit     Capacity of output arrays, which is also the maximum number of
     *                   matching words to be found.
     *  @param lengths   output array, filled with the lengths of the matches, in order,
     *                   from shortest to longest. Lengths are in native indexing units
     *                   of the UText. May be nullptr.
     *  @param cpLengths output array, filled with the lengths of the matches, in order,
     *                   from shortest to longest. Lengths are the number of Unicode code points.
     *                   May be nullptr.
     *  @param values    Output array, filled with the values associated with the words found.
     *                   May be nullptr.
     *  @param prefix    Output parameter, the code point length of the prefix match, even if that
     *                   prefix didn't lead to a complete word. Will always be >= the cpLength
     *                   of the longest complete word matched. May be nullptr.
     *  @return          Number of matching words found.
     */
    virtual int32_t matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const = 0;

    /** @return DictionaryData::TRIE_TYPE_XYZ */
    virtual int32_t getType() const = 0;
};

// Implementation of the DictionaryMatcher interface for a UCharsTrie dictionary
class U_COMMON_API UCharsDictionaryMatcher : public DictionaryMatcher {
public:
    // constructs a new UCharsDictionaryMatcher.
    // The UDataMemory * will be closed on this object's destruction.
    UCharsDictionaryMatcher(const char16_t *c, UDataMemory *f) : characters(c), file(f) { }
    virtual ~UCharsDictionaryMatcher();
    virtual int32_t matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const override;
    virtual int32_t getType() const override;
private:
    const char16_t *characters;
    UDataMemory *file;
};

/**
 * oven-sh/icu: A dictionary with values of 0..255, in about half of what it takes as a UCharsTrie.
 * Written by bun/data/icu-dict.ts from what gendict --uchars writes.
 *
 * A UTF-16 unit is a byte if it is one of the S most frequent, by its place in the order of frequency, else two bytes:
 * with i its place less S, S+(i>>8) and i&0xff. The dictionary is a trie of the words as such bytes.
 * Its nodes, but for the root, are numbered level by level, and on a level in the order of the words,
 * so that the children of a node, a group, follow each other, in the order of their bytes,
 * and the groups follow each other in the order of the nodes whose children they are.
 * So the children of a node are the group with the number of nodes before it that have children, plus 1 for the root's.
 * Nothing says where any node is.
 *
 * int32_t header[8]: the number of nodes, S, then the offsets in bytes from the header, multiples of 8, of
 * - uint16_t unitIndex[0x400]; uint16_t unitBlocks[][64]: unitBlocks[unitIndex[c>>6]][c&63] is
 *   the place of c in the order of frequency plus 1, or 0 if no word has it
 * - uint8_t labels[]: for each node, the byte that leads to it. A group of 32 nodes or more has, where its first 32 labels
 *   would be, a bit for each byte there is: bit b&7 of byte b>>3 is set if the group has a node for b.
 *   There are 8 more bytes than nodes.
 * - Block blocks[]: for each 64 nodes, and one more whose isLast is all ones
 * - uint8_t values[]: for each node that is a word, in the order of the nodes
 *
 * It is little-endian: nothing writes it otherwise, and udict_swap() does not swap it.
 */
class U_COMMON_API SuccinctDictionaryMatcher : public DictionaryMatcher {
public:
    // The UDataMemory * will be closed on this object's destruction.
    SuccinctDictionaryMatcher(const uint8_t *data, UDataMemory *f);
    virtual ~SuccinctDictionaryMatcher();
    virtual int32_t matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const override;
    virtual int32_t getType() const override;
private:
    /** What there is to know about 64 nodes but their labels. Node n has bit n&63. */
    struct Block {
        uint64_t hasChildren;
        /** The node is the last of its group. */
        uint64_t isLast;
        uint64_t isWord;
        /** The first child of the first of these nodes, or of the ones after them, that has children. */
        uint32_t firstChild;
        /** How many of the nodes before these are words. */
        uint32_t words;
    };

    /** The one with this label of the group that starts with the node `first`, or -1. */
    inline int32_t find(int32_t first, uint32_t label) const;
    /** The first of the children of a node that has some. */
    inline int32_t firstChild(int32_t node) const;

    uint32_t singles;
    const uint16_t *unitIndex;
    const uint16_t *unitBlocks;
    const uint8_t *labels;
    const Block *blocks;
    const uint8_t *wordValues;
    UDataMemory *file;
};

// Implementation of the DictionaryMatcher interface for a BytesTrie dictionary
class U_COMMON_API BytesDictionaryMatcher : public DictionaryMatcher {
public:
    // constructs a new BytesTrieDictionaryMatcher
    // the transform constant should be the constant read from the file, not a masked version!
    // the UDataMemory * fed in here will be closed on this object's destruction
    BytesDictionaryMatcher(const char *c, int32_t t, UDataMemory *f)
            : characters(c), transformConstant(t), file(f) { }
    virtual ~BytesDictionaryMatcher();
    virtual int32_t matches(UText *text, int32_t maxLength, int32_t limit,
                            int32_t *lengths, int32_t *cpLengths, int32_t *values,
                            int32_t *prefix) const override;
    virtual int32_t getType() const override;
private:
    UChar32 transform(UChar32 c) const;

    const char *characters;
    int32_t transformConstant;
    UDataMemory *file;
};

U_NAMESPACE_END

U_CAPI int32_t U_EXPORT2
udict_swap(const UDataSwapper *ds, const void *inData, int32_t length, void *outData, UErrorCode *pErrorCode);

/**
 * Format of dictionary .dict data files.
 * Format version 1.0.
 *
 * A dictionary .dict data file contains a byte-serialized BytesTrie or
 * a UChars-serialized UCharsTrie.
 * (oven-sh/icu: or what SuccinctDictionaryMatcher reads, with the trie type TRIE_TYPE_SUCCINCT.)
 * Such files are used in dictionary-based break iteration (DBBI).
 *
 * For a BytesTrie, a transformation type is specified for
 * transforming Unicode strings into byte sequences.
 *
 * A .dict file begins with a standard ICU data file header
 * (DataHeader, see ucmndata.h and unicode/udata.h).
 * The UDataInfo.dataVersion field is currently unused (set to 0.0.0.0).
 *
 * After the header, the file contains the following parts.
 * Constants are defined in the DictionaryData class.
 *
 * For the data structure of BytesTrie & UCharsTrie see
 * https://icu.unicode.org/design/struct/tries
 * and the bytestrie.h and ucharstrie.h header files.
 *
 * int32_t indexes[indexesLength]; -- indexesLength=indexes[IX_STRING_TRIE_OFFSET]/4;
 *
 *      The first four indexes are byte offsets in ascending order.
 *      Each byte offset marks the start of the next part in the data file,
 *      and the end of the previous one.
 *      When two consecutive byte offsets are the same, then the corresponding part is empty.
 *      Byte offsets are offsets from after the header,
 *      that is, from the beginning of the indexes[].
 *      Each part starts at an offset with proper alignment for its data.
 *      If necessary, the previous part may include padding bytes to achieve this alignment.
 *
 *      trieType=indexes[IX_TRIE_TYPE] defines the trie type.
 *      transform=indexes[IX_TRANSFORM] defines the Unicode-to-bytes transformation.
 *          If the transformation type is TRANSFORM_TYPE_OFFSET,
 *          then the lower 21 bits contain the offset code point.
 *          Each code point c is mapped to byte b = (c - offset).
 *          Code points outside the range offset..(offset+0xff) cannot be mapped
 *          and do not occur in the dictionary.
 *
 * stringTrie; -- a serialized BytesTrie or UCharsTrie
 *
 *      The dictionary maps strings to specific values (TRIE_HAS_VALUES bit set in trieType),
 *      or it maps all strings to 0 (TRIE_HAS_VALUES bit not set).
 */

#endif  /* !UCONFIG_NO_BREAK_ITERATION */
#endif  /* __DICTIONARYDATA_H__ */
