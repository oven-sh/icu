// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// oven-sh/icu

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING
#ifndef __NUMBER_LOCALEDATA_H__
#define __NUMBER_LOCALEDATA_H__

#include <atomic>

#include "unicode/dcfmtsym.h"
#include "unicode/locid.h"
#include "unicode/numsys.h"
#include "number_utils.h"
#include "sharedobject.h"
#include "unifiedcache.h"

U_NAMESPACE_BEGIN

/**
 * What making a number formatter needs to know about its locale, and would otherwise find out each time:
 * that takes most of the time that making a formatter and using it once does,
 * and a formatter is made anew for each of the first few numbers it formats.
 *
 * From UnifiedCache::getByLocale(). It is by locale, so it is of no use with a numbering system that the locale does not say.
 *
 * Finding these things out may leave a warning in the caller's status, such as that the locale fell back to root.
 * So the warning is kept with each, for warn() to leave it there as well, and only for what the caller does use.
 */
class SharedNumberLocaleData : public SharedObject {
public:
    /** @param nsStatus what NumberingSystem::createInstance(locale, nsStatus), which ns is from, made of U_ZERO_ERROR */
    SharedNumberLocaleData(const Locale &locale, const NumberingSystem &ns, UErrorCode nsStatus);
    virtual ~SharedNumberLocaleData();

    static void warn(UErrorCode warning, UErrorCode &status) {
        if (warning != U_ZERO_ERROR) {
            status = warning;
        }
    }

    /** utils::getPatternForStyle(locale, nsName, style, status) */
    const char16_t *getPattern(number::impl::CldrPatternStyle style, UErrorCode &status) const;

    /** The name of the numbering system that the locale says, NumberingSystem::createInstance(). */
    char nsName[9];
    const UErrorCode nsStatus;
    /** What the constructor of the symbols made of U_ZERO_ERROR. */
    UErrorCode symbolsStatus = U_ZERO_ERROR;
    /** With that numbering system. */
    const DecimalFormatSymbols symbols;
    /** For Grouper::setLocaleData(), which leaves no warning. */
    mutable std::atomic<int16_t> minGrouping{-1};

private:
    /** nullptr until asked for. */
    mutable std::atomic<const char16_t *> patterns[number::impl::CLDR_PATTERN_STYLE_COUNT];
    mutable std::atomic<UErrorCode> patternStatuses[number::impl::CLDR_PATTERN_STYLE_COUNT];
};

template<> U_I18N_API
const SharedNumberLocaleData *LocaleCacheKey<SharedNumberLocaleData>::createObject(
        const void * /*unused*/, UErrorCode &status) const;

U_NAMESPACE_END

#endif //__NUMBER_LOCALEDATA_H__
#endif /* #if !UCONFIG_NO_FORMATTING */
