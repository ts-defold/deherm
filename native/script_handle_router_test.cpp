#include <defold_hermes/generated_script_handle_lowering.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace handle = defold_hermes::script_handle_lowering;
namespace scalar = defold_hermes::lua_bridge::scalar;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptResolvedUrl;
using defold_hermes::ScriptUrlArena;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace dmScript {
void PushHash(lua_State*, dmhash_t);
void PushVector3(lua_State*, const dmVMath::Vector3&);
void PushVector4(lua_State*, const dmVMath::Vector4&);
void PushQuat(lua_State*, const dmVMath::Quat&);
}

namespace {
std::atomic<bool> gTrack{false};
std::atomic<uint64_t> gAllocations{0};
std::atomic<int64_t> gFailAllocationCountdown{-1};
uint64_t gCalls = 0;
int gInstanceKey = 0;
void* gExpectedInstance = nullptr;
scalar::ScriptAdapter* gAdapter = nullptr;
bool gReenter = false;
ScriptCallFrame gNestedFrame{};
enum class InjectStage : uint8_t { kNone, kModuleMetamethod, kInstanceGet, kInstanceSet, kArgumentPush, kTarget, kResultRead, kResultReference };
InjectStage gInjectStage = InjectStage::kNone;

[[noreturn]] void die(const char* message) { std::fprintf(stderr, "script-handle-router:error:%s\n", message); std::exit(1); }
void expect(bool condition, const char* message) { if (!condition) die(message); }

void GetInstance(lua_State* state) { if(gInjectStage==InjectStage::kInstanceGet){gInjectStage=InjectStage::kNone;luaL_error(state,"forced instance get error");}lua_pushlightuserdata(state, &gInstanceKey); lua_rawget(state, LUA_REGISTRYINDEX); }
void SetInstance(lua_State* state) { if(gInjectStage==InjectStage::kInstanceSet){gInjectStage=InjectStage::kNone;luaL_error(state,"forced instance set error");}lua_pushlightuserdata(state, &gInstanceKey); lua_insert(state, -2); lua_rawset(state, LUA_REGISTRYINDEX); }
bool hasExpectedInstance(lua_State* state) { GetInstance(state); const bool result=lua_touserdata(state,-1)==gExpectedInstance;lua_pop(state,1);return result; }

void ensureModule(lua_State* state, const char* path) {
  const char* segment=path;const char* dot=std::strchr(segment,'.');
  const size_t firstLength=dot?static_cast<size_t>(dot-segment):std::strlen(segment);
  char first[64]{};expect(firstLength<sizeof(first),"module segment too long");std::memcpy(first,segment,firstLength);
  lua_getglobal(state,first);if(!lua_istable(state,-1)){lua_pop(state,1);lua_newtable(state);lua_pushvalue(state,-1);lua_setglobal(state,first);}
  while(dot){segment=dot+1;dot=std::strchr(segment,'.');const size_t length=dot?static_cast<size_t>(dot-segment):std::strlen(segment);
    char name[64]{};expect(length<sizeof(name),"nested module segment too long");std::memcpy(name,segment,length);
    lua_getfield(state,-1,name);if(!lua_istable(state,-1)){lua_pop(state,1);lua_newtable(state);lua_pushvalue(state,-1);lua_setfield(state,-3,name);}lua_remove(state,-2);}
}

int MockRoute(lua_State* state) {
  const auto& route=handle::routes()[static_cast<size_t>(lua_tointeger(state,lua_upvalueindex(1)))];
  expect(lua_gettop(state)==route.argumentCount,"Lua argument count drifted");
  if(route.context==handle::Context::kGameObjectInstance||route.context==handle::Context::kGuiScene||route.context==handle::Context::kRenderScriptAndGraphics)expect(hasExpectedInstance(state),"component script instance was not installed");
  if(gInjectStage==InjectStage::kTarget){gInjectStage=InjectStage::kNone;return luaL_error(state,"forced target error");}
  ++gCalls;
  if(gReenter){gReenter=false;expect(gAdapter->dispatch(&gNestedFrame),gAdapter->lastError());}
  if(!route.resultCount)return 0;
  const auto& codec=handle::resultCodecs()[route.resultOffset];
  if(codec.semanticKind!=handle::SemanticHandleKind::kNone){lua_newuserdata(state,16);return 1;}
  if(codec.mask&handle::kBoolean)lua_pushboolean(state,1);
  else if(codec.mask&(handle::kInteger|handle::kNumber))lua_pushnumber(state,7);
  else if(codec.mask&handle::kString)lua_pushliteral(state,"handle-result");
  else if(codec.mask&handle::kHash)dmScript::PushHash(state,UINT64_C(0x123456789abcdef0));
  else if(codec.mask&handle::kVector3)dmScript::PushVector3(state,dmVMath::Vector3(1,2,3));
  else if(codec.mask&handle::kVector4)dmScript::PushVector4(state,dmVMath::Vector4(1,2,3,4));
  else if(codec.mask&handle::kQuaternion)dmScript::PushQuat(state,dmVMath::Quat(0,0,0,1));
  else return luaL_error(state,"no mock result codec");
  return 1;
}

int ErrorIndex(lua_State* state){gInjectStage=InjectStage::kNone;return luaL_error(state,"forced module metamethod error");}

int InjectedReference(lua_State* state,int table){if(gInjectStage==InjectStage::kResultReference){gInjectStage=InjectStage::kNone;return luaL_error(state,"forced result reference error");}return luaL_ref(state,table);}
void InjectedUnreference(lua_State* state,int table,int reference){luaL_unref(state,table,reference);}

int makeWeakValueTable(lua_State* state){lua_newtable(state);lua_newtable(state);lua_pushliteral(state,"v");lua_setfield(state,-2,"__mode");lua_setmetatable(state,-2);return luaL_ref(state,LUA_REGISTRYINDEX);}
void weakTrack(lua_State* state,int table,int key,int valueIndex){const int absolute=valueIndex>0?valueIndex:lua_gettop(state)+valueIndex+1;lua_rawgeti(state,LUA_REGISTRYINDEX,table);lua_pushvalue(state,absolute);lua_rawseti(state,-2,key);lua_pop(state,1);}
bool weakCleared(lua_State* state,int table,int key){lua_rawgeti(state,LUA_REGISTRYINDEX,table);lua_rawgeti(state,-1,key);const bool cleared=lua_isnil(state,-1);lua_pop(state,2);return cleared;}

void installRoutes(lua_State* state,const handle::RuntimeProfile& profile) {
  for(size_t index=0;index<handle::kRouteCount;++index){const auto& route=handle::routes()[index];if(!route.nativeAdapterHarness||!handle::routeAvailableInProfile(route,profile))continue;
    ensureModule(state,route.modulePath);lua_pushinteger(state,route.index);lua_pushcclosure(state,MockRoute,1);lua_setfield(state,-2,route.member);lua_pop(state,1);}
}

void removeRoute(lua_State* state,const handle::Route& route){ensureModule(state,route.modulePath);lua_pushstring(state,route.member);lua_pushnil(state);lua_rawset(state,-3);lua_pop(state,1);}

handle::RuntimeProfileDetection detectProfile(lua_State* state,handle::RuntimeProfileDetectionStatus expected,const char* message){handle::RuntimeProfileDetection detection{};char error[256]{};const auto status=handle::detectRuntimeProfile(state,&detection,error,sizeof(error));expect(status==expected,message);return detection;}

ScriptValue argumentFor(const handle::ValueCodec& codec,
    const std::array<ScriptValue,handle::kHandleKindCount+1>& handles, ScriptUrlArena<>& urls) {
  if(codec.semanticKind!=handle::SemanticHandleKind::kNone)return handles[static_cast<size_t>(codec.semanticKind)];
  ScriptValue value{};static constexpr char text[]="handle-argument";
  if(codec.mask&handle::kBoolean){value.tag=ScriptValueTag::kBoolean;value.number=1;}
  else if(codec.mask&(handle::kInteger|handle::kNumber)){value.tag=ScriptValueTag::kNumber;value.number=3;}
  else if(codec.mask&handle::kString){value.tag=ScriptValueTag::kString;value.data=text;value.length=sizeof(text)-1;}
  else if(codec.mask&handle::kHash){value.tag=ScriptValueTag::kHandle;value.handleKind=ScriptHandleKind::kHash;value.payload=17;}
  else if(codec.mask&handle::kUrl){expect(urls.store({1,2,3,4},&value),"URL arena exhausted in fixture");}
  else if(codec.mask&handle::kVector3){value.tag=ScriptValueTag::kDefoldValue;value.defoldKind=ScriptDefoldValueKind::kVector3;value.defoldValue[0]=1;}
  else if(codec.mask&handle::kVector4){value.tag=ScriptValueTag::kDefoldValue;value.defoldKind=ScriptDefoldValueKind::kVector4;value.defoldValue[0]=1;}
  else if(codec.mask&handle::kQuaternion){value.tag=ScriptValueTag::kDefoldValue;value.defoldKind=ScriptDefoldValueKind::kQuaternion;value.defoldValue[3]=1;}
  else die("no fixture argument codec");return value;
}

bool callRoute(scalar::ScriptAdapter& adapter,const handle::Route& route,
    const std::array<ScriptValue,handle::kHandleKindCount+1>& handles,ScriptValue* result=nullptr,
    const scalar::ScriptAdapter::ComponentContext* forcedContext=nullptr) {
  std::array<ScriptValue,7> arguments{};ScriptUrlArena<> urls(77);for(uint8_t i=0;i<route.argumentCount;++i)arguments[i]=argumentFor(handle::argumentCodecs()[route.argumentOffset+i],handles,urls);
  char strings[128]{};ScriptValue local{};ScriptCallFrame frame{};frame.stableId=route.stableId;frame.arguments=arguments.data();frame.argumentCount=route.argumentCount;frame.results=result?result:&local;frame.resultCapacity=1;frame.stringScratch=strings;frame.stringScratchCapacity=sizeof(strings);frame.urlArena=&urls;
  scalar::ScriptAdapter::ComponentContext derived{};const scalar::ScriptAdapter::ComponentContext* selected=forcedContext;
  if(!selected&&route.context==handle::Context::kGameObjectInstance){derived=scalar::ScriptAdapter::ComponentContext::kGameObject;selected=&derived;}
  if(!selected&&route.context==handle::Context::kGuiScene){derived=scalar::ScriptAdapter::ComponentContext::kGui;selected=&derived;}
  if(!selected&&route.context==handle::Context::kRenderScriptAndGraphics){derived=scalar::ScriptAdapter::ComponentContext::kRender;selected=&derived;}
  if(selected)expect(adapter.pushComponentContext(*selected),adapter.lastError());
  const bool ok=adapter.dispatch(&frame);if(selected)adapter.popComponentContext();if(ok&&frame.resultCount&&frame.results[0].handleKind==ScriptHandleKind::kLuaSemanticHandle){auto api=adapter.api();api.releaseHandle(api.context,frame.results[0].handleKind,frame.results[0].length,frame.results[0].payload);}return ok;
}

void expectProtectedFailure(scalar::ScriptAdapter& adapter,const handle::Route& route,
    const std::array<ScriptValue,handle::kHandleKindCount+1>& handles,const char* message){std::array<ScriptValue,7> arguments{};ScriptUrlArena<> urls(881);for(uint8_t index=0;index<route.argumentCount;++index)arguments[index]=argumentFor(handle::argumentCodecs()[route.argumentOffset+index],handles,urls);ScriptValue result{};char strings[128]{};std::array<defold_hermes::ScriptTableEntry,4> tables{};ScriptCallFrame frame{};frame.stableId=route.stableId;frame.arguments=arguments.data();frame.argumentCount=route.argumentCount;frame.results=&result;frame.resultCapacity=1;frame.stringScratch=strings;frame.stringScratchCapacity=sizeof(strings);frame.tableScratch=tables.data();frame.tableScratchCapacity=tables.size();frame.urlArena=&urls;expect(!adapter.dispatch(&frame),message);expect(frame.resultCount==0&&frame.stringScratchUsed==0&&frame.tableScratchUsed==0,"protected failure did not rewind frame scratch");}

bool callWithSemanticOverride(scalar::ScriptAdapter& adapter,const handle::Route& route,
    const std::array<ScriptValue,handle::kHandleKindCount+1>& handles,const ScriptValue& replacement) {
  std::array<ScriptValue,7> arguments{};ScriptUrlArena<> urls(79);bool replaced=false;
  for(uint8_t i=0;i<route.argumentCount;++i){const auto& codec=handle::argumentCodecs()[route.argumentOffset+i];arguments[i]=argumentFor(codec,handles,urls);if(!replaced&&codec.semanticKind!=handle::SemanticHandleKind::kNone){arguments[i]=replacement;replaced=true;}}
  expect(replaced,"override route has no semantic input");ScriptValue result{};char strings[128]{};ScriptCallFrame frame{};frame.stableId=route.stableId;frame.arguments=arguments.data();frame.argumentCount=route.argumentCount;frame.results=&result;frame.resultCapacity=1;frame.stringScratch=strings;frame.stringScratchCapacity=sizeof(strings);frame.urlArena=&urls;return adapter.dispatch(&frame);
}

const handle::Route& routeById(const char* id){for(size_t index=0;index<handle::kRouteCount;++index)if(std::strcmp(handle::routes()[index].canonicalId,id)==0)return handle::routes()[index];die("failure-stage route is missing");}

void installRoute(lua_State* state,const handle::Route& route){ensureModule(state,route.modulePath);lua_pushinteger(state,route.index);lua_pushcclosure(state,MockRoute,1);lua_setfield(state,-2,route.member);lua_pop(state,1);}

void installMetamethodTrap(lua_State* state,const handle::Route& route){ensureModule(state,route.modulePath);lua_pushnil(state);lua_setfield(state,-2,route.member);lua_newtable(state);lua_pushcfunction(state,ErrorIndex);lua_setfield(state,-2,"__index");lua_setmetatable(state,-2);lua_pop(state,1);}

void recoverReentrant(scalar::ScriptAdapter& adapter,const handle::Route& route,const std::array<ScriptValue,handle::kHandleKindCount+1>& handles,lua_State* state){std::array<ScriptValue,7> arguments{};ScriptUrlArena<> urls(991);for(uint8_t index=0;index<route.argumentCount;++index)arguments[index]=argumentFor(handle::argumentCodecs()[route.argumentOffset+index],handles,urls);gNestedFrame={};gNestedFrame.stableId=route.stableId;gNestedFrame.arguments=arguments.data();gNestedFrame.argumentCount=route.argumentCount;gNestedFrame.urlArena=&urls;gReenter=true;expect(callRoute(adapter,route,handles),adapter.lastError());expect(!gReenter,"reentrant recovery did not execute");expect(lua_gettop(state)==0&&hasExpectedInstance(state),"failure recovery leaked Lua stack or instance");}
}

void* operator new(std::size_t size){if(gTrack.load())++gAllocations;const int64_t countdown=gFailAllocationCountdown.load();if(countdown>=0&&gFailAllocationCountdown.fetch_sub(1)==0){gFailAllocationCountdown=-1;throw std::bad_alloc();}if(void* p=std::malloc(size))return p;throw std::bad_alloc();}
void* operator new[](std::size_t size){if(gTrack.load())++gAllocations;const int64_t countdown=gFailAllocationCountdown.load();if(countdown>=0&&gFailAllocationCountdown.fetch_sub(1)==0){gFailAllocationCountdown=-1;throw std::bad_alloc();}if(void* p=std::malloc(size))return p;throw std::bad_alloc();}
void operator delete(void* p)noexcept{std::free(p);}void operator delete[](void* p)noexcept{std::free(p);}void operator delete(void* p,std::size_t)noexcept{std::free(p);}void operator delete[](void* p,std::size_t)noexcept{std::free(p);}

namespace dmScript {
void PushHash(lua_State* s,dmhash_t v){*static_cast<dmhash_t*>(lua_newuserdata(s,sizeof(v)))=v;}dmhash_t* ToHash(lua_State* s,int i){return lua_isuserdata(s,i)?static_cast<dmhash_t*>(lua_touserdata(s,i)):nullptr;}
void PushVector3(lua_State* s,const dmVMath::Vector3& v){if(gInjectStage==InjectStage::kArgumentPush){gInjectStage=InjectStage::kNone;luaL_error(s,"forced argument push error");}*static_cast<dmVMath::Vector3*>(lua_newuserdata(s,sizeof(v)))=v;}dmVMath::Vector3* ToVector3(lua_State* s,int i){if(gInjectStage==InjectStage::kResultRead){gInjectStage=InjectStage::kNone;luaL_error(s,"forced result read error");}return lua_isuserdata(s,i)?static_cast<dmVMath::Vector3*>(lua_touserdata(s,i)):nullptr;}
void PushVector4(lua_State* s,const dmVMath::Vector4& v){*static_cast<dmVMath::Vector4*>(lua_newuserdata(s,sizeof(v)))=v;}dmVMath::Vector4* ToVector4(lua_State* s,int i){return lua_isuserdata(s,i)?static_cast<dmVMath::Vector4*>(lua_touserdata(s,i)):nullptr;}
void PushQuat(lua_State* s,const dmVMath::Quat& v){*static_cast<dmVMath::Quat*>(lua_newuserdata(s,sizeof(v)))=v;}dmVMath::Quat* ToQuat(lua_State* s,int i){return lua_isuserdata(s,i)?static_cast<dmVMath::Quat*>(lua_touserdata(s,i)):nullptr;}
void PushURL(lua_State* s,const dmMessage::URL& v){*static_cast<dmMessage::URL*>(lua_newuserdata(s,sizeof(v)))=v;}
dmVMath::Matrix4* ToMatrix4(lua_State*,int){return nullptr;}dmMessage::URL* ToURL(lua_State*,int){return nullptr;}void PushMatrix4(lua_State*,const dmVMath::Matrix4&){}
}

void runProfile(const handle::RuntimeProfile& runtimeProfile,bool fullBehavior,std::array<bool,handle::kRouteCount>& unionCovered){lua_State* state=luaL_newstate();expect(state!=nullptr,"Lua state creation failed");installRoutes(state,runtimeProfile);const auto detected=detectProfile(state,handle::RuntimeProfileDetectionStatus::kMatched,"exact profile surface was not detected");expect(detected.profile==&runtimeProfile,"exact profile surface selected the wrong profile");expect(detected.observedPresent==runtimeProfile.adapterExecutableRouteCount,"detected profile route census drifted");int instance=0;gExpectedInstance=&instance;lua_pushlightuserdata(state,gExpectedInstance);SetInstance(state);gCalls=0;gReenter=false;gNestedFrame={};
  scalar::ScriptAdapter adapter;gAdapter=&adapter;expect(adapter.initialize(state,{GetInstance,SetInstance},handle::runtimeProfileHandshake(runtimeProfile)),adapter.lastError());lua_pushlightuserdata(state,gExpectedInstance);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);
  std::array<ScriptValue,handle::kHandleKindCount+1> handles{};for(uint16_t kind=1;kind<=handle::kHandleKindCount;++kind){const auto semantic=static_cast<handle::SemanticHandleKind>(kind);if(!handle::handleKindCapturableInProfile(semantic,runtimeProfile))continue;lua_newuserdata(state,16);expect(adapter.captureSemanticHandle(-1,semantic,&handles[kind]),adapter.lastError());lua_pop(state,1);}
  size_t executed=0;const handle::Route* hot=nullptr;const handle::Route* nested=nullptr;const handle::Route* semanticInput=nullptr;const handle::Route* producer=nullptr;const handle::Route* selfInvalidator=nullptr;const handle::Route* childInvalidator=nullptr;for(size_t i=0;i<handle::kRouteCount;++i){const auto& route=handle::routes()[i];if(!route.nativeAdapterHarness||!handle::routeAvailableInProfile(route,runtimeProfile))continue;expect(callRoute(adapter,route,handles),adapter.lastError());unionCovered[i]=true;++executed;if(!hot&&route.resultCount==0)hot=&route;if(!nested&&route.resultCount==0&&route.argumentCount==1)nested=&route;if(!semanticInput)for(uint8_t j=0;j<route.argumentCount;++j)if(handle::argumentCodecs()[route.argumentOffset+j].semanticKind!=handle::SemanticHandleKind::kNone){semanticInput=&route;break;}if(!producer&&route.resultCount&&handle::resultCodecs()[route.resultOffset].semanticKind!=handle::SemanticHandleKind::kNone)producer=&route;if(!selfInvalidator&&route.operationClass==handle::OperationClass::kSelfInvalidator)selfInvalidator=&route;if(!childInvalidator&&route.operationClass==handle::OperationClass::kChildInvalidator)childInvalidator=&route;}
  expect(executed==runtimeProfile.adapterExecutableRouteCount&&gCalls==runtimeProfile.adapterExecutableRouteCount,"profile adapter route census did not cross Lua");
  const handle::Route* unavailable=nullptr;for(size_t i=0;i<handle::kRouteCount;++i){const auto& route=handle::routes()[i];if(route.nativeAdapterHarness&&!handle::routeAvailableInProfile(route,runtimeProfile)){unavailable=&route;break;}}expect(unavailable,"profile-unavailable fixture missing");installMetamethodTrap(state,*unavailable);gInjectStage=InjectStage::kModuleMetamethod;expect(!callRoute(adapter,*unavailable,handles),"profile-unavailable route executed");expect(gInjectStage==InjectStage::kModuleMetamethod,"profile gate did not reject before symbol binding");gInjectStage=InjectStage::kNone;
  if(fullBehavior){expect(hot&&nested,"fixture routes missing");expect(semanticInput&&producer&&selfInvalidator&&childInvalidator,"operation-class fixtures are missing");
  const handle::Route* guiContextRoute=nullptr;const handle::Route* renderContextRoute=nullptr;for(size_t i=0;i<handle::kRouteCount;++i){const auto& route=handle::routes()[i];if(!route.nativeAdapterHarness||!handle::routeAvailableInProfile(route,runtimeProfile))continue;if(!guiContextRoute&&route.context==handle::Context::kGuiScene)guiContextRoute=&route;if(!renderContextRoute&&route.context==handle::Context::kRenderScriptAndGraphics)renderContextRoute=&route;}
  expect(guiContextRoute&&renderContextRoute,"GUI/render context fixtures are missing");const uint64_t contextCalls=gCalls;const auto gameObjectContext=scalar::ScriptAdapter::ComponentContext::kGameObject;expect(!callRoute(adapter,*guiContextRoute,handles,nullptr,&gameObjectContext),"GUI handle route accepted a game-object context");expect(std::strstr(adapter.lastError(),"GUI script instance")&&gCalls==contextCalls,"GUI handle context gate was not fail-closed before Lua");const auto guiContext=scalar::ScriptAdapter::ComponentContext::kGui;expect(!callRoute(adapter,*renderContextRoute,handles,nullptr,&guiContext),"render handle route accepted a GUI context");expect(std::strstr(adapter.lastError(),"render script instance")&&gCalls==contextCalls,"render handle context gate was not fail-closed before Lua");
  auto expectedKind=handle::SemanticHandleKind::kNone;for(uint8_t i=0;i<semanticInput->argumentCount;++i){const auto kind=handle::argumentCodecs()[semanticInput->argumentOffset+i].semanticKind;if(kind!=handle::SemanticHandleKind::kNone){expectedKind=kind;break;}}
  const uint16_t wrongKind=static_cast<uint16_t>(expectedKind)==handle::kHandleKindCount?1:static_cast<uint16_t>(expectedKind)+1;
  expect(!callWithSemanticOverride(adapter,*semanticInput,handles,handles[wrongKind]),"wrong semantic handle kind was accepted");
  lua_newuserdata(state,16);ScriptValue stale{};expect(adapter.captureSemanticHandle(-1,expectedKind,&stale),adapter.lastError());lua_pop(state,1);auto bridge=adapter.api();bridge.releaseHandle(bridge.context,stale.handleKind,stale.length,stale.payload);
  expect(!callWithSemanticOverride(adapter,*semanticInput,handles,stale),"released semantic handle was accepted");
  auto firstKind=[](const handle::Route& route){for(uint8_t i=0;i<route.argumentCount;++i){const auto kind=handle::argumentCodecs()[route.argumentOffset+i].semanticKind;if(kind!=handle::SemanticHandleKind::kNone)return kind;}return handle::SemanticHandleKind::kNone;};
  auto terminalFor=[&](handle::SemanticHandleKind kind)->const handle::Route*{for(size_t i=0;i<handle::kRouteCount;++i){const auto& route=handle::routes()[i];if(route.nativeAdapterHarness&&handle::routeAvailableInProfile(route,runtimeProfile)&&route.operationClass==handle::OperationClass::kTerminal&&firstKind(route)==kind)return &route;}return nullptr;};
  const handle::Route* selfTerminal=terminalFor(firstKind(*selfInvalidator));const handle::Route* childTerminal=terminalFor(firstKind(*childInvalidator));expect(selfTerminal&&childTerminal,"invalidation terminal fixture missing");
  expect(callRoute(adapter,*selfInvalidator,handles),"self invalidator failed");expect(callRoute(adapter,*selfTerminal,handles),"self invalidation incorrectly released host wrapper");
  expect(callRoute(adapter,*childInvalidator,handles),"child invalidator failed");expect(callRoute(adapter,*childTerminal,handles),"child invalidation incorrectly released parent wrapper");
  { ScriptCallFrame wrongArity{};wrongArity.stableId=semanticInput->stableId;expect(!adapter.dispatch(&wrongArity),"wrong handle arity was accepted"); }
  std::array<ScriptValue,7> nestedArgs{};ScriptUrlArena<> nestedUrls(88);for(uint8_t i=0;i<nested->argumentCount;++i)nestedArgs[i]=argumentFor(handle::argumentCodecs()[nested->argumentOffset+i],handles,nestedUrls);gNestedFrame.stableId=nested->stableId;gNestedFrame.arguments=nestedArgs.data();gNestedFrame.argumentCount=nested->argumentCount;gNestedFrame.urlArena=&nestedUrls;gReenter=true;expect(callRoute(adapter,*hot,handles),adapter.lastError());expect(!gReenter&&hasExpectedInstance(state),"reentrant call did not restore instance");
  expect(callRoute(adapter,*hot,handles),"hot warmup failed");const uint64_t before=gAllocations.load();gTrack=true;for(size_t i=0;i<1024;++i)expect(callRoute(adapter,*hot,handles),adapter.lastError());gTrack=false;expect(gAllocations.load()==before,"warmed handle router allocated through C++ new");
  const handle::Route* blocked=nullptr;for(size_t i=0;i<handle::kRouteCount;++i)if(!handle::routes()[i].nativeAdapterHarness){blocked=&handle::routes()[i];break;}expect(blocked&&!callRoute(adapter,*blocked,handles),"blocked harness route executed");
  size_t filled=0;for(;;){lua_newuserdata(state,16);ScriptValue extra{};const bool captured=adapter.captureSemanticHandle(-1,expectedKind,&extra);lua_pop(state,1);if(!captured)break;++filled;}expect(filled>0,"semantic registry exhaustion fixture did not fill storage");expect(!callRoute(adapter,*producer,handles),"exhausted semantic registry accepted a produced handle");
  }
  expect(lua_gettop(state)==0&&hasExpectedInstance(state),"Lua stack or instance leaked");adapter.shutdown();lua_close(state);std::printf("script-handle-router:profile:%s:routes:%zu:ok\n",runtimeProfile.id,executed);}

void runProfileDetectionNegatives(){const auto* profile=handle::findRuntimeProfile("default-legacy-bullet");expect(profile,"profile detection fixture missing");const handle::Route* present=nullptr;const handle::Route* absent=nullptr;for(size_t i=0;i<handle::kRouteCount;++i){const auto& route=handle::routes()[i];if(!route.nativeAdapterHarness)continue;if(handle::routeAvailableInProfile(route,*profile)&&!present)present=&route;if(!handle::routeAvailableInProfile(route,*profile)&&!absent)absent=&route;}expect(present&&absent,"profile detection mutation routes missing");
  {lua_State* state=luaL_newstate();installRoutes(state,*profile);removeRoute(state,*present);installRoute(state,*absent);const auto result=detectProfile(state,handle::RuntimeProfileDetectionStatus::kNoMatch,"same-count wrong vector matched by count");expect(result.observedPresent==profile->adapterExecutableRouteCount,"same-count fixture route census drifted");lua_close(state);}
  {lua_State* state=luaL_newstate();installRoutes(state,*profile);removeRoute(state,*present);detectProfile(state,handle::RuntimeProfileDetectionStatus::kNoMatch,"missing route matched a profile");lua_close(state);}
  {lua_State* state=luaL_newstate();installRoutes(state,*profile);installRoute(state,*absent);detectProfile(state,handle::RuntimeProfileDetectionStatus::kNoMatch,"extra route matched a profile");lua_close(state);}
  {lua_State* state=luaL_newstate();const auto* legacy=handle::findRuntimeProfile("legacy-no-bullet");const auto* v3=handle::findRuntimeProfile("v3-no-bullet");expect(legacy&&v3,"hybrid profiles missing");installRoutes(state,*legacy);installRoutes(state,*v3);detectProfile(state,handle::RuntimeProfileDetectionStatus::kNoMatch,"hybrid surface matched a profile");lua_close(state);}
  {lua_State* state=luaL_newstate();installRoutes(state,*profile);installMetamethodTrap(state,*absent);gInjectStage=InjectStage::kModuleMetamethod;const int top=lua_gettop(state);const auto result=detectProfile(state,handle::RuntimeProfileDetectionStatus::kMatched,"raw profile probe invoked a metamethod");expect(result.profile==profile&&gInjectStage==InjectStage::kModuleMetamethod,"raw profile probe consumed metamethod trap");expect(lua_gettop(state)==top,"profile probe leaked stack through metamethod fixture");gInjectStage=InjectStage::kNone;lua_close(state);}
  {lua_State* state=luaL_newstate();lua_pushinteger(state,77);const int top=lua_gettop(state);detectProfile(state,handle::RuntimeProfileDetectionStatus::kNoMatch,"empty surface matched a profile");expect(lua_gettop(state)==top&&lua_tointeger(state,-1)==77,"failed profile probe did not restore stack");installRoutes(state,*profile);const auto retried=detectProfile(state,handle::RuntimeProfileDetectionStatus::kMatched,"profile probe did not recover after failure");expect(retried.profile==profile&&lua_gettop(state)==top,"profile probe retry leaked stack");lua_pop(state,1);lua_close(state);}
  {lua_State* state=luaL_newstate();installRoutes(state,*profile);detectProfile(state,handle::RuntimeProfileDetectionStatus::kMatched,"profile allocation warmup failed");const uint64_t before=gAllocations.load();gTrack=true;for(size_t i=0;i<1024;++i)detectProfile(state,handle::RuntimeProfileDetectionStatus::kMatched,"warmed profile detection failed");gTrack=false;expect(gAllocations.load()==before,"warmed profile detection allocated through C++ new");lua_close(state);}
  std::puts("script-handle-router:profile-detection-negatives:6:ok");std::puts("script-handle-router:profile-detection-allocations:0");}

void runProtectedFailureStages(){const auto* profile=handle::findRuntimeProfile("default-legacy-bullet");expect(profile,"protected-stage profile missing");lua_State* state=luaL_newstate();expect(state,"protected-stage Lua state creation failed");installRoutes(state,*profile);int instance=0;gExpectedInstance=&instance;gInjectStage=InjectStage::kNone;lua_pushlightuserdata(state,gExpectedInstance);SetInstance(state);const auto exactHandshake=handle::runtimeProfileHandshake(*profile);auto staleHandshake=exactHandshake;++staleHandshake.routeCount;scalar::ScriptAdapter rejected;expect(!rejected.initialize(state,{GetInstance,SetInstance},staleHandshake),"stale runtime profile handshake was accepted");scalar::ScriptAdapter adapter;gAdapter=&adapter;const defold_hermes::lua_bridge::LuaRegistryApi registryApi{InjectedReference,InjectedUnreference};expect(adapter.initialize(state,{GetInstance,SetInstance},exactHandshake,registryApi),adapter.lastError());lua_pushlightuserdata(state,gExpectedInstance);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);std::array<ScriptValue,handle::kHandleKindCount+1> handles{};for(uint16_t kind=1;kind<=handle::kHandleKindCount;++kind){const auto semantic=static_cast<handle::SemanticHandleKind>(kind);if(!handle::handleKindCapturableInProfile(semantic,*profile))continue;lua_newuserdata(state,16);expect(adapter.captureSemanticHandle(-1,semantic,&handles[kind]),adapter.lastError());lua_pop(state,1);}
  const auto& meta=routeById("script:b2d.body.apply_force");const auto& scoped=routeById("script:bullet3d.get_world");const auto& hot=routeById("script:b2d.body.dump");const auto& vectorResult=routeById("script:b2d.body.get_force");
  installMetamethodTrap(state,meta);gInjectStage=InjectStage::kModuleMetamethod;expectProtectedFailure(adapter,meta,handles,"module metamethod error escaped protection");installRoute(state,meta);recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kInstanceGet;expectProtectedFailure(adapter,scoped,handles,"instance get error escaped protection");recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kInstanceSet;expectProtectedFailure(adapter,scoped,handles,"instance set error escaped protection");recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kArgumentPush;expectProtectedFailure(adapter,meta,handles,"argument push error escaped protection");recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kTarget;expectProtectedFailure(adapter,scoped,handles,"target error escaped protection");recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kResultRead;expectProtectedFailure(adapter,vectorResult,handles,"result read error escaped protection");recoverReentrant(adapter,hot,handles,state);
  gInjectStage=InjectStage::kResultReference;expectProtectedFailure(adapter,scoped,handles,"result luaL_ref error escaped protection");recoverReentrant(adapter,hot,handles,state);
  expect(gInjectStage==InjectStage::kNone,"failure injection was not consumed");adapter.shutdown();lua_close(state);std::puts("script-handle-router:protected-errors:7:ok");}

void runAdapterAllocationFailureRetry(){const auto* profile=handle::findRuntimeProfile("default-legacy-bullet");expect(profile,"allocation retry profile missing");lua_State* state=luaL_newstate();expect(state,"allocation retry Lua state creation failed");installRoutes(state,*profile);scalar::ScriptAdapter adapter;bool threw=false;gFailAllocationCountdown=0;try{adapter.initialize(state,{GetInstance,SetInstance},handle::runtimeProfileHandshake(*profile));}catch(const std::bad_alloc&){threw=true;}gFailAllocationCountdown=-1;expect(threw,"ScriptAdapter initialization remained noexcept on allocation failure");expect(adapter.initialize(state,{GetInstance,SetInstance},handle::runtimeProfileHandshake(*profile)),adapter.lastError());adapter.shutdown();expect(lua_gettop(state)==0,"allocation failure retry leaked Lua stack");lua_close(state);std::puts("script-handle-router:allocation-failure-retry:ok");}

void runAttachmentLifecycle(){const auto* profile=handle::findRuntimeProfile("default-legacy-bullet");expect(profile,"attachment lifecycle profile missing");lua_State* state=luaL_newstate();expect(state,"attachment lifecycle Lua state creation failed");installRoutes(state,*profile);scalar::ScriptAdapter adapter;gAdapter=&adapter;expect(adapter.initialize(state,{GetInstance,SetInstance},handle::runtimeProfileHandshake(*profile)),adapter.lastError());const handle::Route* route=nullptr;handle::SemanticHandleKind kind=handle::SemanticHandleKind::kNone;for(size_t i=0;i<handle::kRouteCount&&!route;++i){const auto& candidate=handle::routes()[i];if(!candidate.nativeAdapterHarness||!handle::routeAvailableInProfile(candidate,*profile))continue;for(uint8_t j=0;j<candidate.argumentCount;++j){const auto candidateKind=handle::argumentCodecs()[candidate.argumentOffset+j].semanticKind;if(candidateKind!=handle::SemanticHandleKind::kNone){route=&candidate;kind=candidateKind;break;}}}expect(route&&kind!=handle::SemanticHandleKind::kNone,"attachment lifecycle semantic route missing");const int weak=makeWeakValueTable(state);
  lua_newuserdata(state,16);weakTrack(state,weak,1,-1);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);
  lua_newuserdata(state,16);weakTrack(state,weak,2,-1);ScriptValue stale{};expect(adapter.captureSemanticHandle(-1,kind,&stale),adapter.lastError());lua_pop(state,1);
  lua_newuserdata(state,16);weakTrack(state,weak,3,-1);ScriptValue luaUserdata{};expect(adapter.captureLuaUserdata(-1,&luaUserdata),adapter.lastError());lua_pop(state,1);
  adapter.detachInstance();lua_gc(state,LUA_GCCOLLECT,0);expect(weakCleared(state,weak,1)&&weakCleared(state,weak,2)&&weakCleared(state,weak,3),"detach did not unref every attachment root");std::array<ScriptValue,handle::kHandleKindCount+1> handles{};expect(!callWithSemanticOverride(adapter,*route,handles,stale),"pre-detach semantic handle survived runtime generation reset");
  lua_newuserdata(state,16);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);lua_newuserdata(state,16);ScriptValue fresh{};expect(adapter.captureSemanticHandle(-1,kind,&fresh),adapter.lastError());lua_pop(state,1);expect(fresh.length!=stale.length,"reattachment reused the stale semantic runtime generation");expect(fresh.payload!=stale.payload,"reattachment reused the stale semantic slot generation");handles[static_cast<size_t>(kind)]=fresh;expect(callRoute(adapter,*route,handles),adapter.lastError());
  adapter.detachInstance();lua_newuserdata(state,16);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);adapter.detachInstance();const uint64_t before=gAllocations.load();gTrack=true;gFailAllocationCountdown=0;for(size_t iteration=0;iteration<1024;++iteration){lua_newuserdata(state,16);expect(adapter.captureInstance(-1),adapter.lastError());lua_pop(state,1);adapter.detachInstance();}gFailAllocationCountdown=-1;gTrack=false;expect(gAllocations.load()==before,"warmed attachment churn allocated through C++ new");luaL_unref(state,LUA_REGISTRYINDEX,weak);adapter.shutdown();expect(lua_gettop(state)==0,"attachment lifecycle leaked Lua stack");lua_close(state);std::puts("script-handle-router:attachment-lifecycle:roots-stale-reuse:ok");std::puts("script-handle-router:attachment-lifecycle-allocations:0");}

int main(){std::array<bool,handle::kRouteCount> unionCovered{};for(uint8_t index=0;index<handle::kRuntimeProfileCount;++index){const auto& profile=handle::runtimeProfiles()[index];runProfile(profile,std::strcmp(profile.id,"default-legacy-bullet")==0,unionCovered);}size_t unionCount=0;for(size_t index=0;index<handle::kRouteCount;++index)if(unionCovered[index])++unionCount;expect(unionCount==handle::kAdapterExecutableCount,"profile union did not cover every adapter route");runProfileDetectionNegatives();runProtectedFailureStages();runAdapterAllocationFailureRetry();runAttachmentLifecycle();std::printf("script-handle-router:routes:%zu:ok\n",unionCount);std::puts("script-handle-router:profiles:6:ok");std::puts("script-handle-router:reentrant-blocked:ok");std::puts("script-handle-router:allocations:0");}
