#include <defold_hermes/generated_native_module_jsi.hpp>
#include <defold_hermes/native_module_provider.h>
#include <defold_webtransport/deherm_provider.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace {
struct Recording { std::array<bool, 13> called{}; };
struct ProviderRegistration {
  bool active = false;
  ~ProviderRegistration() {
    if (active) deherm_native_module_unregister_v1("NativeWebTransport");
  }
};
bool bytes(const DehermNativeModuleArgumentV1& value, std::initializer_list<uint8_t> expected) {
  return value.bytes && value.length == expected.size() && std::memcmp(value.bytes, expected.begin(), expected.size()) == 0;
}
void u32le(uint8_t* output, uint32_t value) { for (unsigned shift = 0; shift < 32; shift += 8) output[shift / 8] = static_cast<uint8_t>(value >> shift); }
int32_t Invoke(void* opaque, uint32_t method, const DehermNativeModuleArgumentV1* args,
               size_t count, DehermNativeModuleResultV1* result) {
  auto& recording = *static_cast<Recording*>(opaque);
  if (!args || !result || method > 12) return -100;
  recording.called[method] = true;
  switch (method) {
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_OPEN:
      if (count != 4 || std::string(reinterpret_cast<const char*>(args[0].bytes), args[0].length) != "https://host/game" || args[1].length != 32 || args[2].u32 != 64 || args[3].u32 != 8) return -101;
      result->u32 = 73; return 0;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_STATE:
      if (count != 1 || args[0].u32 != 73) return -102; result->u32 = 2; return 0;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_MAX_DATAGRAM_BYTES:
      if (count != 1 || args[0].u32 != 73) return -103; result->u32 = 1200; return 0;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_OPEN_BIDIRECTIONAL_STREAM:
      return count == 2 && args[0].u32 == 73 && args[1].u32 == 11 ? 0 : -104;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_OPEN_UNIDIRECTIONAL_STREAM:
      return count == 2 && args[0].u32 == 73 && args[1].u32 == 12 ? 0 : -105;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_WRITE_STREAM:
      return count == 4 && args[0].u32 == 73 && args[1].u32 == 91 && bytes(args[2], {9,8,7,6}) && args[3].u32 == 1 ? 0 : -106;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_RESET_STREAM:
      return count == 3 && args[1].u32 == 91 && args[2].u32 == 41 ? 0 : -107;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_STOP_SENDING:
      return count == 3 && args[1].u32 == 91 && args[2].u32 == 42 ? 0 : -108;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_TRY_SEND_DATAGRAM:
      return count == 2 && bytes(args[1], {5,4,3}) ? 1 : -109;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_POLL:
      if (count != 2 || !args[1].mutable_bytes || args[1].length != 64) return -110;
      u32le(args[1].mutable_bytes, 3); u32le(args[1].mutable_bytes + 4, 1);
      u32le(args[1].mutable_bytes + 12, 11); u32le(args[1].mutable_bytes + 16, 91);
      u32le(args[1].mutable_bytes + 20, 3); args[1].mutable_bytes[32] = 0xaa;
      args[1].mutable_bytes[33] = 0xbb; args[1].mutable_bytes[34] = 0xcc; return 0;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_CLOSE:
      return count == 3 && args[1].u32 == 43 && std::string(reinterpret_cast<const char*>(args[2].bytes), args[2].length) == "done" ? 0 : -111;
    case DEHERM_NATIVE_WEB_TRANSPORT_METHOD_DESTROY:
      return count == 1 && args[0].u32 == 73 ? 0 : -112;
    default: return -113;
  }
}
}

int main() {
  try {
    namespace jsi = facebook::jsi;
    auto runtime = facebook::hermes::makeHermesRuntime();
    jsi::Object absent(*runtime); defold_hermes::installGeneratedNativeModuleProviders(*runtime, absent);
    if (absent.hasProperty(*runtime, "NativeWebTransport")) return 2;
    runtime->global().setProperty(*runtime, "__defoldModulesV1", std::move(absent));
    Recording recording; auto provider = deherm_native_web_transport_provider_v1(&recording, Invoke);
    auto invalidAbiProvider = provider; invalidAbiProvider.module_abi_version = 0;
    if (deherm_native_module_register_v1(&invalidAbiProvider) != DEHERM_NATIVE_MODULE_REGISTRY_INVALID_ARGUMENT) return 7;
    if (deherm_native_module_register_v1(&provider) != DEHERM_NATIVE_MODULE_REGISTRY_OK) return 3;
    ProviderRegistration registration{true};
    jsi::Object collisionModules(*runtime);
    collisionModules.setProperty(*runtime, "NativeWebTransport", jsi::Object(*runtime));
    bool collisionRejected = false;
    try { defold_hermes::installGeneratedNativeModuleProviders(*runtime, collisionModules); }
    catch (const jsi::JSError&) { collisionRejected = true; }
    if (!collisionRejected) return 6;
    runtime->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(R"JS(
      if(__defoldModulesV1.__resolve('NativeWebTransport',2)!==undefined)throw Error('wrong ABI resolved');
      const m=__defoldModulesV1.__resolve('NativeWebTransport',1);
      if(!m)throw Error('late provider not resolved'); __defoldModulesV1.NativeWebTransport=m;
      if(m.__dehermNativeModuleAbiVersionV1!==1)throw Error('module ABI metadata missing');
      const storage=new Uint8Array(256);
      const cert=storage.subarray(7,39); cert.fill(1); const h=m.open('https://host/game',cert,64,8);
      if(h!==73||m.state(h)!==2||m.maxDatagramBytes(h)!==1200)throw Error('scalar');
      if(m.openBidirectionalStream(h,11)!==0||m.openUnidirectionalStream(h,12)!==0)throw Error('open stream');
      storage.set([9,8,7,6],51); if(m.writeStream(h,91,storage.subarray(51,55),true)!==0)throw Error('write');
      if(m.resetStream(h,91,41)!==0||m.stopSending(h,91,42)!==0)throw Error('control');
      storage.set([5,4,3],67); if(m.trySendDatagram(h,storage.subarray(67,70))!==1)throw Error('datagram');
      const output=storage.subarray(91,155); if(m.poll(h,output)!==0)throw Error('poll');
      const view=new DataView(output.buffer,output.byteOffset,output.byteLength);
      if(view.getUint32(0,true)!==3||view.getUint32(4,true)!==1||view.getUint32(12,true)!==11||view.getUint32(16,true)!==91||view.getUint32(20,true)!==3||output[32]!==0xaa||output[34]!==0xcc)throw Error('event');
      if(m.close(h,43,'done')!==0||m.destroy(h)!==0)throw Error('teardown');
    )JS"), "deherm://generic-native-provider.js");
    for (uint32_t method = 1; method <= 12; ++method) if (!recording.called[method]) return 4;
    if (deherm_native_module_unregister_v1("NativeWebTransport") != 0) return 5;
    registration.active = false;
    std::puts("generic-native-provider-jsi:ok"); return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "generic-native-provider-jsi:error:%s\n", error.what()); return 1;
  }
}
