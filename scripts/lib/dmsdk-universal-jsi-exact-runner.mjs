import { createHash } from "node:crypto";

function identifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value ?? "")) {
    throw new Error(`${label} is not a C identifier: ${value}`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tagConstant(tag) {
  const tags = {
    void: "DEHERM_DMSDK_UNIVERSAL_VOID",
    bool: "DEHERM_DMSDK_UNIVERSAL_BOOL",
    i64: "DEHERM_DMSDK_UNIVERSAL_I64",
    u64: "DEHERM_DMSDK_UNIVERSAL_U64",
    f64: "DEHERM_DMSDK_UNIVERSAL_F64",
    address: "DEHERM_DMSDK_UNIVERSAL_ADDRESS",
    memory: "DEHERM_DMSDK_UNIVERSAL_MEMORY",
    "native-value": "DEHERM_DMSDK_UNIVERSAL_NATIVE_VALUE",
  };
  return tags[tag] ?? null;
}

function expectedResultSetup(vector, index) {
  const expected = vector.result.fakeReturn;
  const name = `deherm_exact_jsi_expected_${index}`;
  const tag = tagConstant(expected.tag);
  if (!tag) throw new Error(`${vector.declarationId} has unsupported JSI result tag ${expected.tag}`);
  const lines = [`DehermDmSdkUniversalValue ${name}{};`, `${name}.tag=${tag};`];
  if (expected.tag === "f64") {
    lines.push(`{const double value=${Number(expected.value).toFixed(2)};memcpy(&${name}.payload,&value,sizeof(value));}`);
  } else if (expected.tag === "i64") {
    lines.push(`${name}.payload=static_cast<uint64_t>(INT64_C(${expected.value}));`);
  } else if (["u64", "bool"].includes(expected.tag)) {
    lines.push(`${name}.payload=UINT64_C(${expected.value});`);
  } else if (expected.tag === "address") {
    let expression = "nullptr";
    if (expected.fixture === "cstring") expression = `deherm_exact_vector_${index}_return_cstring`;
    if (expected.fixture === "value-object") expression = `&deherm_exact_vector_${index}_return_reference`;
    if (expected.fixture === "aligned-address-token") expression = `&deherm_exact_vector_${index}_return_address`;
    lines.push(`${name}.payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(${expression}));`);
  }
  return { name, source: lines.join("\n ") };
}

function renderVector(vector, index, names) {
  const unsupported = vector.wireArguments.find(({ tag }) => tag === "callback");
  if (unsupported) return null;
  for (const cell of vector.wireArguments) {
    if (!tagConstant(cell.tag)) {
      throw new Error(`${vector.declarationId} has unsupported JSI wire tag ${cell.tag}`);
    }
  }
  const expected = expectedResultSetup(vector, index);
  const argumentsName = `deherm_exact_jsi_arguments_${index}`;
  const resultName = `deherm_exact_jsi_result_${index}`;
  const id = `UINT32_C(${vector.numericId})`;
  const assignments = vector.wireArguments.map(({ slot }) =>
    `${argumentsName}.setValueAtIndex(runtime,UINT32_C(${slot}),` +
    `deherm_exact_jsi_input(runtime,deherm_exact_vector_${index}_arguments[${slot}]));`
  ).join("\n ");
  return `jsi::Array ${argumentsName}(runtime,UINT32_C(${vector.argumentCount}));
 ${assignments}
 jsi::Value deherm_exact_jsi_call_${index}[2]={jsi::Value(static_cast<double>(${id})),jsi::Value(runtime,${argumentsName})};
 jsi::Value ${resultName}=call.call(runtime,static_cast<const jsi::Value*>(deherm_exact_jsi_call_${index}),static_cast<size_t>(2));
 if(${names.calls}(${id})!=UINT32_C(1))return deherm_exact_jsi_failure("call-count",UINT32_C(${index}),${id});
 if(${names.failures}(${id})!=UINT32_C(0))return deherm_exact_jsi_failure("arguments",UINT32_C(${index}),${id});
 ${expected.source}
 if(!deherm_exact_jsi_result_matches(runtime,${resultName},${expected.name}))return deherm_exact_jsi_failure("result",UINT32_C(${index}),${id});`;
}

export function renderDmSdkUniversalJsiExactRunner(generated, options = {}) {
  const verification = generated?.verification;
  if (verification?.schemaVersion !== 1 || !Array.isArray(verification.vectors)) {
    throw new Error("JSI exact-call runner requires dmSDK verification vectors v1");
  }
  const names = {
    nativeDriver: identifier(verification.driver?.function, "native exact-call driver"),
    install: identifier(verification.provider?.install, "exact provider install"),
    reset: identifier(verification.observations?.reset, "observation reset"),
    calls: identifier(verification.observations?.calls, "observation calls"),
    failures: identifier(verification.observations?.failures, "observation failures"),
    runner: identifier(options.functionName ?? "deherm_dmsdk_run_jsi_exact_verification", "JSI runner"),
  };
  const unsupported = [];
  const rendered = verification.vectors.map((vector, index) => {
    const source = renderVector(vector, index, names);
    if (!source) {
      unsupported.push({
        declarationId: vector.declarationId,
        numericId: vector.numericId,
        reason: "production JSI encoder has no callback wire-value representation",
      });
    }
    return source;
  }).filter(Boolean);
  if (!rendered.length) throw new Error("JSI exact-call runner has no executable verification vectors");

  const source = `// Generated dynamic Hermes/JSI dmSDK exact-call runner. Do not edit.
#include <defold_hermes/generated_dmsdk_universal.h>
#include <defold_hermes/generated_dmsdk_universal_jsi.hpp>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace jsi=facebook::jsi;

namespace {
int deherm_exact_jsi_failure(const char* stage,uint32_t vector,uint32_t id){
 std::fprintf(stderr,"dmSDK JSI exact-call failure: stage=%s vector=%u id=%u\\n",stage,vector,id);return 1;
}
jsi::Value deherm_exact_jsi_input(jsi::Runtime& runtime,const DehermDmSdkUniversalValue& cell){
 switch(cell.tag){
  case DEHERM_DMSDK_UNIVERSAL_VOID:return jsi::Value::undefined();
  case DEHERM_DMSDK_UNIVERSAL_BOOL:return jsi::Value(cell.payload!=0);
  case DEHERM_DMSDK_UNIVERSAL_F64:{double value=0;std::memcpy(&value,&cell.payload,sizeof(value));return jsi::Value(value);}
  case DEHERM_DMSDK_UNIVERSAL_I64:{jsi::Object value(runtime);value.setProperty(runtime,"kind",jsi::String::createFromAscii(runtime,"i64"));value.setProperty(runtime,"value",jsi::BigInt::fromInt64(runtime,static_cast<int64_t>(cell.payload)));return jsi::Value(runtime,value);}
  case DEHERM_DMSDK_UNIVERSAL_U64:return jsi::Value(runtime,jsi::BigInt::fromUint64(runtime,cell.payload));
  case DEHERM_DMSDK_UNIVERSAL_ADDRESS:{jsi::Object value(runtime);value.setProperty(runtime,"kind",jsi::String::createFromAscii(runtime,"address"));value.setProperty(runtime,"value",jsi::BigInt::fromUint64(runtime,cell.payload));return jsi::Value(runtime,value);}
  case DEHERM_DMSDK_UNIVERSAL_MEMORY:{jsi::Object value(runtime);value.setProperty(runtime,"kind",jsi::String::createFromAscii(runtime,"memory"));value.setProperty(runtime,"address",jsi::BigInt::fromUint64(runtime,cell.payload));value.setProperty(runtime,"byteLength",static_cast<double>(cell.auxiliary));return jsi::Value(runtime,value);}
  case DEHERM_DMSDK_UNIVERSAL_NATIVE_VALUE:{jsi::Object value(runtime);value.setProperty(runtime,"kind",jsi::String::createFromAscii(runtime,"native-value"));value.setProperty(runtime,"address",jsi::BigInt::fromUint64(runtime,cell.payload));value.setProperty(runtime,"typeId",static_cast<double>(cell.type_id));return jsi::Value(runtime,value);}
  default:throw jsi::JSError(runtime,"unsupported exact-call JSI input tag");
 }
}
bool deherm_exact_jsi_result_matches(jsi::Runtime& runtime,const jsi::Value& value,const DehermDmSdkUniversalValue& expected){
 switch(expected.tag){
  case DEHERM_DMSDK_UNIVERSAL_VOID:return value.isUndefined();
  case DEHERM_DMSDK_UNIVERSAL_BOOL:return value.isBool()&&value.getBool()==(expected.payload!=0);
  case DEHERM_DMSDK_UNIVERSAL_F64:{double number=0;std::memcpy(&number,&expected.payload,sizeof(number));return value.isNumber()&&value.asNumber()==number;}
  case DEHERM_DMSDK_UNIVERSAL_I64:return value.isBigInt()&&value.getBigInt(runtime).isInt64(runtime)&&value.getBigInt(runtime).asInt64(runtime)==static_cast<int64_t>(expected.payload);
  case DEHERM_DMSDK_UNIVERSAL_U64:return value.isBigInt()&&value.getBigInt(runtime).isUint64(runtime)&&value.getBigInt(runtime).asUint64(runtime)==expected.payload;
  case DEHERM_DMSDK_UNIVERSAL_ADDRESS:{if(!value.isObject())return false;auto object=value.asObject(runtime);auto kind=object.getProperty(runtime,"kind");auto raw=object.getProperty(runtime,"value");return kind.isString()&&kind.getString(runtime).utf8(runtime)=="address"&&raw.isBigInt()&&raw.getBigInt(runtime).isUint64(runtime)&&raw.getBigInt(runtime).asUint64(runtime)==expected.payload;}
  default:return false;
 }
}
}

extern "C" int ${names.runner}(void){
 std::unique_ptr<jsi::Runtime> runtimeOwner;
 try{
  if(${names.nativeDriver}()!=0)return deherm_exact_jsi_failure("native-fixture-setup",UINT32_MAX,UINT32_MAX);
  ${names.install}();${names.reset}();
  runtimeOwner=facebook::hermes::makeHermesRuntime();
  auto& runtime=*runtimeOwner;
  jsi::Object modules(runtime);
  defold_hermes::installDmSdkUniversalModule(runtime,modules);
  auto module=modules.getProperty(runtime,"DmSdkUniversal").asObject(runtime);
  auto call=module.getProperty(runtime,"call").asObject(runtime).asFunction(runtime);
  ${rendered.join("\n  ")}
  return 0;
 }catch(const std::exception& error){std::fprintf(stderr,"dmSDK JSI exact-call exception: %s\\n",error.what());return 1;}
}
`;
  const report = {
    schemaVersion: 1,
    source: "deherm-dmsdk-dynamic-hermes-jsi-exact-call-verification",
    transport: "dynamic-hermes-jsi",
    evidenceBoundary: "Executes the production DmSdkUniversal JSI host function in a real Hermes runtime and checks stable-id selection, JavaScript-to-wire argument order and tags, exact native fake observations, and wire-to-JavaScript result signatures. It does not execute Defold implementation semantics or prove handle/callback ownership lifecycles.",
    catalogSha256: verification.catalogSha256,
    verificationManifestSha256: verification.manifestSha256,
    vectorCount: verification.vectors.length,
    executableVectorCount: rendered.length,
    unsupported,
    function: names.runner,
    sourceSha256: sha256(source),
  };
  return Object.freeze({ source, report: Object.freeze(report) });
}
