#include <defold_hermes/generated_dmsdk_universal_jsi.hpp>
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include "../tests/fixtures/generated_dmsdk_universal_test_ids.h"

#include <cstdio>
#include <memory>
#include <string>

extern "C" void deherm_dmsdk_test_provider_install(void);

int main() {
  try {
    namespace jsi = facebook::jsi;
    auto runtime = facebook::hermes::makeHermesRuntime();
    jsi::Object modules(*runtime);
    deherm_dmsdk_test_provider_install();
    defold_hermes::installDmSdkUniversalModule(*runtime, modules);
    runtime->global().setProperty(*runtime, "__defoldModulesV1", std::move(modules));
    const std::string source =
        "const m=globalThis.__defoldModulesV1.DmSdkUniversal;"
        "if(m.catalogSha256!=='" DEHERM_TEST_DMSDK_CATALOG_SHA256 "')throw Error('catalog');"
        "const encoded=m.call(" + std::to_string(DEHERM_TEST_TO_NETWORK_ID) + ",[0x12345678n]);"
        "const decoded=m.call(" + std::to_string(DEHERM_TEST_TO_HOST_ID) + ",[encoded]);"
        "if(decoded!==0x12345678n)throw Error('round-trip');"
        "globalThis.__dehermUniversalResult=decoded;";
    runtime->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(source), "deherm://dmsdk-universal-e2e.js");
    auto result = runtime->global().getProperty(*runtime, "__dehermUniversalResult");
    if (!result.isBigInt() || !result.getBigInt(*runtime).isUint64(*runtime) ||
        result.getBigInt(*runtime).asUint64(*runtime) != UINT64_C(0x12345678)) return 2;
    std::puts("dmsdk-universal-jsi:ok");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "dmsdk-universal-jsi:error:%s\n", error.what());
    return 1;
  }
}
