#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>

namespace {
using HashString64 = std::uint64_t (*)(const char*);
using HashBuffer64 = std::uint64_t (*)(const void*, std::uint32_t);

template <typename Function>
Function resolve(const char* name) {
  auto* symbol = dlsym(RTLD_DEFAULT, name);
  if (symbol == nullptr) {
    std::fprintf(stderr, "missing Defold symbol %s: %s\n", name, dlerror());
    std::_Exit(2);
  }
  return reinterpret_cast<Function>(symbol);
}

__attribute__((constructor)) void reportDefoldHashGroundTruth() {
  const auto hashString = resolve<HashString64>("dmHashString64");
  const auto hashBuffer = resolve<HashBuffer64>("dmHashBufferNoReverse64");
  constexpr char unicode[] = "r\xc3\xa4ksm\xc3\xb6rg\xc3\xa5s\xf0\x9f\x9a\x80";

  std::printf("my_hash=%016" PRIx64 "\n", hashString("my_hash"));
  std::printf("up=%016" PRIx64 "\n", hashString("up"));
  std::printf(
      "unicode=%016" PRIx64 "\n",
      hashBuffer(unicode, static_cast<std::uint32_t>(sizeof(unicode) - 1)));
  std::fflush(stdout);
  std::_Exit(0);
}
}  // namespace
