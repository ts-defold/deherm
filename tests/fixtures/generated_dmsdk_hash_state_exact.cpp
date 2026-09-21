// Generated exact ABI twin for the dmHash state family. Do not edit.
#include <dmsdk/dlib/hash.h>
#include <stdint.h>
namespace {uint32_t calls[10]{};}
void dmHashInit32(HashState32* s,bool r){++calls[4];s->m_Hash=r?32:3;s->m_Tail=0;s->m_Count=0;s->m_Size=0;s->m_ReverseHashEntryIndex=0;}
void dmHashClone32(HashState32* d,const HashState32* s,bool r){++calls[0];d->m_Hash=s->m_Hash+(r?7:1);d->m_Tail=s->m_Tail;d->m_Count=s->m_Count;d->m_Size=s->m_Size;d->m_ReverseHashEntryIndex=0;}
void dmHashUpdateBuffer32(HashState32* s,const void* p,uint32_t n){++calls[8];const auto* b=(const uint8_t*)p;for(uint32_t i=0;i<n;++i)s->m_Hash+=b[i];}
uint32_t dmHashFinal32(HashState32* s){++calls[2];return s->m_Hash;}
void dmHashRelease32(HashState32*){++calls[6];}
void dmHashInit64(HashState64* s,bool r){++calls[5];s->m_Hash=r?64:6;s->m_Tail=0;s->m_Count=0;s->m_Size=0;s->m_ReverseHashEntryIndex=0;}
void dmHashClone64(HashState64* d,const HashState64* s,bool r){++calls[1];d->m_Hash=s->m_Hash+(r?9:1);d->m_Tail=s->m_Tail;d->m_Count=s->m_Count;d->m_Size=s->m_Size;d->m_ReverseHashEntryIndex=0;}
void dmHashUpdateBuffer64(HashState64* s,const void* p,uint32_t n){++calls[9];const auto* b=(const uint8_t*)p;for(uint32_t i=0;i<n;++i)s->m_Hash+=b[i];}
uint64_t dmHashFinal64(HashState64* s){++calls[3];return s->m_Hash;}
void dmHashRelease64(HashState64*){++calls[7];}
extern "C" uint32_t deherm_dmsdk_hash_state_exact_calls(uint16_t id){return id<10?calls[id]:0;}
