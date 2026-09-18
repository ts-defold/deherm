#include <defold_hermes/generated_dmsdk_cstring_value.h>

#include <dmsdk/dlib/buffer.h>
#include <dmsdk/dlib/socket.h>
#include <dmsdk/dlib/sys.h>
#include <dmsdk/graphics/graphics.h>
#include <dmsdk/resource/resource.h>
#include <dmsdk/resource/resource.hpp>

#include <cassert>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <new>

#undef assert
#define assert(condition) do { if (!(condition)) std::abort(); } while (false)
static_assert(sizeof(DehermDmSdkCStringStatus)==sizeof(uint32_t),"C-string status must be fixed-width u32");

namespace {
std::atomic<bool> g_count_allocations(false);
std::atomic<uint64_t> g_allocations(0);
}

void* operator new(std::size_t size) {
  if(g_count_allocations.load(std::memory_order_relaxed)) g_allocations.fetch_add(1,std::memory_order_relaxed);
  if(void* value=std::malloc(size)) return value;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value,std::size_t) noexcept { std::free(value); }
void operator delete[](void* value,std::size_t) noexcept { std::free(value); }

namespace dmBuffer {
const char* GetResultString(Result result) { return result==RESULT_METADATA_MISSING?nullptr:"buffer-result"; }
const char* GetValueTypeString(ValueType) { return "buffer-type"; }
}
namespace dmGraphics {
const char* GetTextureFormatLiteral(TextureFormat) { return "texture-format"; }
const char* GetTextureTypeLiteral(TextureType) { return "texture-type"; }
}
extern "C" uint32_t dmHashString32(const char* value) { return static_cast<uint32_t>(std::strlen(value)); }
extern "C" uint64_t dmHashString64(const char* value) { return static_cast<uint64_t>(std::strlen(value)) << 32; }
namespace dmResource {
const char* GetExtFromPath(const char* path) { const char* dot=std::strrchr(path,'.');return dot?dot+1:nullptr; }
}
namespace dmSocket { const char* ResultToString(Result) { return "socket-result"; } }
int dmStrCaseCmp(const char* left,const char* right) { return std::strcmp(left,right); }
namespace dmSys {
bool Exists(const char* path) { return std::strcmp(path,"exists")==0; }
Result Rename(const char* destination,const char* source) { return destination&&source?RESULT_OK:RESULT_INVAL; }
Result Unlink(const char* path) { return path?RESULT_OK:RESULT_INVAL; }
}
namespace dmUtf8 { uint32_t StrLen(const char* value) { return static_cast<uint32_t>(std::strlen(value)); } }
const char* ResourceGetExtFromPath(const char* path) { return dmResource::GetExtFromPath(path); }

namespace {
uint16_t route(const char* needle) {
  const auto* descriptors=deherm_dmsdk_cstring_value_descriptors();
  for(uint16_t index=0;index<deherm_dmsdk_cstring_value_count();++index) if(std::strstr(descriptors[index].source_id,needle)) return index;
  assert(false);return UINT16_MAX;
}
}

int main() {
  uint8_t local[32]{};DehermDmSdkCStringScratch scratch{local,sizeof(local),0};
  DehermDmSdkCStringFrame outer{},inner{};const char* outer_value=nullptr;const char* inner_value=nullptr;
  assert(deherm_dmsdk_cstring_frame_begin(&scratch,&outer)==DEHERM_DMSDK_CSTRING_OK);
  const uint8_t outer_bytes[]={'o','u','t','e','r'};
  assert(deherm_dmsdk_cstring_frame_input(&outer,{outer_bytes,5},&outer_value)==DEHERM_DMSDK_CSTRING_OK);
  assert(scratch.used==6);
  assert(deherm_dmsdk_cstring_frame_begin(&scratch,&inner)==DEHERM_DMSDK_CSTRING_OK);
  const uint8_t inner_bytes[]={'i','n'};
  assert(deherm_dmsdk_cstring_frame_input(&inner,{inner_bytes,2},&inner_value)==DEHERM_DMSDK_CSTRING_OK);
  assert(std::strcmp(inner_value,"in")==0);deherm_dmsdk_cstring_frame_end(&inner);assert(scratch.used==6);
  assert(std::strcmp(outer_value,"outer")==0);deherm_dmsdk_cstring_frame_end(&outer);assert(scratch.used==0);

  const uint8_t embedded[]={'a',0,'b'};const char* rejected=nullptr;
  assert(deherm_dmsdk_cstring_frame_begin(&scratch,&outer)==DEHERM_DMSDK_CSTRING_OK);
  assert(deherm_dmsdk_cstring_frame_input(&outer,{embedded,3},&rejected)==DEHERM_DMSDK_CSTRING_EMBEDDED_NUL);
  assert(deherm_dmsdk_cstring_frame_input(&outer,{nullptr,UINT32_MAX},&rejected)==DEHERM_DMSDK_CSTRING_NULL_STORAGE);
  assert(deherm_dmsdk_cstring_frame_input(&outer,{outer_bytes,UINT32_MAX},&rejected)==DEHERM_DMSDK_CSTRING_LENGTH_OVERFLOW);
  scratch.used=scratch.capacity+1;
  assert(deherm_dmsdk_cstring_frame_input(&outer,{outer_bytes,1},&rejected)==DEHERM_DMSDK_CSTRING_NULL_STORAGE);
  scratch.used=outer.mark;
  deherm_dmsdk_cstring_frame_end(&outer);

  uint8_t output[64]{};uint32_t required=0;uint8_t present=0;
  assert(deherm_dmsdk_cstring_write_output("abcdef",output,3,&required,&present)==DEHERM_DMSDK_CSTRING_OUTPUT_TOO_SMALL);
  assert(required==6&&present==1&&output[0]==0);
  assert(deherm_dmsdk_cstring_write_output("abcdef",output,6,&required,&present)==DEHERM_DMSDK_CSTRING_OUTPUT_TOO_SMALL);
  assert(required==6&&present==1&&output[0]==0);
  assert(deherm_dmsdk_cstring_write_output("abcdef",output,7,&required,&present)==DEHERM_DMSDK_CSTRING_OK);
  assert(required==6&&present==1&&std::strcmp(reinterpret_cast<const char*>(output),"abcdef")==0);
  assert(deherm_dmsdk_cstring_write_output(nullptr,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_OK);
  assert(required==0&&present==0&&output[0]==0);

  const uint8_t first[]={'a','l','p','h','a','.','e','x','t'};const uint8_t second[]={'B','E','T','A'};
  DehermDmSdkCStringView strings[2]={{first,sizeof(first)},{second,sizeof(second)}};uint64_t scalars[2]={0,0};uint64_t scalar_result=0;
  for(uint16_t index=0;index<deherm_dmsdk_cstring_value_count();++index){
    const auto& descriptor=deherm_dmsdk_cstring_value_descriptors()[index];required=0;present=0;std::memset(output,0,sizeof(output));
    const auto status=deherm_dmsdk_cstring_value_dispatch(index,nullptr,strings,descriptor.string_count,scalars,descriptor.scalar_count,&scalar_result,output,sizeof(output),&required,&present);
    assert(status==DEHERM_DMSDK_CSTRING_OK);
    if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_STRING) assert((present==0)||(output[required]==0));
  }
  assert(deherm_dmsdk_cstring_value_dispatch(route("dmStrCaseCmp"),nullptr,strings,2,nullptr,0,&scalar_result,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_OK);
  assert(static_cast<int64_t>(scalar_result)>0);
  uint64_t invalid_enum[]={UINT64_C(0x100000000)};
  assert(deherm_dmsdk_cstring_value_dispatch(route("dmBuffer::GetResultString"),nullptr,nullptr,0,invalid_enum,1,&scalar_result,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_SCALAR_RANGE);
  uint64_t undeclared_enum[]={UINT64_C(1234)};
  assert(deherm_dmsdk_cstring_value_dispatch(route("dmBuffer::GetResultString"),nullptr,nullptr,0,undeclared_enum,1,&scalar_result,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_SCALAR_RANGE);
  const uint16_t nonnull_result_route=route("dmBuffer::GetResultString");
  const uint16_t nullable_result_route=route("dmResource::GetExtFromPath");
  assert(deherm_dmsdk_cstring_value_descriptors()[nonnull_result_route].nullable_result==0);
  assert(deherm_dmsdk_cstring_value_descriptors()[nullable_result_route].nullable_result==1);
  uint64_t unexpected_null_enum[]={static_cast<uint64_t>(dmBuffer::RESULT_METADATA_MISSING)};required=99;present=1;output[0]='x';
  assert(deherm_dmsdk_cstring_value_dispatch(nonnull_result_route,nullptr,nullptr,0,unexpected_null_enum,1,&scalar_result,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT);
  assert(required==0&&present==0&&output[0]==0);
  const uint8_t no_extension_bytes[]={'n','o','e','x','t'};const DehermDmSdkCStringView no_extension[]={{no_extension_bytes,sizeof(no_extension_bytes)}};
  required=99;present=1;output[0]='x';
  assert(deherm_dmsdk_cstring_value_dispatch(nullable_result_route,nullptr,no_extension,1,nullptr,0,&scalar_result,output,sizeof(output),&required,&present)==DEHERM_DMSDK_CSTRING_OK);
  assert(required==0&&present==0&&output[0]==0);
  uint8_t overlap_data[32]{};DehermDmSdkCStringScratch overlap_scratch{overlap_data,sizeof(overlap_data),0};
  assert(deherm_dmsdk_cstring_value_dispatch(route("dmResource::GetExtFromPath"),&overlap_scratch,strings,1,nullptr,0,&scalar_result,overlap_data,sizeof(overlap_data),&required,&present)==DEHERM_DMSDK_CSTRING_OK);
  assert(required==3&&present==1&&std::strcmp(reinterpret_cast<const char*>(overlap_data),"ext")==0&&overlap_scratch.used==0);
  const DehermDmSdkCStringView bad[]={{embedded,3}};
  assert(deherm_dmsdk_cstring_value_dispatch(route("dmHashString32"),nullptr,bad,1,nullptr,0,&scalar_result,nullptr,0,nullptr,nullptr)==DEHERM_DMSDK_CSTRING_EMBEDDED_NUL);
  const uint16_t hash_route=route("dmHashString32");
  const DehermDmSdkCStringView empty_string[]={{nullptr,0}};
  assert(deherm_dmsdk_cstring_value_dispatch(hash_route,nullptr,empty_string,1,nullptr,0,&scalar_result,nullptr,0,nullptr,nullptr)==DEHERM_DMSDK_CSTRING_OK);
  assert(scalar_result==0);
  assert(deherm_dmsdk_cstring_value_dispatch(hash_route,nullptr,strings,1,nullptr,0,&scalar_result,nullptr,0,nullptr,nullptr)==DEHERM_DMSDK_CSTRING_OK);
  g_allocations.store(0,std::memory_order_relaxed);g_count_allocations.store(true,std::memory_order_relaxed);
  for(uint32_t iteration=0;iteration<100000;++iteration) assert(deherm_dmsdk_cstring_value_dispatch(hash_route,nullptr,strings,1,nullptr,0,&scalar_result,nullptr,0,nullptr,nullptr)==DEHERM_DMSDK_CSTRING_OK);
  g_count_allocations.store(false,std::memory_order_relaxed);assert(g_allocations.load(std::memory_order_relaxed)==0);
  std::cout<<"dmsdk-cstring-value:ok\n";
}
