// Generated exact ABI twin for the dmHash state family. Do not edit.
#include <dmsdk/dlib/hash.h>
#include <cstring>
#include <stdint.h>
namespace {uint32_t calls[10]{};}
void dmHashClone32(HashState32* d,const HashState32* s,bool r){++calls[0];uint32_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));value+=r?7:1;std::memset(static_cast<void*>(d),0,sizeof(*d));std::memcpy(static_cast<void*>(d),&value,sizeof(value));}
void dmHashClone64(HashState64* d,const HashState64* s,bool r){++calls[1];uint64_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));value+=r?9:1;std::memset(static_cast<void*>(d),0,sizeof(*d));std::memcpy(static_cast<void*>(d),&value,sizeof(value));}
uint32_t dmHashFinal32(HashState32* s){++calls[2];uint32_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));return value;}
uint64_t dmHashFinal64(HashState64* s){++calls[3];uint64_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));return value;}
void dmHashInit32(HashState32* s,bool r){++calls[4];uint32_t value=r?32:3;std::memset(static_cast<void*>(s),0,sizeof(*s));std::memcpy(static_cast<void*>(s),&value,sizeof(value));}
void dmHashInit64(HashState64* s,bool r){++calls[5];uint64_t value=r?64:6;std::memset(static_cast<void*>(s),0,sizeof(*s));std::memcpy(static_cast<void*>(s),&value,sizeof(value));}
void dmHashRelease32(HashState32*){++calls[6];}
void dmHashRelease64(HashState64*){++calls[7];}
void dmHashUpdateBuffer32(HashState32* s,const void* p,uint32_t n){++calls[8];uint32_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));const auto* b=(const uint8_t*)p;for(uint32_t i=0;i<n;++i)value+=b[i];std::memcpy(static_cast<void*>(s),&value,sizeof(value));}
void dmHashUpdateBuffer64(HashState64* s,const void* p,uint32_t n){++calls[9];uint64_t value=0;std::memcpy(&value,static_cast<const void*>(s),sizeof(value));const auto* b=(const uint8_t*)p;for(uint32_t i=0;i<n;++i)value+=b[i];std::memcpy(static_cast<void*>(s),&value,sizeof(value));}
extern "C" uint32_t deherm_dmsdk_hash_state_exact_calls(uint16_t id){return id<10?calls[id]:0;}
