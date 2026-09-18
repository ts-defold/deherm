// Host-test implementation of Defold's logging sink. Shipping extensions get
// this symbol from the engine; standalone Debug and sanitizer executables do
// not, and mutex_posix.cpp retains its error branches in those configurations.

#include <cstdarg>
#include <cstdio>

#define DLIB_LOG_DOMAIN "DEHERM_TEST"
#include <dmsdk/dlib/log.h>

extern "C" void LogInternal(LogSeverity severity,
                            const char* domain,
                            const char* format,
                            ...) {
  std::fprintf(stderr,
               "[defold-test:%d:%s] ",
               static_cast<int>(severity),
               domain != nullptr ? domain : "DEFAULT");
  va_list arguments;
  va_start(arguments, format);
  std::vfprintf(stderr, format, arguments);
  va_end(arguments);
  std::fputc('\n', stderr);
}
