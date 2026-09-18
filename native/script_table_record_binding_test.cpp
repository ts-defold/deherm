#include <defold_hermes/generated_script_table_record_bindings.hpp>

#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace records = defold_hermes::table_record;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptTableEntry;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace {
[[noreturn]] void fail(const char* message) { std::fprintf(stderr, "script-table-record:error:%s\n", message); std::exit(1); }
void expect(bool value, const char* message) { if (!value) fail(message); }
ScriptValue string(const char* value) { ScriptValue result{}; result.tag = ScriptValueTag::kString; result.data = value; result.length = static_cast<uint32_t>(std::strlen(value)); return result; }
ScriptValue integer(int value) { ScriptValue result{}; result.tag = ScriptValueTag::kNumber; result.number = value; return result; }
struct Backend { uint32_t calls = 0; bool badField = false; };
records::DispatchStatus invoke(void* raw, const records::Operation& operation, const records::Codec*, const records::Field* fields, ScriptCallFrame* frame, char*, size_t) noexcept {
  auto* backend = static_cast<Backend*>(raw); ++backend->calls;
  ScriptTableEntry* entries = frame->tableScratch + frame->tableScratchUsed;
  for (uint32_t index = 0; index < operation.fieldCount; ++index) { entries[index].key = string(fields[operation.fieldOffset + index].name); entries[index].value = index == 0 && fields[operation.fieldOffset + index].codec == records::Codec::kString ? string("1.2.3") : integer(static_cast<int>(index + 1)); }
  if (backend->badField) entries[operation.fieldCount - 1].key = string("unexpected");
  frame->results[0] = {}; frame->results[0].tag = ScriptValueTag::kTable; frame->results[0].data = entries; frame->results[0].length = operation.fieldCount; frame->tableScratchUsed += operation.fieldCount; frame->resultCount = 1;
  return records::DispatchStatus::kSuccess;
}
struct Storage { std::array<ScriptValue, 1> args{}; std::array<ScriptValue, 1> results{}; std::array<ScriptTableEntry, 6> table{}; std::array<char, 128> error{}; ScriptCallFrame frame{}; Storage() { frame.stableId = UINT32_C(0xea93e5f3); frame.arguments = args.data(); frame.results = results.data(); frame.resultCapacity = results.size(); frame.tableScratch = table.data(); frame.tableScratchCapacity = table.size(); } };
}  // namespace

int main() {
  const records::Operation* operation = records::find(UINT32_C(0xea93e5f3));
  const records::Operation* b2d = records::find(UINT32_C(0x3aac69fd));
  const records::Operation* bullet = records::find(UINT32_C(0xf808b822));
  expect(records::kCandidateCount == 3 && operation && b2d && bullet && std::strcmp(operation->canonicalId, "script:image.get_astc_header") == 0, "fixed record descriptor drifted");
  expect(operation->context == records::Context::kGlobal && b2d->context == records::Context::kGlobal && bullet->context == records::Context::kGlobal, "fixed record context drifted");
  Backend backend; const records::LuaApi api{&backend, invoke};
  Storage valid; valid.frame.argumentCount = 1; valid.args[0] = string("astc-bytes");
  expect(records::dispatch(&valid.frame, valid.error.data(), valid.error.size(), &api) == records::DispatchStatus::kSuccess, "valid ASTC record was rejected");
  expect(backend.calls == 1 && valid.frame.resultCount == 1, "valid record did not cross the ABI");
  Storage b2dVersion; b2dVersion.frame.stableId = b2d->stableId; b2dVersion.frame.argumentCount = 0;
  expect(records::dispatch(&b2dVersion.frame, b2dVersion.error.data(), b2dVersion.error.size(), &api) == records::DispatchStatus::kSuccess, "Box2D version record was rejected");
  Storage bulletVersion; bulletVersion.frame.stableId = bullet->stableId; bulletVersion.frame.argumentCount = 0;
  expect(records::dispatch(&bulletVersion.frame, bulletVersion.error.data(), bulletVersion.error.size(), &api) == records::DispatchStatus::kSuccess, "Bullet version record was rejected");
  Storage wrongArgument; wrongArgument.frame.argumentCount = 1; wrongArgument.args[0] = integer(1);
  expect(records::dispatch(&wrongArgument.frame, wrongArgument.error.data(), wrongArgument.error.size(), &api) == records::DispatchStatus::kError, "non-string ASTC buffer was accepted");
  expect(backend.calls == 3 && std::strstr(wrongArgument.error.data(), "scalar descriptor"), "bad argument did not fail before backend dispatch");
  backend.badField = true; Storage badRecord; badRecord.frame.argumentCount = 1; badRecord.args[0] = string("astc-bytes");
  expect(records::dispatch(&badRecord.frame, badRecord.error.data(), badRecord.error.size(), &api) == records::DispatchStatus::kError, "unknown fixed-record field was accepted");
  expect(badRecord.frame.resultCount == 0 && std::strstr(badRecord.error.data(), "fixed-field descriptor"), "bad record did not fail closed");
  Storage noBackend; noBackend.frame.argumentCount = 1; noBackend.args[0] = string("astc-bytes");
  expect(records::dispatch(&noBackend.frame, noBackend.error.data(), noBackend.error.size(), nullptr) == records::DispatchStatus::kError, "missing backend was accepted");
  Storage exhausted; exhausted.frame.argumentCount = 1; exhausted.args[0] = string("astc-bytes"); exhausted.frame.tableScratchCapacity = 5;
  expect(records::dispatch(&exhausted.frame, exhausted.error.data(), exhausted.error.size(), &api) == records::DispatchStatus::kError, "exhausted caller-owned record scratch was accepted");
  expect(std::strstr(exhausted.error.data(), "scratch is exhausted") != nullptr, "record scratch exhaustion was not diagnostic");
  std::puts("script-table-record:ok");
}
