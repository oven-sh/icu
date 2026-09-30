// Calls ICU's C API for every locale and time zone and prints each result with the status it left, warnings included.
// Only the C API, so that one binary runs with the libraries of unchanged ICU and with those of this one:
// the two outputs are to be identical.
//
// usage: LD_LIBRARY_PATH=<build>/lib:<build>/stubdata api > out.txt
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "unicode/ubrk.h"
#include "unicode/ucal.h"
#include "unicode/uclean.h"
#include "unicode/ucol.h"
#include "unicode/ucurr.h"
#include "unicode/udat.h"
#include "unicode/udatpg.h"
#include "unicode/udateintervalformat.h"
#include "unicode/uenum.h"
#include "unicode/uldnames.h"
#include "unicode/ulistformatter.h"
#include "unicode/uloc.h"
#include "unicode/unum.h"
#include "unicode/unumberformatter.h"
#include "unicode/upluralrules.h"
#include "unicode/ureldatefmt.h"
#include "unicode/usimplenumberformatter.h"
#include "unicode/ustring.h"

static std::string utf8(const char16_t* s, int32_t length) {
  if (length < 0 || s == nullptr) return "<none>";
  std::string out(length * 3 + 1, 0);
  int32_t n = 0;
  UErrorCode status = U_ZERO_ERROR;
  u_strToUTF8WithSub(out.data(), (int32_t)out.size(), &n, s, length, 0xfffd, nullptr, &status);
  out.resize(n);
  return out;
}

// A call is made with a status that is clean and with one that has a warning in it already, which a call may leave, replace or clear.
static const UErrorCode STARTS[] = {U_ZERO_ERROR, U_SAFECLONE_ALLOCATED_WARNING};

static void line(const char* what, const std::string& subject, UErrorCode start, UErrorCode status, const std::string& result) {
  printf("%s\t%s\t%s\t%s\t%s\n", what, subject.c_str(), start == U_ZERO_ERROR ? "" : "w", u_errorName(status), result.c_str());
}

template <typename F> static void chars(const char* what, const std::string& subject, F f) {
  for (UErrorCode start : STARTS) {
    char buffer[400];
    UErrorCode status = start;
    int32_t n = f(buffer, 400, &status);
    line(what, subject, start, status, U_SUCCESS(status) && n >= 0 && n < 400 ? std::string(buffer, n) : std::to_string(n));
  }
}

static void locale(const char* id) {
  chars("toLanguageTag", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_toLanguageTag(id, b, c, false, s); });
  chars("toLanguageTag strict", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_toLanguageTag(id, b, c, true, s); });
  chars("addLikelySubtags", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_addLikelySubtags(id, b, c, s); });
  chars("minimizeSubtags", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_minimizeSubtags(id, b, c, s); });
  chars("getLanguage", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_getLanguage(id, b, c, s); });
  chars("getCountry", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_getCountry(id, b, c, s); });
  chars("canonicalize", id, [&](char* b, int32_t c, UErrorCode* s) { return uloc_canonicalize(id, b, c, s); });
  line("ISO3", id, U_ZERO_ERROR, U_ZERO_ERROR, std::string(uloc_getISO3Language(id)) + " " + uloc_getISO3Country(id));
}

static const char16_t* const SKELETONS[] = {
  u"", u"currency/USD", u"currency/EUR unit-width-full-name", u"currency/JPY sign-accounting", u"currency/CHF unit-width-iso-code",
  u"compact-short", u"compact-long", u"compact-short currency/USD", u"percent", u"permille", u"scientific", u"engineering",
  u"measure-unit/length-meter unit-width-full-name", u"measure-unit/duration-hour unit-width-narrow", u"numbering-system/arab",
  u"latin", u"group-min2", u"group-off", u"group-on-aligned", u"group-thousands", u".00", u"integer-width/+000", u"sign-always",
};

static void numbers(const char* id) {
  char16_t buffer[300];
  for (const char16_t* skeleton : SKELETONS) {
    for (UErrorCode start : STARTS) {
      std::string subject = std::string(id) + " " + utf8(skeleton, u_strlen(skeleton));
      UErrorCode status = start;
      UNumberFormatter* f = unumf_openForSkeletonAndLocale(skeleton, -1, id, &status);
      line("unumf_open", subject, start, status, "");
      if (f == nullptr || U_FAILURE(status)) continue;
      UErrorCode ignored = U_ZERO_ERROR;
      UFormattedNumber* result = unumf_openResult(&ignored);
      // The formatter works out how to format anew for the first few numbers, then for good.
      for (double n : {1234567.891, -0.5, 1.0, 2.0, 1e9}) {
        status = start;
        unumf_formatDouble(f, n, result, &status);
        UErrorCode formatStatus = status;
        int32_t length = U_SUCCESS(status) ? unumf_resultToString(result, buffer, 300, &status) : -1;
        line("unumf_format", subject, start, formatStatus, utf8(buffer, length));
      }
      unumf_closeResult(result);
      unumf_close(f);
    }
  }
  for (int style : {UNUM_DECIMAL, UNUM_CURRENCY, UNUM_PERCENT, UNUM_SCIENTIFIC, UNUM_SPELLOUT, UNUM_ORDINAL, UNUM_CURRENCY_ISO,
                    UNUM_CURRENCY_PLURAL, UNUM_CURRENCY_ACCOUNTING, UNUM_CASH_CURRENCY, UNUM_DECIMAL_COMPACT_SHORT,
                    UNUM_DECIMAL_COMPACT_LONG, UNUM_CURRENCY_STANDARD}) {
    for (UErrorCode start : STARTS) {
      std::string subject = std::string(id) + " " + std::to_string(style);
      UErrorCode status = start;
      UNumberFormat* f = unum_open((UNumberFormatStyle)style, nullptr, 0, id, nullptr, &status);
      line("unum_open", subject, start, status, "");
      if (f == nullptr || U_FAILURE(status)) continue;
      for (double n : {1234567.891, -0.5, 1.0, 2.0, 123456.0}) {
        status = start;
        int32_t length = unum_formatDouble(f, n, buffer, 300, nullptr, &status);
        line("unum_format", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
      }
      status = start;
      int32_t length = unum_toPattern(f, false, buffer, 300, &status);
      line("unum_toPattern", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
      for (int symbol = 0; symbol < UNUM_FORMAT_SYMBOL_COUNT; symbol++) {
        status = start;
        length = unum_getSymbol(f, (UNumberFormatSymbol)symbol, buffer, 300, &status);
        line("unum_getSymbol", subject + " " + std::to_string(symbol), start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
      }
      unum_close(f);
    }
  }
  for (UErrorCode start : STARTS) {
    UErrorCode status = start;
    USimpleNumberFormatter* f = usnumf_openForLocale(id, &status);
    line("usnumf_open", id, start, status, "");
    if (U_FAILURE(status)) {
      // There is one all the same.
      usnumf_close(f);
      continue;
    }
    UErrorCode ignored = U_ZERO_ERROR;
    UFormattedNumber* result = unumf_openResult(&ignored);
    status = start;
    usnumf_formatInt64(f, 1234567, result, &status);
    UErrorCode formatStatus = status;
    int32_t length = U_SUCCESS(status) ? unumf_resultToString(result, buffer, 300, &status) : -1;
    line("usnumf_format", id, start, formatStatus, utf8(buffer, length));
    unumf_closeResult(result);
    usnumf_close(f);
  }
}

static void dates(const char* id) {
  char16_t buffer[400];
  const UDate when = 1700000000000.0;
  const UDateFormatStyle styles[] = {UDAT_FULL, UDAT_LONG, UDAT_MEDIUM, UDAT_SHORT, UDAT_NONE, UDAT_FULL_RELATIVE};
  for (UDateFormatStyle time : styles) {
    if (time == UDAT_FULL_RELATIVE) continue;
    for (UDateFormatStyle date : styles) {
      for (UErrorCode start : STARTS) {
        std::string subject = std::string(id) + " " + std::to_string(time) + "," + std::to_string(date);
        UErrorCode status = start;
        UDateFormat* f = udat_open(time, date, id, u"Europe/Paris", -1, nullptr, 0, &status);
        line("udat_open", subject, start, status, "");
        if (f == nullptr || U_FAILURE(status)) continue;
        status = start;
        int32_t length = udat_format(f, when, buffer, 400, nullptr, &status);
        line("udat_format", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
        status = start;
        length = udat_toPattern(f, false, buffer, 400, &status);
        line("udat_toPattern", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
        udat_close(f);
      }
    }
  }
  for (const char16_t* pattern : {u"y-MM-dd HH:mm:ss.SSS zzzz", u"EEEE, d MMMM y G", u"h:mm a B", u"QQQQ ww D F"}) {
    for (UErrorCode start : STARTS) {
      std::string subject = std::string(id) + " " + utf8(pattern, u_strlen(pattern));
      UErrorCode status = start;
      UDateFormat* f = udat_open(UDAT_PATTERN, UDAT_PATTERN, id, u"Asia/Tokyo", -1, pattern, -1, &status);
      line("udat_open pattern", subject, start, status, "");
      if (f == nullptr || U_FAILURE(status)) continue;
      // What JavaScriptCore does with each.
      status = start;
      ucal_setGregorianChange(const_cast<UCalendar*>(udat_getCalendar(f)), -8.64e15, &status);
      line("setGregorianChange of format", subject, start, status, "");
      for (UDate t : {when, -8.64e15, -62198755200000.0, -12219292800000.0, -12219292800001.0, 0.0}) {
        status = start;
        int32_t length = udat_format(f, t, buffer, 400, nullptr, &status);
        line("udat_format pattern", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
      }
      udat_close(f);
    }
  }
  // Changing the symbols of one format is not to change those of another, before or after, or of a clone.
  UErrorCode status = U_ZERO_ERROR;
  UDateFormat* before = udat_open(UDAT_NONE, UDAT_FULL, id, u"UTC", -1, nullptr, 0, &status);
  UDateFormat* changed = udat_open(UDAT_NONE, UDAT_FULL, id, u"UTC", -1, nullptr, 0, &status);
  if (U_SUCCESS(status)) {
    UDateFormat* clone = udat_clone(changed, &status);
    for (int32_t i = 0; i < udat_countSymbols(changed, UDAT_MONTHS); i++) udat_setSymbols(changed, UDAT_MONTHS, i, const_cast<char16_t*>(u"MOON"), -1, &status);
    for (int32_t i = 0; i < udat_countSymbols(changed, UDAT_WEEKDAYS); i++) udat_setSymbols(changed, UDAT_WEEKDAYS, i, const_cast<char16_t*>(u"DAY"), -1, &status);
    line("udat_setSymbols", id, U_ZERO_ERROR, status, "");
    UDateFormat* cloneOfChanged = udat_clone(changed, &status);
    UDateFormat* after = udat_open(UDAT_NONE, UDAT_FULL, id, u"UTC", -1, nullptr, 0, &status);
    const char* names[] = {"before", "changed", "clone", "clone of changed", "after"};
    UDateFormat* formats[] = {before, changed, clone, cloneOfChanged, after};
    for (int i = 0; i < 5; i++) {
      status = U_ZERO_ERROR;
      int32_t length = udat_format(formats[i], when, buffer, 400, nullptr, &status);
      line("udat_format symbols", std::string(id) + " " + names[i], U_ZERO_ERROR, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
    }
    udat_close(clone);
    udat_close(cloneOfChanged);
    udat_close(after);
  }
  udat_close(before);
  udat_close(changed);
}

static void calendars(const char* id) {
  for (UCalendarType type : {UCAL_DEFAULT, UCAL_GREGORIAN}) {
    for (UErrorCode start : STARTS) {
      std::string subject = std::string(id) + " " + std::to_string(type);
      UErrorCode status = start;
      UCalendar* c = ucal_open(u"America/New_York", -1, id, type, &status);
      line("ucal_open", subject, start, status, c ? ucal_getType(c, &status) : "");
      if (c == nullptr) continue;
      for (UDate change : {-8.64e15, 8.64e15, -12219292800000.0, 0.0, -1e18, 1e18, -62135769600000.0, -62135769600001.0}) {
        for (bool lenient : {true, false}) {
          ucal_setAttribute(c, UCAL_LENIENT, lenient);
          status = start;
          ucal_setGregorianChange(c, change, &status);
          UErrorCode changeStatus = status;
          std::string fields;
          for (UDate t : {change, change - 86400000.0, change + 86400000.0, 0.0, -12219292800000.0, -30000000000000.0}) {
            UErrorCode s = U_ZERO_ERROR;
            ucal_setMillis(c, t, &s);
            for (UCalendarDateFields field : {UCAL_ERA, UCAL_YEAR, UCAL_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_WEEK_OF_YEAR, UCAL_EXTENDED_YEAR})
              fields += std::to_string(ucal_get(c, field, &s)) + ",";
            fields += std::string(u_errorName(s)) + ";";
          }
          UErrorCode s = U_ZERO_ERROR;
          fields += std::to_string(ucal_getGregorianChange(c, &s));
          line("setGregorianChange", subject + " " + std::to_string(change) + (lenient ? "" : " strict"), start, changeStatus, fields);
        }
      }
      ucal_close(c);
    }
  }
}

static void others(const char* id) {
  char16_t buffer[300];
  for (UErrorCode start : STARTS) {
    UErrorCode status = start;
    URelativeDateTimeFormatter* r = ureldatefmt_open(id, nullptr, UDAT_STYLE_LONG, UDISPCTX_CAPITALIZATION_NONE, &status);
    line("ureldatefmt_open", id, start, status, "");
    for (double n : {-1.0, 2.0, 1234.5, 0.0, 5.0}) {
      if (r == nullptr) break;
      status = start;
      int32_t length = ureldatefmt_formatNumeric(r, n, UDAT_REL_UNIT_MONTH, buffer, 300, &status);
      line("ureldatefmt_format", id, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
    }
    ureldatefmt_close(r);
    status = start;
    UPluralRules* p = uplrules_open(id, &status);
    line("uplrules_open", id, start, status, "");
    for (double n : {0.0, 1.0, 2.0, 3.0, 11.0, 1.5, 1000000.0}) {
      if (p == nullptr) break;
      status = start;
      int32_t length = uplrules_select(p, n, buffer, 300, &status);
      line("uplrules_select", id, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
    }
    uplrules_close(p);
  }
}

template <typename F> static void units(const char* what, const std::string& subject, F f) {
  for (UErrorCode start : STARTS) {
    char16_t buffer[600];
    UErrorCode status = start;
    int32_t n = f(buffer, 600, &status);
    line(what, subject, start, status, U_SUCCESS(status) ? utf8(buffer, n < 600 ? n : -1) : std::to_string(n));
  }
}

// Has its NUL, which u_strlen() would stop at.
static const char16_t NUL_A[] = u"\u0000a";

static const char16_t* const TEXTS[] = {
  u"", u"a", u"A", u"b", u"\u00e4", u"a\u0308", u"ae", u"z", u"Z", u"\u00df", u"ss", u"ch", u"c", u"d", u"ll", u"l", u"\u00f1", u"n", u"o", u"\u00f6", u"oe",
  u"\u0153", u"resume", u"r\u00e9sum\u00e9", u"co-op", u"coop", u"10", u"9", u"a b", u"ab", u"\u0430", u"\u044f", u"\u0451", u"\u03b1", u"\u03c9", u"\u05d0", u"\u05ea",
  u"\u0627", u"\u064a", u"\u0905", u"\u0939", u"\u0915\u094d\u0937", u"\u0e01", u"\u0e40\u0e01", u"\u0e2e", u"\u1000", u"\u1780", u"\u3042", u"\u30a2", u"\uff71", u"\u30fc",
  u"\u30ab\u30fc", u"\u4e00", u"\u4e8c", u"\u9fa5", u"\u3400", u"\uac00", u"\ud7a3", u"\u1100\u1161", u"\u1112", u"\U00020000", u"\U0002a6d6", u"\U0001f600", u"\U0001f1fa\U0001f1f8",
  u"\U00010400", u"\U0001d400", u"\U0010ffff", u"\xd800", u"\xdc00", u"a\xd800", u"\xd800" u"a", u"\xdc00\xd800", u"\ufffe", u"\uffff", u"\ufffd", NUL_A, u"\u0301", u"\u0f71\u0f72",
  u"\u0f73", u"\u200d", u"\u00ad", u"\u2028", u"I", u"i", u"\u0130", u"\u0131", u"\u01c4", u"\u01c5", u"lj", u"\u01c9", u"\u1e9e", u"\ufb01", u"fi", u"\u2460", u"\u00bd",
};

static int32_t lengthOf(const char16_t* text) { return text == NUL_A ? 2 : u_strlen(text); }

static void collation(const char* id) {
  std::vector<std::string> ids = {id};
  UErrorCode status = U_ZERO_ERROR;
  if (strchr(id, '@') == nullptr) {
    UEnumeration* types = ucol_getKeywordValuesForLocale("collation", id, false, &status);
    std::string all;
    while (const char* type = uenum_next(types, nullptr, &status)) {
      all += std::string(type) + " ";
      ids.push_back(std::string(id) + "@collation=" + type);
    }
    line("collation types", id, U_ZERO_ERROR, status, all);
    uenum_close(types);
    ids.push_back(std::string(id) + "@colNumeric=yes;colCaseFirst=upper");
    ids.push_back(std::string(id) + "@colStrength=primary;colAlternate=shifted");
  }
  for (const std::string& subject : ids) {
    for (UErrorCode start : STARTS) {
      status = start;
      UCollator* c = ucol_open(subject.c_str(), &status);
      UErrorCode s = U_ZERO_ERROR;
      line("ucol_open", subject, start, status, c ? std::string(ucol_getLocaleByType(c, ULOC_ACTUAL_LOCALE, &s)) + " " + ucol_getLocaleByType(c, ULOC_VALID_LOCALE, &s) : "");
      if (c == nullptr || start != U_ZERO_ERROR) {
        ucol_close(c);
        continue;
      }
      unsigned long long hash = 0xcbf29ce484222325ull;
      const int count = sizeof(TEXTS) / sizeof(TEXTS[0]);
      for (int i = 0; i < count; i++) {
        int32_t length = lengthOf(TEXTS[i]);
        uint8_t key[400];
        int32_t n = ucol_getSortKey(c, TEXTS[i], length, key, 400);
        for (int32_t k = 0; k < n && k < 400; k++) hash = (hash ^ key[k]) * 0x100000001b3ull;
        for (int j = 0; j < count; j++) hash = (hash ^ (unsigned)(ucol_strcoll(c, TEXTS[i], length, TEXTS[j], lengthOf(TEXTS[j])) + 1)) * 0x100000001b3ull;
      }
      char text[20];
      snprintf(text, sizeof text, "%016llx", hash);
      line("sort keys and comparisons", subject, start, U_ZERO_ERROR, text);
      ucol_close(c);
    }
  }
}

static void names(const char* id) {
  for (UErrorCode start : STARTS) {
    UErrorCode status = start;
    ULocaleDisplayNames* d = uldn_open(id, ULDN_STANDARD_NAMES, &status);
    line("uldn_open", id, start, status, "");
    if (d == nullptr || U_FAILURE(status)) continue;
    char16_t b[300];
    auto show = [&](const char* what, const char* code, int32_t (*f)(const ULocaleDisplayNames*, const char*, char16_t*, int32_t, UErrorCode*)) {
      status = start;
      int32_t n = f(d, code, b, 300, &status);
      line(what, std::string(id) + " " + code, start, status, utf8(b, U_SUCCESS(status) ? n : -1));
    };
    for (const char* code : {"en", "de", "zh", "zh_Hant", "pt_BR", "es_419", "yue", "xx", "root", "und", "sr_Latn_RS", "en_US@calendar=japanese;numbers=arab"}) show("uldn_locale", code, uldn_localeDisplayName);
    for (const char* code : {"en", "fr", "ja", "haw", "zz", "tlh"}) show("uldn_language", code, uldn_languageDisplayName);
    for (const char* code : {"US", "JP", "DE", "001", "419", "ZZ", "XK", "QQ"}) show("uldn_region", code, uldn_regionDisplayName);
    for (const char* code : {"Latn", "Cyrl", "Hans", "Hant", "Arab", "Zzzz", "Qaaa"}) show("uldn_script", code, uldn_scriptDisplayName);
    for (const char* code : {"calendar", "collation", "numbers", "currency", "bogus"}) show("uldn_key", code, uldn_keyDisplayName);
    uldn_close(d);
  }
  for (const char16_t* currency : {u"USD", u"EUR", u"JPY", u"CHF", u"XXX", u"ZZZ", u"BTC"}) {
    for (UCurrNameStyle style : {UCURR_SYMBOL_NAME, UCURR_LONG_NAME, UCURR_NARROW_SYMBOL_NAME}) {
      for (UErrorCode start : STARTS) {
        UErrorCode status = start;
        int32_t n = 0;
        const char16_t* name = ucurr_getName(currency, id, style, nullptr, &n, &status);
        line("ucurr_getName", std::string(id) + " " + utf8(currency, 3) + " " + std::to_string(style), start, status, utf8(name, U_SUCCESS(status) ? n : -1));
      }
    }
    for (const char* plural : {"one", "other", "few"}) {
      UErrorCode status = U_ZERO_ERROR;
      int32_t n = 0;
      const char16_t* name = ucurr_getPluralName(currency, id, nullptr, plural, &n, &status);
      line("ucurr_getPluralName", std::string(id) + " " + utf8(currency, 3) + " " + plural, U_ZERO_ERROR, status, utf8(name, U_SUCCESS(status) ? n : -1));
    }
  }
  units("ucurr_forLocale", id, [&](char16_t* b, int32_t c, UErrorCode* s) { return ucurr_forLocale(id, b, c, s); });
}

static void patterns(const char* id) {
  for (UErrorCode start : STARTS) {
    UErrorCode status = start;
    UDateTimePatternGenerator* g = udatpg_open(id, &status);
    line("udatpg_open", id, start, status, "");
    if (g == nullptr || U_FAILURE(status)) continue;
    char16_t b[300];
    for (const char16_t* skeleton : {u"yMd", u"yMMMMd", u"yMMMEd", u"jm", u"jms", u"Hm", u"hm", u"jmz", u"GyMMMd", u"MMMMEEEEd", u"yQQQ", u"yw", u"Bhm", u"jjmm", u"CCmm", u"yMMMMEEEEdjmszzzz", u"SSS", u"U"}) {
      status = start;
      int32_t n = udatpg_getBestPattern(g, skeleton, -1, b, 300, &status);
      line("getBestPattern", std::string(id) + " " + utf8(skeleton, u_strlen(skeleton)), start, status, utf8(b, U_SUCCESS(status) ? n : -1));
    }
    status = start;
    line("getDefaultHourCycle", id, start, status, std::to_string(udatpg_getDefaultHourCycle(g, &status)) + " " + u_errorName(status));
    udatpg_close(g);
    for (const char16_t* skeleton : {u"yMMMd", u"jm", u"yMMMMEEEEdjm"}) {
      status = start;
      UDateIntervalFormat* f = udtitvfmt_open(id, skeleton, -1, u"UTC", -1, &status);
      line("udtitvfmt_open", std::string(id) + " " + utf8(skeleton, u_strlen(skeleton)), start, status, "");
      if (f == nullptr || U_FAILURE(status)) continue;
      for (UDate to : {1700000000000.0 + 3600000, 1700000000000.0 + 86400000 * 3.0, 1700000000000.0 + 86400000 * 400.0}) {
        status = start;
        int32_t n = udtitvfmt_format(f, 1700000000000.0, to, b, 300, nullptr, &status);
        line("udtitvfmt_format", std::string(id) + " " + utf8(skeleton, u_strlen(skeleton)), start, status, utf8(b, U_SUCCESS(status) ? n : -1));
      }
      udtitvfmt_close(f);
    }
  }
}

static void breaks(const char* id) {
  static const char16_t text[] =
    u"Hello, world! It's 3.14 e.g. Mr. Smith's co-op. \u00bfQu\u00e9? \u4eca\u65e5\u306f\u826f\u3044\u5929\u6c17\u3067\u3059\u306d\u3002\u6211\u4eec\u5728\u5317\u4eac\u5b66\u4e60\u4e2d\u6587\u3002 "
    u"\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a\u0e1c\u0e21\u0e0a\u0e37\u0e48\u0e2d\u0e2a\u0e21\u0e0a\u0e32\u0e22 \u1785\u17c6\u178e\u17c1\u17c7\u178a\u17b9\u1784 \u1019\u103c\u1014\u103a\u1019\u102c\u1005\u102c \u0eaa\u0eb0\u0e9a\u0eb2\u0e8d\u0e94\u0eb5 "
    u"\U0001f468\u200d\U0001f469\u200d\U0001f467 \U0001f1fa\U0001f1f8\U0001f1e9\U0001f1ea e\u0301\u0323 \uac01\u1100\u1161\u11a8 \xd800 x\r\ny";
  for (UBreakIteratorType type : {UBRK_CHARACTER, UBRK_WORD, UBRK_LINE, UBRK_SENTENCE}) {
    for (UErrorCode start : STARTS) {
      UErrorCode status = start;
      UBreakIterator* b = ubrk_open(type, id, text, -1, &status);
      std::string all;
      if (b != nullptr && U_SUCCESS(status))
        for (int32_t at = ubrk_first(b); at != UBRK_DONE; at = ubrk_next(b)) all += std::to_string(at) + ":" + std::to_string(ubrk_getRuleStatus(b)) + " ";
      line("ubrk", std::string(id) + " " + std::to_string(type), start, status, all);
      ubrk_close(b);
    }
  }
  for (UListFormatterType type : {ULISTFMT_TYPE_AND, ULISTFMT_TYPE_OR, ULISTFMT_TYPE_UNITS}) {
    for (UListFormatterWidth width : {ULISTFMT_WIDTH_WIDE, ULISTFMT_WIDTH_SHORT, ULISTFMT_WIDTH_NARROW}) {
      for (UErrorCode start : STARTS) {
        UErrorCode status = start;
        UListFormatter* f = ulistfmt_openForType(id, type, width, &status);
        line("ulistfmt_open", std::string(id) + " " + std::to_string(type) + std::to_string(width), start, status, "");
        if (f == nullptr || U_FAILURE(status)) continue;
        const char16_t* items[] = {u"a", u"i", u"o", u"hijo"};
        char16_t out[200];
        for (int32_t count : {1, 2, 3, 4}) {
          status = start;
          int32_t n = ulistfmt_format(f, items, nullptr, count, out, 200, &status);
          line("ulistfmt_format", std::string(id) + " " + std::to_string(type) + std::to_string(width), start, status, utf8(out, U_SUCCESS(status) ? n : -1));
        }
        ulistfmt_close(f);
      }
    }
  }
}

static void zone(const std::u16string& id) {
  std::string subject = utf8(id.data(), (int32_t)id.size());
  char16_t buffer[200];
  for (UErrorCode start : STARTS) {
    UErrorCode status = start;
    UBool system = 2;
    int32_t length = ucal_getCanonicalTimeZoneID(id.data(), (int32_t)id.size(), buffer, 200, &system, &status);
    line("getCanonicalTimeZoneID", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1) + " " + std::to_string(system));
    status = start;
    length = ucal_getIanaTimeZoneID(id.data(), (int32_t)id.size(), buffer, 200, &status);
    line("getIanaTimeZoneID", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
    status = start;
    length = ucal_getWindowsTimeZoneID(id.data(), (int32_t)id.size(), buffer, 200, &status);
    line("getWindowsTimeZoneID", subject, start, status, utf8(buffer, U_SUCCESS(status) ? length : -1));
    status = start;
    UCalendar* c = ucal_open(id.data(), (int32_t)id.size(), "en", UCAL_GREGORIAN, &status);
    UErrorCode openStatus = status;
    status = start;
    length = c ? ucal_getTimeZoneID(c, buffer, 200, &status) : -1;
    line("ucal_open zone", subject, start, openStatus, utf8(buffer, U_SUCCESS(status) ? length : -1));
    ucal_close(c);
    status = start;
    int32_t n = ucal_getTimeZoneIDForWindowsID(id.data(), (int32_t)id.size(), nullptr, buffer, 200, &status);
    line("getTimeZoneIDForWindowsID", subject, start, status, utf8(buffer, U_SUCCESS(status) ? n : -1));
  }
}

int main(int argc, char** argv) {
  const char* only = argc > 1 ? argv[1] : "";
  auto wanted = [&](const char* what) { return *only == 0 || strcmp(only, what) == 0; };
  std::vector<std::string> locales;
  for (int32_t i = 0; i < uloc_countAvailable(); i++) locales.push_back(uloc_getAvailable(i));
  size_t available = locales.size();
  for (const char* base : {"en", "de", "ar", "ar_EG", "hi", "ja", "zh_Hant_TW", "th", "fa", "he", "my", "ne", "root", "sr_Latn", "en_IN", "pl", "es_419"})
    for (const char* keywords : {"@numbers=arab", "@numbers=latn", "@numbers=hanidec", "@numbers=native", "@numbers=traditional", "@numbers=finance",
                                 "@numbers=bogus", "@numbers=roman", "@calendar=japanese", "@calendar=buddhist", "@calendar=islamic-umalqura",
                                 "@calendar=hebrew", "@calendar=chinese", "@currency=EUR", "@calendar=gregorian;numbers=thai", "@hours=h23"})
      locales.push_back(std::string(base) + keywords);
  for (const char* odd : {"", "xx", "xx_YY", "en_ZZ", "en_001", "en_150", "und", "und_US", "und_Arab", "de__POSIX", "en_US_POSIX", "C", "posix", "iw", "iw_IL", "in",
                          "in_ID", "ji", "jw", "mo", "sh", "sh_BA", "no", "no_NO_NY", "tl", "aam", "adp", "eng", "eng_USA", "deu_DEU", "ENG", "zho_Hans_CHN", "zh_GAN",
                          "zh_MIN_NAN", "zh_YUE", "art__LOJBAN", "hy__AREVELA", "ja_JP_TRADITIONAL", "th_TH_TRADITIONAL", "en_BU", "de_DD", "fr_FX", "sr_YU", "en_840",
                          "es_419", "x", "abcdefghi", "en_Latn_US_VARIANT1_VARIANT2", "en-US", "en-u-nu-arab", "de-DE-u-co-phonebk", "a_b_c_d_e_f", "12", "en_", "_US",
                          "en@", "en@x=y", "en_US@calendar", "toolonglanguagesubtagthatgoesonandonandonandonandonandonandonandonandon"})
    locales.push_back(odd);
  for (size_t i = 0; i < locales.size(); i++) {
    const char* id = locales[i].c_str();
    if (wanted("locale")) locale(id);
    if (wanted("numbers")) numbers(id);
    if (wanted("dates")) dates(id);
    // Not by locale but for the week data, which the first few and the odd ones are enough for.
    if (wanted("calendars") && (i < 40 || i >= available)) calendars(id);
    if (wanted("others")) others(id);
    if (wanted("collation")) collation(id);
    if (wanted("names")) names(id);
    if (wanted("patterns")) patterns(id);
    if (wanted("breaks")) breaks(id);
  }
  if (wanted("zones")) {
    std::vector<std::u16string> zones;
    for (USystemTimeZoneType type : {UCAL_ZONE_TYPE_ANY, UCAL_ZONE_TYPE_CANONICAL, UCAL_ZONE_TYPE_CANONICAL_LOCATION}) {
      for (const char* region : {(const char*)nullptr, "US", "001", "ZZ"}) {
        UErrorCode status = U_ZERO_ERROR;
        UEnumeration* e = ucal_openTimeZoneIDEnumeration(type, region, nullptr, &status);
        std::string all;
        int32_t length;
        while (const char16_t* id = uenum_unext(e, &length, &status)) {
          all += utf8(id, length) + " ";
          if (type == UCAL_ZONE_TYPE_ANY && region == nullptr) zones.emplace_back(id, length);
        }
        line("openTimeZoneIDEnumeration", std::to_string(type) + " " + (region ? region : "-"), U_ZERO_ERROR, status, all);
        uenum_close(e);
      }
    }
    for (const char16_t* odd : {u"", u"Etc/Unknown", u"Nowhere/Land", u"america/new_york", u"AMERICA/NEW_YORK", u"GMT+3", u"GMT-03:30", u"UTC+1", u"EST5EDT", u"PST", u"JST",
                                u"Pacific Standard Time", u"W. Europe Standard Time", u"Asia/Calcutta", u"Europe/Kiev", u"America/Godthab", u"US/Pacific", u"é",
                                u"America/Argentina/ComodRivadavia", u"a/very/long/time/zone/identifier/that/goes/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on"})
      zones.emplace_back(odd);
    // Twice: the first answer is worked out, the second is remembered.
    for (int round = 0; round < 2; round++)
      for (const auto& id : zones) zone(id);
  }
  // So that what ICU still has then is a leak to a tool that looks for those.
  u_cleanup();
}
