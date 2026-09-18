#include <defold_hermes/generated_dmsdk_xtea_span_runtime.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <new>
namespace{std::atomic<bool> c(false);std::atomic<unsigned long long>a(0);}
void* operator new(std::size_t s){if(c.load())a++;if(void*p=std::malloc(s))return p;throw std::bad_alloc();}void* operator new[](std::size_t s){return ::operator new(s);}void operator delete(void*p)noexcept{std::free(p);}void operator delete[](void*p)noexcept{std::free(p);}void operator delete(void*p,std::size_t)noexcept{std::free(p);}void operator delete[](void*p,std::size_t)noexcept{std::free(p);}
int main(){uint8_t data[]={ 'A','B','C','D','E','F','G','H','1','2','3','4','5','6','7','8','X','Y','Z' },orig[19];uint8_t key[]={'1','2','3','4','5','6','7','8','a','b','c','d','e','f','g','h'};std::memcpy(orig,data,19);if(deherm_dmsdk_xtea_span_dispatch(0,data,19,key,17)!=DEHERM_DMSDK_XTEA_SPAN_KEY_TOO_LONG)return 1;if(deherm_dmsdk_xtea_span_dispatch(1,data,19,key,16)!=DEHERM_DMSDK_XTEA_SPAN_OK)return 2;if(!std::memcmp(data,orig,19))return 3;if(deherm_dmsdk_xtea_span_dispatch(0,data,19,key,16)!=DEHERM_DMSDK_XTEA_SPAN_OK||std::memcmp(data,orig,19))return 4;c.store(true);for(int i=0;i<100000;i++){if(deherm_dmsdk_xtea_span_dispatch(1,data,19,key,16)!=DEHERM_DMSDK_XTEA_SPAN_OK)return 5;if(deherm_dmsdk_xtea_span_dispatch(0,data,19,key,16)!=DEHERM_DMSDK_XTEA_SPAN_OK)return 6;}c.store(false);return a.load()==0?0:7;}
