// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
* Copyright (C) 1999-2016, International Business Machines
*                Corporation and others. All Rights Reserved.
******************************************************************************
*   file name:  uresdata.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 1999dec08
*   created by: Markus W. Scherer
*   06/24/02    weiv        Added support for resource sharing
*/

#ifndef __RESDATA_H__
#define __RESDATA_H__

#include "unicode/utypes.h"
#include "unicode/udata.h"
#include "unicode/ures.h"
#include "putilimp.h"
#include "udataswp.h"

/**
 * Numeric constants for internal-only types of resource items.
 * These must use different numeric values than UResType constants
 * because they are used together.
 * Internal types are never returned by ures_getType().
 */
typedef enum {
    /** Include a negative value so that the compiler uses the same int type as for UResType. */
    URES_INTERNAL_NONE=-1,

    /** Resource type constant for tables with 32-bit count, key offsets and values. */
    URES_TABLE32=4,

    /**
     * Resource type constant for tables with 16-bit count, key offsets and values.
     * All values are URES_STRING_V2 strings.
     */
    URES_TABLE16=5,

    /** Resource type constant for 16-bit Unicode strings in formatVersion 2. */
    URES_STRING_V2=6,

    /**
     * Resource type constant for arrays with 16-bit count and values.
     * All values are URES_STRING_V2 strings.
     */
    URES_ARRAY16=9,

    /**
     * formatVersion 4: a table in the compact area, whose keys and item types are a keyset of the pool bundle.
     */
    URES_TABLE_COMPACT=10,
    /** formatVersion 4: an array of strings in the compact area. */
    URES_ARRAY_COMPACT=11

    /* Resource type 15 is not defined but effectively used by RES_BOGUS=0xffffffff. */
} UResInternalType;

/*
 * A Resource is a 32-bit value that has 2 bit fields:
 * 31..28   4-bit type, see enum below
 * 27..0    28-bit four-byte-offset or value according to the type
 */
typedef uint32_t Resource;

#define RES_BOGUS 0xffffffff
#define RES_MAX_OFFSET 0x0fffffff

#define RES_GET_TYPE(res) ((int32_t)((res)>>28UL))
#define RES_GET_OFFSET(res) ((res)&0x0fffffff)
#define RES_GET_POINTER(pRoot, res) ((pRoot)+RES_GET_OFFSET(res))

/* get signed and unsigned integer values directly from the Resource handle
 * NOTE: For proper logging, please use the res_getInt() constexpr
 */
#if U_SIGNED_RIGHT_SHIFT_IS_ARITHMETIC
#   define RES_GET_INT_NO_TRACE(res) (((int32_t)((res)<<4L))>>4L)
#else
#   define RES_GET_INT_NO_TRACE(res) (int32_t)(((res)&0x08000000) ? (res)|0xf0000000 : (res)&0x07ffffff)
#endif

#define RES_GET_UINT_NO_TRACE(res) ((res)&0x0fffffff)

#define URES_IS_ARRAY(type) ((int32_t)(type)==URES_ARRAY || (int32_t)(type)==URES_ARRAY16 || (int32_t)(type)==URES_ARRAY_COMPACT)
#define URES_IS_TABLE(type) ((int32_t)(type)==URES_TABLE || (int32_t)(type)==URES_TABLE16 || (int32_t)(type)==URES_TABLE32 || (int32_t)(type)==URES_TABLE_COMPACT)
#define URES_IS_CONTAINER(type) (URES_IS_TABLE(type) || URES_IS_ARRAY(type))

#define URES_MAKE_RESOURCE(type, offset) (((Resource)(type)<<28)|(Resource)(offset))
#define URES_MAKE_EMPTY_RESOURCE(type) ((Resource)(type)<<28)

/* indexes[] value names; indexes are generally 32-bit (Resource) indexes */
enum {
    /**
     * [0] contains the length of indexes[]
     * which is at most URES_INDEX_TOP of the latest format version
     *
     * formatVersion==1: all bits contain the length of indexes[]
     *   but the length is much less than 0xff;
     * formatVersion>1:
     *   only bits  7..0 contain the length of indexes[],
     *        bits 31..8 are reserved and set to 0
     * formatVersion>=3:
     *        bits 31..8 poolStringIndexLimit bits 23..0
     */
    URES_INDEX_LENGTH,
    /**
     * [1] contains the top of the key strings,
     *     same as the bottom of resources or UTF-16 strings, rounded up
     */
    URES_INDEX_KEYS_TOP,
    /** [2] contains the top of all resources */
    URES_INDEX_RESOURCES_TOP,
    /**
     * [3] contains the top of the bundle,
     *     in case it were ever different from [2]
     */
    URES_INDEX_BUNDLE_TOP,
    /** [4] max. length of any table */
    URES_INDEX_MAX_TABLE_LENGTH,
    /**
     * [5] attributes bit set, see URES_ATT_* (new in formatVersion 1.2)
     *
     * formatVersion>=3:
     *   bits 31..16 poolStringIndex16Limit
     *   bits 15..12 poolStringIndexLimit bits 27..24
     */
    URES_INDEX_ATTRIBUTES,
    /**
     * [6] top of the 16-bit units (UTF-16 string v2 UChars, URES_TABLE16, URES_ARRAY16),
     *     rounded up (new in formatVersion 2.0, ICU 4.4)
     */
    URES_INDEX_16BIT_TOP,
    /** [7] checksum of the pool bundle (new in formatVersion 2.0, ICU 4.4) */
    URES_INDEX_POOL_CHECKSUM,
    /* formatVersion 4, which only a pool bundle has: see its description below. */
    /** [8] start of the keysets */
    URES_INDEX_KEYSETS,
    /** [9] start of the grammars */
    URES_INDEX_GRAMMARS,
    /** [10] start of the headers that are known by a byte */
    URES_INDEX_HEADERS,
    /** [11] start of the low 16 bits of the offsets of the pool's strings, by ordinal */
    URES_INDEX_STRING_OFFSETS,
    /** [12] first ordinal of a string whose offset has bit 16 set */
    URES_INDEX_STRING_OFFSETS_HIGH_START,
    /** [13] start of the pool's strings */
    URES_INDEX_POOL_TEXT,
    /** [14] which of the grammars they are written in */
    URES_INDEX_POOL_GRAMMAR,
    /** [15] number of bundles */
    URES_INDEX_BUNDLES,
    /** [16] start of the offsets of the bundles' names among the key strings, in the order of the names */
    URES_INDEX_BUNDLE_NAMES,
    /** [17] start of the offsets of the bundles, in the same order */
    URES_INDEX_BUNDLE_OFFSETS,
    URES_INDEX_TOP
};

/*
 * Nofallback attribute, attribute bit 0 in indexes[URES_INDEX_ATTRIBUTES].
 * New in formatVersion 1.2 (ICU 3.6).
 *
 * If set, then this resource bundle is a standalone bundle.
 * If not set, then the bundle participates in locale fallback, eventually
 * all the way to the root bundle.
 * If indexes[] is missing or too short, then the attribute cannot be determined
 * reliably. Dependency checking should ignore such bundles, and loading should
 * use fallbacks.
 */
#define URES_ATT_NO_FALLBACK 1

/*
 * Attributes for bundles that are, or use, a pool bundle.
 * A pool bundle provides key strings that are shared among several other bundles
 * to reduce their total size.
 * New in formatVersion 2 (ICU 4.4).
 */
#define URES_ATT_IS_POOL_BUNDLE 2
#define URES_ATT_USES_POOL_BUNDLE 4

/*
 * File format for .res resource bundle files
 *
 * oven-sh/icu: New in formatVersion 4 compared with 3: -------------
 *
 * Written by bun/data/icu-res.ts from the bundles that genrb writes, where there is a pool bundle.
 * genrb and the other tools neither write nor read it. The runtime reads every version, and one package may hold several.
 *
 * What it is for:
 * - The locales of a tree have the same tables with the same keys, so in version 3 most of what is not text
 *   is the same key offsets over and over, and an offset for each string that says
 *   no more than where the string before it ended.
 * - The text is UTF-16, of languages that seldom use more than a hundred characters, and says the same words over and over.
 * - Each of thousands of bundles is an item of the package, with a name, a header, indexes and padding.
 *
 * Only a pool bundle has this version, and the bundles next to it are inside it rather than items of the package,
 * whether they used it or not, but for those that have binary data.
 * The runtime looks for a bundle there first (res_loadFromPool()).
 * After the key strings, it has the following.
 * Each starts where an item of indexes[] says, in 32-bit units from the root resource like all offsets there.
 *
 * - Keysets. Each starts at an even offset in 16-bit units:
 *     uint16_t N; uint16_t keyOffsets[N]; uint16_t types[(N+3)/4]
 *   The key offsets are from the start of the key strings, in the order of the keys.
 *   The type of the item with key j is bits 4*(j&3).. of types[j>>2].
 *   12 and 13 are a Table (10) and an Array (11) that are stored among the items of the table, see below.
 * - Grammars: uint32_t starts[], where each is, in 16-bit units from starts[0]. Each says what the cells of strings
 *   (see below) stand for, in the bundles of a language or of a few:
 *     uint16_t L, S, M, R; uint16_t letters[L+M]; uint16_t offsets[R+1]; uint8_t bodies[]
 *   The cells 1..L stand for a letter each, a UTF-16 unit, and the cells L+1..L+S for the rules 0..S-1.
 *   A cell c above that goes with the cell d after it. With i=(c-L-S-1)*255+d-1,
 *   the two stand for the letter L+i if i<M, else for the rule S+i-M.
 *   A rule stands for what the cells bodies[offsets[r]..offsets[r+1]-1] stand for, which is more than any one of them does.
 * - uint32_t tableHeaders[256], arrayHeaders[256]: the headers of containers (see below) that are known by a byte.
 * - uint16_t stringOffsets[]: for each of the pool's strings, which are known by their ordinals,
 *   the low 16 bits of its offset in the pool's text. Bit 16 is set from the ordinal URES_INDEX_STRING_OFFSETS_HIGH_START on.
 * - The pool's text: strings.
 * - uint16_t bundleNames[]; uint32_t bundleOffsets[]
 * - The bundles.
 *
 * A bundle is
 *
 *   Resource root;
 *   uint16_t poolStringLimit; uint16_t attributes (bits 3..0) and grammar (bits 15..4);
 *   uint16_t compactStart; uint16_t length;
 *   32-bit resources; the compact area
 *
 * Offsets of 32-bit resources, compactStart and length are in 32-bit units from the root resource.
 * The attributes are URES_ATT_NO_FALLBACK, and in bits 3..2 the shift, see below. Several names may have the same bundle.
 * The 32-bit resources are as in version 3. All keys are the pool's.
 *
 * The compact area is addressed in bytes, from its start. It holds fields, headers and strings.
 * A field is a 16-bit number, at any offset. Where it is itself an offset in the compact area,
 * it is one that has been shifted right by the bundle's shift, which is 0 unless the area is larger than a field can tell.
 * Byte 0 is 0: the empty string, and as in version 2 the offset 0 is an empty value of any type.
 *
 * Strings: a String-v2 offset at or above poolStringLimit is, less that limit, an offset in the compact area.
 * Below it, it is the ordinal of one of the pool's strings. A Resource16 is the same, with what is above the limit shifted.
 * A string is bytes, here called cells. The cells 1..0xfe stand for what the bundle's grammar says,
 * and 0xff comes before a unit in three cells: 0x80 | bits 6..0, 0x80 | bits 13..7, 0x80 | bits 15..14.
 * A 0 cell is the end, and no other cell is 0: no string contains U+0000.
 * The runtime writes a string out in UTF-16 when it is first asked for (WideStrings in uresdata.cpp).
 *
 * The header of a container is a 24-bit number. It is stored as a byte c, and is tableHeaders[c] or arrayHeaders[c],
 * or as 0xff and then its three bytes, the lowest first.
 *
 * 10 Table:  header; [field keyBits[(N+15)/16];] items
 *            header bits 23..3: half the offset, in 16-bit units, of a keyset, which has N keys
 *                   bit  2:     the table has the keys of the keyset whose bit is set in keyBits
 *                               (bit j is bit j&15 of keyBits[j>>4]); otherwise it has them all
 *                   bits 1..0:  how the items are stored
 * 11 Array:  header; items
 *            header bits 23..2: the number of items, all strings
 *                   bits 1..0:  how the items are stored
 *
 *    How n items are stored:
 *    0  field values[n]
 *       A string is a Resource16. For any other type the value is the offset part of a Resource;
 *       the type is the keyset's. (So an integer is one of 0..0xffff.)
 *    1  field skip[(n-1)/8]; then the strings, one after the other
 *       skip[g-1] is the offset of the (8*g)th string from the first.
 *    2  field skip[(n-1)/8]; then the items, one after the other. An item of type 12 or 13 is the table or array itself,
 *       all of whose items are strings. Any other is a field as for 0.
 *    3  field isValue[(n+15)/16]; field values[number of bits set]; then the other m strings as for 1, with m for n
 *
 * ICU 56: New in formatVersion 3 compared with 2: -------------
 *
 * Resource bundles can optionally use shared string-v2 values
 * stored in the pool bundle.
 * If so, then the indexes[] contain two new values
 * in previously-unused bits of existing indexes[] slots:
 * - poolStringIndexLimit:
 *     String-v2 offsets (in 32-bit Resource words) below this limit
 *     point to pool bundle string-v2 values.
 * - poolStringIndex16Limit:
 *     Resource16 string-v2 offsets below this limit
 *     point to pool bundle string-v2 values.
 * Guarantee: poolStringIndex16Limit <= poolStringIndexLimit
 *
 * The local bundle's poolStringIndexLimit is greater than
 * any pool bundle string index used in the local bundle.
 * The poolStringIndexLimit should not be greater than
 * the maximum possible pool bundle string index.
 *
 * The maximum possible pool bundle string index is the index to the last non-NUL
 * pool string character, due to suffix sharing.
 *
 * In the pool bundle, there is no structure that lists the strings.
 * (The root resource is an empty Table.)
 * If the strings need to be enumerated (as genrb --usePoolBundle does),
 * then iterate through the pool bundle's 16-bit-units array from the beginning.
 * Stop at the end of the array, or when an explicit or implicit string length
 * would lead beyond the end of the array,
 * or when an apparent string is not NUL-terminated.
 * (Future genrb version might terminate the strings with
 * what looks like a large explicit string length.)
 *
 * ICU 4.4: New in formatVersion 2 compared with 1.3: -------------
 *
 * Three new resource types -- String-v2, Table16 and Array16 -- have their
 * values stored in a new array of 16-bit units between the table key strings
 * and the start of the other resources.
 *
 * genrb eliminates duplicates among Unicode string-v2 values.
 * Multiple Unicode strings may use the same offset and string data,
 * or a short string may point to the suffix of a longer string. ("Suffix sharing")
 * For example, one string "abc" may be reused for another string "bc" by pointing
 * to the second character. (Short strings-v2 are NUL-terminated
 * and not preceded by an explicit length value.)
 *
 * It is allowed for all resource types to share values.
 * The swapper code (ures_swap()) has been modified so that it swaps each item
 * exactly once.
 *
 * A resource bundle may use a special pool bundle. Some or all of the table key strings
 * of the using-bundle are omitted, and the key string offsets for such key strings refer
 * to offsets in the pool bundle.
 * The using-bundle's and the pool-bundle's indexes[URES_INDEX_POOL_CHECKSUM] values
 * must match.
 * Two bits in indexes[URES_INDEX_ATTRIBUTES] indicate whether a resource bundle
 * is or uses a pool bundle.
 *
 * Table key strings must be compared in ASCII order, even if they are not
 * stored in ASCII.
 *
 * New in formatVersion 1.3 compared with 1.2: -------------
 *
 * genrb eliminates duplicates among key strings.
 * Multiple table items may share one key string, or one item may point
 * to the suffix of another's key string. ("Suffix sharing")
 * For example, one key "abc" may be reused for another key "bc" by pointing
 * to the second character. (Key strings are NUL-terminated.)
 *
 * -------------
 *
 * An ICU4C resource bundle file (.res) is a binary, memory-mappable file
 * with nested, hierarchical data structures.
 * It physically contains the following:
 *
 *   Resource root; -- 32-bit Resource item, root item for this bundle's tree;
 *                     currently, the root item must be a table or table32 resource item
 *   int32_t indexes[indexes[0]]; -- array of indexes for friendly
 *                                   reading and swapping; see URES_INDEX_* above
 *                                   new in formatVersion 1.1 (ICU 2.8)
 *   char keys[]; -- characters for key strings
 *                   (formatVersion 1.0: up to 65k of characters; 1.1: <2G)
 *                   (minus the space for root and indexes[]),
 *                   which consist of invariant characters (ASCII/EBCDIC) and are NUL-terminated;
 *                   padded to multiple of 4 bytes for 4-alignment of the following data
 *   uint16_t 16BitUnits[]; -- resources that are stored entirely as sequences of 16-bit units
 *                             (new in formatVersion 2/ICU 4.4)
 *                             data is indexed by the offset values in 16-bit resource types,
 *                             with offset 0 pointing to the beginning of this array;
 *                             there is a 0 at offset 0, for empty resources;
 *                             padded to multiple of 4 bytes for 4-alignment of the following data
 *   data; -- data directly and indirectly indexed by the root item;
 *            the structure is determined by walking the tree
 *
 * Each resource bundle item has a 32-bit Resource handle (see typedef above)
 * which contains the item type number in its upper 4 bits (31..28) and either
 * an offset or a direct value in its lower 28 bits (27..0).
 * The order of items is undefined and only determined by walking the tree.
 * Leaves of the tree may be stored first or last or anywhere in between,
 * and it is in theory possible to have unreferenced holes in the file.
 *
 * 16-bit-unit values:
 * Starting with formatVersion 2/ICU 4.4, some resources are stored in a special
 * array of 16-bit units. Each resource value is a sequence of 16-bit units,
 * with no per-resource padding to a 4-byte boundary.
 * 16-bit container types (Table16 and Array16) contain Resource16 values
 * which are offsets to String-v2 resources in the same 16-bit-units array.
 *
 * Direct values:
 * - Empty Unicode strings have an offset value of 0 in the Resource handle itself.
 * - Starting with formatVersion 2/ICU 4.4, an offset value of 0 for
 *   _any_ resource type indicates an empty value.
 * - Integer values are 28-bit values stored in the Resource handle itself;
 *   the interpretation of unsigned vs. signed integers is up to the application.
 *
 * All other types and values use 28-bit offsets to point to the item's data.
 * The offset is an index to the first 32-bit word of the value, relative to the
 * start of the resource data (i.e., the root item handle is at offset 0).
 * To get byte offsets, the offset is multiplied by 4 (or shifted left by 2 bits).
 * All resource item values are 4-aligned.
 *
 * New in formatVersion 2/ICU 4.4: Some types use offsets into the 16-bit-units array,
 * indexing 16-bit units in that array.
 *
 * The structures (memory layouts) for the values for each item type are listed
 * in the table below.
 *
 * Nested, hierarchical structures: -------------
 *
 * Table items contain key-value pairs where the keys are offsets to char * key strings.
 * The values of these pairs are either Resource handles or
 * offsets into the 16-bit-units array, depending on the table type.
 *
 * Array items are simple vectors of Resource handles,
 * or of offsets into the 16-bit-units array, depending on the array type.
 *
 * Table key string offsets: -------
 *
 * Key string offsets are relative to the start of the resource data (of the root handle),
 * i.e., the first string has an offset of 4+sizeof(indexes).
 * (After the 4-byte root handle and after the indexes array.)
 *
 * If the resource bundle uses a pool bundle, then some key strings are stored
 * in the pool bundle rather than in the local bundle itself.
 * - In a Table or Table16, the 16-bit key string offset is local if it is
 *   less than indexes[URES_INDEX_KEYS_TOP]<<2.
 *   Otherwise, subtract indexes[URES_INDEX_KEYS_TOP]<<2 to get the offset into
 *   the pool bundle key strings.
 * - In a Table32, the 32-bit key string offset is local if it is non-negative.
 *   Otherwise, reset bit 31 to get the pool key string offset.
 *
 * Unlike the local offset, the pool key offset is relative to
 * the start of the key strings, not to the start of the bundle.
 *
 * An alias item is special (and new in ICU 2.4): --------------
 *
 * Its memory layout is just like for a UnicodeString, but at runtime it resolves to
 * another resource bundle's item according to the path in the string.
 * This is used to share items across bundles that are in different lookup/fallback
 * chains (e.g., large collation data among zh_TW and zh_HK).
 * This saves space (for large items) and maintenance effort (less duplication of data).
 *
 * --------------------------------------------------------------------------
 *
 * Resource types:
 *
 * Most resources have their values stored at four-byte offsets from the start
 * of the resource data. These values are at least 4-aligned.
 * Some resource values are stored directly in the offset field of the Resource itself.
 * See UResType in unicode/ures.h for enumeration constants for Resource types.
 *
 * Some resources have their values stored as sequences of 16-bit units,
 * at 2-byte offsets from the start of a contiguous 16-bit-unit array between
 * the table key strings and the other resources. (new in formatVersion 2/ICU 4.4)
 * At offset 0 of that array is a 16-bit zero value for empty 16-bit resources.
 *
 * Resource16 values in Table16 and Array16 are 16-bit offsets to String-v2
 * resources, with the offsets relative to the start of the 16-bit-units array.
 * Starting with formatVersion 3/ICU 56, if offset<poolStringIndex16Limit
 * then use the pool bundle's 16-bit-units array,
 * otherwise subtract that limit and use the local 16-bit-units array.
 *
 * Type Name            Memory layout of values
 *                      (in parentheses: scalar, non-offset values)
 *
 * 0  Unicode String:   int32_t length, UChar[length], (UChar)0, (padding)
 *                  or  (empty string ("") if offset==0)
 * 1  Binary:           int32_t length, uint8_t[length], (padding)
 *                      - the start of the bytes is 16-aligned -
 * 2  Table:            uint16_t count, uint16_t keyStringOffsets[count], (uint16_t padding), Resource[count]
 * 3  Alias:            (physically same value layout as string, new in ICU 2.4)
 * 4  Table32:          int32_t count, int32_t keyStringOffsets[count], Resource[count]
 *                      (new in formatVersion 1.1/ICU 2.8)
 * 5  Table16:          uint16_t count, uint16_t keyStringOffsets[count], Resource16[count]
 *                      (stored in the 16-bit-units array; new in formatVersion 2/ICU 4.4)
 * 6  Unicode String-v2:UChar[length], (UChar)0; length determined by the first UChar:
 *                      - if first is not a trail surrogate, then the length is implicit
 *                        and u_strlen() needs to be called
 *                      - if first<0xdfef then length=first&0x3ff (and skip first)
 *                      - if first<0xdfff then length=((first-0xdfef)<<16) | second UChar
 *                      - if first==0xdfff then length=((second UChar)<<16) | third UChar
 *                      (stored in the 16-bit-units array; new in formatVersion 2/ICU 4.4)
 *
 *                      Starting with formatVersion 3/ICU 56, if offset<poolStringIndexLimit
 *                      then use the pool bundle's 16-bit-units array,
 *                      otherwise subtract that limit and use the local 16-bit-units array.
 *                      (Note different limits for Resource16 vs. Resource.)
 *
 * 7  Integer:          (28-bit offset is integer value)
 * 8  Array:            int32_t count, Resource[count]
 * 9  Array16:          uint16_t count, Resource16[count]
 *                      (stored in the 16-bit-units array; new in formatVersion 2/ICU 4.4)
 * 14 Integer Vector:   int32_t length, int32_t[length]
 * 15 Reserved:         This value denotes special purpose resources and is for internal use.
 *
 * Note that there are 3 types with data vector values:
 * - Vectors of 8-bit bytes stored as type Binary.
 * - Vectors of 16-bit words stored as type Unicode String or Unicode String-v2
 *                     (no value restrictions, all values 0..ffff allowed!).
 * - Vectors of 32-bit words stored as type Integer Vector.
 */

/*
 * Structure for a single, memory-mapped ResourceBundle.
 */
typedef struct ResourceData {
    UDataMemory *data;
    const int32_t *pRoot;
    const uint16_t *p16BitUnits;
    const char *poolBundleKeys;
    Resource rootRes;
    int32_t localKeyLimit;
    const uint16_t *poolBundleStrings;
    int32_t poolStringIndexLimit;
    int32_t poolStringIndex16Limit;
    UBool noFallback; /* see URES_ATT_NO_FALLBACK */
    UBool isPoolBundle;
    UBool usesPoolBundle;
    UBool useNativeStrcmp;
    /* formatVersion 4 */
    /** How far to the left a field is shifted that is an offset in pCompact. */
    uint8_t fieldShift;
    /** A bundle's compact area, which says that it is of this version. A pool bundle's text. */
    const uint8_t *pCompact;
    /** What the string at the start of pCompact is known by among those that have been written out in UTF-16. */
    uint32_t wideStringKey;
    /** What the cells of the strings of pCompact stand for. */
    const uint16_t *grammar;
    const uint16_t *poolKeysets;
    const uint32_t *poolHeaders;
    /** Of a bundle. */
    const struct ResourceData *pool;
    /* Of a pool bundle. */
    const uint16_t *stringOffsets;
    int32_t stringOffsetsHighStart;
} ResourceData;

struct UResourceDataEntry;   // forward declared for ResoureDataValue below; actually defined in uresimp.h

/*
 * Read a resource bundle from memory.
 */
U_CAPI void U_EXPORT2
res_read(ResourceData *pResData,
         const UDataInfo *pInfo, const void *inBytes, int32_t length,
         UErrorCode *errorCode);

/*
 * Load a resource bundle file.
 * The ResourceData structure must be allocated externally.
 */
U_CFUNC void
res_load(ResourceData *pResData,
         const char *path, const char *name, UErrorCode *errorCode);

/*
 * Release a resource bundle file.
 * This does not release the ResourceData structure itself.
 */
U_CFUNC void
res_unload(ResourceData *pResData);

/** Frees what belongs to no one bundle. For when all have been unloaded. */
U_CFUNC void
res_cleanup();

/**
 * Loads a bundle that is inside its pool bundle (formatVersion 4).
 * @return false if the pool bundle has none of this name, or with a failure
 */
U_CFUNC UBool
res_loadFromPool(ResourceData *pResData, const ResourceData *pool, const char *name, UErrorCode *errorCode);

U_CAPI UResType U_EXPORT2
res_getPublicType(Resource res);

///////////////////////////////////////////////////////////////////////////
// To enable tracing, use the inline versions of the res_get* functions. //
///////////////////////////////////////////////////////////////////////////

/*
 * Return a pointer to a zero-terminated, const UChar* string
 * and set its length in *pLength.
 * Returns NULL if not found.
 */
U_CAPI const UChar * U_EXPORT2
res_getStringNoTrace(const ResourceData *pResData, Resource res, int32_t *pLength);

/**
 * What it means that res_getString() or res_getStringNoTrace() returned nullptr. A string of formatVersion 4
 * is written out in UTF-16 when it is first asked for, which takes memory.
 */
inline UErrorCode res_getStringError(Resource res) {
    return RES_GET_TYPE(res) == URES_STRING || RES_GET_TYPE(res) == URES_STRING_V2 ?
        U_MEMORY_ALLOCATION_ERROR : U_RESOURCE_TYPE_MISMATCH;
}

U_CAPI const uint8_t * U_EXPORT2
res_getBinaryNoTrace(const ResourceData *pResData, Resource res, int32_t *pLength);

U_CAPI const int32_t * U_EXPORT2
res_getIntVectorNoTrace(const ResourceData *pResData, Resource res, int32_t *pLength);

U_CAPI const UChar * U_EXPORT2
res_getAlias(const ResourceData *pResData, Resource res, int32_t *pLength);

U_CAPI Resource U_EXPORT2
res_getResource(const ResourceData *pResData, const char *key);

U_CAPI int32_t U_EXPORT2
res_countArrayItems(const ResourceData *pResData, Resource res);

U_CAPI Resource U_EXPORT2
res_getArrayItem(const ResourceData *pResData, Resource array, int32_t indexS);

U_CAPI Resource U_EXPORT2
res_getTableItemByIndex(const ResourceData *pResData, Resource table, int32_t indexS, const char ** key);

U_CAPI Resource U_EXPORT2
res_getTableItemByKey(const ResourceData *pResData, Resource table, int32_t *indexS, const char* * key);

/**
 * Iterates over the path and stops when a scalar resource is found.
 * Follows aliases.
 * Modifies the contents of *path (replacing separators with NULs),
 * and also moves *path forward while it finds items.
 *
 * @param path input: "CollationElements/Sequence" or "zoneStrings/3/2" etc.;
 *             output: points to the part that has not yet been processed
 */
U_CFUNC Resource res_findResource(const ResourceData *pResData, Resource r,
                                  char** path, const char** key);

#ifdef __cplusplus

#include "resource.h"
#include "restrace.h"

U_NAMESPACE_BEGIN

inline const char16_t* res_getString(const ResourceTracer& traceInfo,
        const ResourceData *pResData, Resource res, int32_t *pLength) {
    traceInfo.trace("string");
    return res_getStringNoTrace(pResData, res, pLength);
}

inline const uint8_t* res_getBinary(const ResourceTracer& traceInfo,
        const ResourceData *pResData, Resource res, int32_t *pLength) {
    traceInfo.trace("binary");
    return res_getBinaryNoTrace(pResData, res, pLength);
}

inline const int32_t* res_getIntVector(const ResourceTracer& traceInfo,
        const ResourceData *pResData, Resource res, int32_t *pLength) {
    traceInfo.trace("intvector");
    return res_getIntVectorNoTrace(pResData, res, pLength);
}

inline int32_t res_getInt(const ResourceTracer& traceInfo, Resource res) {
    traceInfo.trace("int");
    return RES_GET_INT_NO_TRACE(res);
}

inline uint32_t res_getUInt(const ResourceTracer& traceInfo, Resource res) {
    traceInfo.trace("uint");
    return RES_GET_UINT_NO_TRACE(res);
}

class ResourceDataValue : public ResourceValue {
public:
    ResourceDataValue() :
        pResData(nullptr),
        validLocaleDataEntry(nullptr),
        res(static_cast<Resource>(URES_NONE)),
        fTraceInfo() {}
    virtual ~ResourceDataValue();

    void setData(const ResourceData &data) {
        pResData = &data;
    }
    
    void setValidLocaleDataEntry(UResourceDataEntry *entry) {
        validLocaleDataEntry = entry;
    }

    void setResource(Resource r, ResourceTracer&& traceInfo) {
        res = r;
        fTraceInfo = traceInfo;
    }

    const ResourceData &getData() const { return *pResData; }
    UResourceDataEntry *getValidLocaleDataEntry() const { return validLocaleDataEntry; }
    Resource getResource() const { return res; }
    virtual UResType getType() const override;
    virtual const char16_t *getString(int32_t &length, UErrorCode &errorCode) const override;
    virtual const char16_t *getAliasString(int32_t &length, UErrorCode &errorCode) const override;
    virtual int32_t getInt(UErrorCode &errorCode) const override;
    virtual uint32_t getUInt(UErrorCode &errorCode) const override;
    virtual const int32_t *getIntVector(int32_t &length, UErrorCode &errorCode) const override;
    virtual const uint8_t *getBinary(int32_t &length, UErrorCode &errorCode) const override;
    virtual ResourceArray getArray(UErrorCode &errorCode) const override;
    virtual ResourceTable getTable(UErrorCode &errorCode) const override;
    virtual UBool isNoInheritanceMarker() const override;
    virtual int32_t getStringArray(UnicodeString *dest, int32_t capacity,
                                   UErrorCode &errorCode) const override;
    virtual int32_t getStringArrayOrStringAsArray(UnicodeString *dest, int32_t capacity,
                                                  UErrorCode &errorCode) const override;
    virtual UnicodeString getStringOrFirstOfArray(UErrorCode &errorCode) const override;

private:
    const ResourceData *pResData;
    UResourceDataEntry *validLocaleDataEntry;
    Resource res;
    ResourceTracer fTraceInfo;
};

U_NAMESPACE_END

#endif  /* __cplusplus */

/**
 * Swap an ICU resource bundle. See udataswp.h.
 * @internal
 */
U_CAPI int32_t U_EXPORT2
ures_swap(const UDataSwapper *ds,
          const void *inData, int32_t length, void *outData,
          UErrorCode *pErrorCode);

#endif
