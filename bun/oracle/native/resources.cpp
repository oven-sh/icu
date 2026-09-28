// Do two data packages hold the same resource bundles, as ICU reads them?
//
// Walks every resource of the bundles named on stdin ("<tree or -> <name>" per line) through each way ICU has of getting
// at one, checks that the ways agree with each other, and prints a hash of what it saw per bundle. Run it on both
// packages and compare the output. See ../README.md.
//
//   resources [--public] < bundles.txt      with ICU_DATA=<directory of icudt<version>l.dat>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "resource.h"
#include "unicode/unistr.h"
#include "unicode/ures.h"
#include "unicode/ustring.h"
#include "uresdata.h"
#include "uresimp.h"

using namespace icu;

static long checks = 0;
static std::string where;

#define CHECK(condition)                                                                             \
  do {                                                                                               \
    ++checks;                                                                                        \
    if (!(condition)) {                                                                              \
      fprintf(stderr, "line %d: %s\n  at %s\n", __LINE__, #condition, where.c_str());                 \
      exit(2);                                                                                       \
    }                                                                                                \
  } while (0)

static std::string printable(const char16_t* s, int32_t length) {
  std::string out;
  char escape[8];
  for (int32_t i = 0; i < length; i++) {
    if (0x20 <= s[i] && s[i] < 0x7f && s[i] != '\\') {
      out += static_cast<char>(s[i]);
    } else {
      snprintf(escape, sizeof escape, "\\%04x", s[i]);
      out += escape;
    }
  }
  return out;
}

struct Value : ResourceDataValue {
  Value(const ResourceData* data, UResourceDataEntry* entry, Resource res) {
    setData(*data);
    setValidLocaleDataEntry(entry);
    setResource(res, ResourceTracer());
  }
};

// uresdata.h's functions and the ResourceValue classes, which is what ICU's own code uses. Aliases are not followed.
static void walk(const ResourceData* data, UResourceDataEntry* entry, Resource res, const std::string& path, std::string& out) {
  where = path;
  UErrorCode status = U_ZERO_ERROR;
  Value value(data, entry, res);
  UResType type = res_getPublicType(res);
  CHECK(value.getType() == type);

  switch (type) {
    case URES_STRING: {
      int32_t length, again;
      const char16_t* s = res_getStringNoTrace(data, res, &length);
      CHECK(s != nullptr && s[length] == 0 && u_strlen(s) <= length);
      // The pointer is the caller's to keep.
      CHECK(res_getStringNoTrace(data, res, &again) == s && again == length);
      CHECK(value.getString(again, status) == s && again == length);
      bool marker = length == 3 && s[0] == 0x2205 && s[1] == 0x2205 && s[2] == 0x2205;
      CHECK(!!value.isNoInheritanceMarker() == marker);
      CHECK(res_countArrayItems(data, res) == 1);
      out += path + " = \"" + printable(s, length) + "\"\n";
      break;
    }
    case URES_ALIAS: {
      int32_t length;
      const char16_t* s = res_getAlias(data, res, &length);
      out += path + " -> " + printable(s, length) + "\n";
      break;
    }
    case URES_INT: out += path + " = int " + std::to_string(RES_GET_INT_NO_TRACE(res)) + "\n"; break;
    case URES_INT_VECTOR: {
      int32_t length;
      const int32_t* v = res_getIntVectorNoTrace(data, res, &length);
      out += path + " = intvector";
      for (int32_t i = 0; i < length; i++) out += " " + std::to_string(v[i]);
      out += "\n";
      break;
    }
    case URES_BINARY: {
      int32_t length;
      const uint8_t* b = res_getBinaryNoTrace(data, res, &length);
      unsigned hash = 0;
      for (int32_t i = 0; i < length; i++) hash = hash * 31 + b[i];
      out += path + " = binary " + std::to_string(length) + " " + std::to_string(hash) + "\n";
      break;
    }
    case URES_TABLE: {
      int32_t n = res_countArrayItems(data, res);
      ResourceTable table = value.getTable(status);
      CHECK(U_SUCCESS(status) && table.getSize() == n);
      out += path + " {" + std::to_string(n) + "}\n";

      std::vector<std::pair<std::string, Resource>> items;
      const char* previous = nullptr;
      for (int32_t i = 0; i < n; i++) {
        where = path + "[" + std::to_string(i) + "]";
        const char* key = nullptr;
        Resource item = res_getTableItemByIndex(data, res, i, &key);
        CHECK(item != RES_BOGUS && key != nullptr);
        CHECK(previous == nullptr || strcmp(previous, key) < 0);
        previous = key;
        CHECK(res_getTableItemByIndex(data, res, i, nullptr) == item);

        // By key, given the table's own pointer and given a copy.
        std::string copy(key);
        for (const char* asked : {key, copy.c_str()}) {
          int32_t index = -5;
          CHECK(res_getTableItemByKey(data, res, &index, &asked) == item && index == i && asked == key);
        }
        Value found(data, entry, RES_BOGUS);
        const char* foundKey = nullptr;
        CHECK(table.getKeyAndValue(i, foundKey, found) && foundKey == key && found.getResource() == item);
        CHECK(table.findValue(copy.c_str(), found) && found.getResource() == item);
        items.push_back({copy, item});
      }
      where = path;
      // Keys that are near ones the table has, and before and after all of them.
      for (auto& [key, item] : items) {
        for (std::string absent : {key + "x", key.substr(0, key.size() - 1), std::string("\x01"), std::string("~~~")}) {
          bool present = absent.empty();
          for (auto& other : items) present = present || other.first == absent;
          if (present) continue;
          const char* asked = absent.c_str();
          int32_t index;
          Value found(data, entry, RES_BOGUS);
          CHECK(res_getTableItemByKey(data, res, &index, &asked) == RES_BOGUS);
          CHECK(!table.findValue(absent.c_str(), found));
        }
      }
      const char* key;
      Value none(data, entry, RES_BOGUS);
      CHECK(res_getTableItemByIndex(data, res, n, &key) == RES_BOGUS);
      CHECK(res_getTableItemByIndex(data, res, -1, &key) == RES_BOGUS);
      CHECK(!table.getKeyAndValue(n, key, none));
      // Not in order: a table remembers where it was last read.
      for (int32_t i = n - 1; i >= 0; i -= 3) {
        CHECK(table.getKeyAndValue(i, key, none) && none.getResource() == items[i].second);
      }
      for (auto& [name, item] : items) walk(data, entry, item, path + "/" + name, out);
      break;
    }
    case URES_ARRAY: {
      int32_t n = res_countArrayItems(data, res);
      ResourceArray array = value.getArray(status);
      CHECK(U_SUCCESS(status) && array.getSize() == n);
      out += path + " [" + std::to_string(n) + "]\n";

      std::vector<Resource> items;
      bool allStrings = n > 0;
      for (int32_t i = 0; i < n; i++) {
        where = path + "[" + std::to_string(i) + "]";
        Resource item = res_getArrayItem(data, res, i);
        Value found(data, entry, RES_BOGUS);
        CHECK(item != RES_BOGUS && array.internalGetResource(data, i) == item);
        CHECK(array.getValue(i, found) && found.getResource() == item);
        items.push_back(item);
        allStrings = allStrings && res_getPublicType(item) == URES_STRING;
      }
      where = path;
      CHECK(res_getArrayItem(data, res, n) == RES_BOGUS && res_getArrayItem(data, res, -1) == RES_BOGUS);
      if (allStrings) {
        std::vector<UnicodeString> strings(n);
        CHECK(value.getStringArray(strings.data(), n, status) == n && U_SUCCESS(status));
        for (int32_t i = 0; i < n; i++) {
          int32_t length;
          const char16_t* s = res_getStringNoTrace(data, items[i], &length);
          CHECK(strings[i] == UnicodeString(false, s, length));
        }
      }
      for (int32_t i = 0; i < n; i++) walk(data, entry, items[i], path + "/" + std::to_string(i), out);
      break;
    }
    default: CHECK(false);
  }
}

// ures.h. Aliases are followed, and a lookup that fails is part of the output: it has to fail the same way.
static void walkPublic(UResourceBundle* bundle, const std::string& path, std::string& out, int depth) {
  where = "public " + path;
  UErrorCode status = U_ZERO_ERROR;
  UResType type = ures_getType(bundle);
  int32_t n = ures_getSize(bundle);
  if (type == URES_STRING) {
    int32_t length;
    const char16_t* s = ures_getString(bundle, &length, &status);
    CHECK(U_SUCCESS(status));
    out += path + " = \"" + printable(s, length) + "\"\n";
    return;
  }
  if (type != URES_TABLE && type != URES_ARRAY) {
    out += path + " type " + std::to_string(type) + "\n";
    return;
  }
  out += path + (type == URES_TABLE ? " {" : " [") + std::to_string(n) + "\n";
  if (depth > 12) return;

  ures_resetIterator(bundle);
  int32_t i = 0;
  for (; ures_hasNext(bundle); i++) {
    status = U_ZERO_ERROR;
    LocalUResourceBundlePointer item(ures_getNextResource(bundle, nullptr, &status));
    if (U_FAILURE(status)) {
      out += path + "/#" + std::to_string(i) + " !" + u_errorName(status) + "\n";
      continue;
    }
    const char* key = ures_getKey(item.getAlias());
    std::string name = path + "/" + (type == URES_TABLE && key ? key : std::to_string(i));
    auto sameAs = [&](const char* how, UResourceBundle* other, UErrorCode otherStatus) {
      LocalUResourceBundlePointer owned(other);
      out += name + " " + how + " " + u_errorName(otherStatus) + "\n";
      if (U_FAILURE(otherStatus)) return;
      CHECK(ures_getType(other) == ures_getType(item.getAlias()) && ures_getSize(other) == ures_getSize(item.getAlias()));
    };
    UErrorCode other = U_ZERO_ERROR;
    UResourceBundle* byIndex = ures_getByIndex(bundle, i, nullptr, &other);
    sameAs("byIndex", byIndex, other);
    if (type == URES_TABLE && key) {
      other = U_ZERO_ERROR;
      UResourceBundle* byKey = ures_getByKey(bundle, key, nullptr, &other);
      sameAs("byKey", byKey, other);
      if (ures_getType(item.getAlias()) == URES_STRING) {
        int32_t l1 = 0, l2 = 0, l3 = 0;
        other = U_ZERO_ERROR;
        const char16_t* s1 = ures_getString(item.getAlias(), &l1, &other);
        const char16_t* s2 = ures_getStringByKey(bundle, key, &l2, &other);
        const char16_t* s3 = ures_getStringByIndex(bundle, i, &l3, &other);
        out += name + " strings " + u_errorName(other) + "\n";
        if (U_SUCCESS(other)) CHECK(s1 == s2 && s1 == s3 && l1 == l2 && l1 == l3);
      }
    }
    walkPublic(item.getAlias(), name, out, depth + 1);
  }
  CHECK(i == n);
}

int main(int argc, char** argv) {
  bool isPublic = argc > 1 && strcmp(argv[1], "--public") == 0;
  std::string tree, name;
  long bundles = 0, missing = 0;
  while (std::cin >> tree >> name) {
    UErrorCode status = U_ZERO_ERROR;
    std::string package = "icudt" U_ICU_VERSION_SHORT "l-" + tree;
    LocalUResourceBundlePointer bundle(ures_openDirect(tree == "-" ? nullptr : package.c_str(), name.c_str(), &status));
    if (U_FAILURE(status)) {
      printf("%s/%s !%s\n", tree.c_str(), name.c_str(), u_errorName(status));
      missing++;
      continue;
    }
    std::string out;
    if (isPublic) {
      walkPublic(bundle.getAlias(), "", out, 0);
    } else {
      const ResourceData& data = bundle->getResData();
      walk(&data, bundle->fValidLocaleDataEntry, data.rootRes, "", out);
    }
    unsigned long long hash = 1469598103934665603ULL;
    for (unsigned char c : out) hash = (hash ^ c) * 1099511628211ULL;
    printf("%s/%s %zu %016llx\n", tree.c_str(), name.c_str(), out.size(), hash);
    // What is behind a hash, to diff.
    if (const char* dump = getenv("DUMP"); dump && name == dump) fputs(out.c_str(), stderr);
    bundles++;
  }
  fprintf(stderr, "%ld bundles, %ld checks, %ld bundles that could not be opened\n", bundles, checks, missing);
  // Two packages that are not there have the same to say.
  return bundles == 0 || missing != 0 ? 1 : 0;
}
