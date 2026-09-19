set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(CMAKE_C_COMPILER clang)
set(CMAKE_CXX_COMPILER clang++)
set(CMAKE_ASM_COMPILER clang)
set(CMAKE_C_COMPILER_TARGET x86_64-pc-win32-msvc)
set(CMAKE_CXX_COMPILER_TARGET x86_64-pc-win32-msvc)
set(CMAKE_ASM_COMPILER_TARGET x86_64-pc-win32-msvc)

# The Extender image carries the exact MSVC and Windows SDK headers Defold uses,
# but clang's GNU-style driver does not discover those roots merely because its
# target triple names MSVC.  A trivial CMake compiler probe still succeeds in
# that state while the first standard-library probe (`<atomic>`) silently falls
# back to the Linux C++ headers and fails.  Keep this list in the same order as
# Defold's authoritative win32 `systemIncludes` in extender/build.yml.
foreach(required_environment WINDOWS_MSVC_DIR WINDOWS_SDK_DIR WINDOWS_SDK_VERSION)
  if("$ENV{${required_environment}}" STREQUAL "")
    message(FATAL_ERROR "The Defold Extender image must define ${required_environment}")
  endif()
endforeach()

set(DEHERM_WINDOWS_SYSTEM_INCLUDES
  "$ENV{WINDOWS_MSVC_DIR}/include"
  "$ENV{WINDOWS_MSVC_DIR}/atlmfc/include"
  "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/ucrt"
  "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/winrt"
  "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/um"
  "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/shared"
)

set(DEHERM_WINDOWS_INCLUDE_FLAGS "")
foreach(include_root IN LISTS DEHERM_WINDOWS_SYSTEM_INCLUDES)
  if(NOT IS_DIRECTORY "${include_root}")
    message(FATAL_ERROR "The Defold Extender image is missing Windows include root ${include_root}")
  endif()
  string(APPEND DEHERM_WINDOWS_INCLUDE_FLAGS " -isystem ${include_root}")
endforeach()

set(DEHERM_WINDOWS_DEFINES
  "-DDM_PLATFORM_WINDOWS -D_CRT_SECURE_NO_WARNINGS -D_CRT_USE_BUILTIN_OFFSETOF"
  "-D_WINSOCK_DEPRECATED_NO_WARNINGS -D__STDC_LIMIT_MACROS -DWINVER=0x0600 -DWIN32 -DNOMINMAX"
)
string(JOIN " " DEHERM_WINDOWS_DEFINE_FLAGS ${DEHERM_WINDOWS_DEFINES})

set(CMAKE_C_FLAGS_INIT
  "-m64 ${DEHERM_WINDOWS_DEFINE_FLAGS}${DEHERM_WINDOWS_INCLUDE_FLAGS}")
set(CMAKE_CXX_FLAGS_INIT
  "-m64 -nostdinc++ ${DEHERM_WINDOWS_DEFINE_FLAGS}${DEHERM_WINDOWS_INCLUDE_FLAGS}")
# Boost.Context selects its PE/GAS implementation for this target. Without an
# explicit ASM target, CMake invokes host clang in ELF mode: the source is
# correct COFF assembly, but `.def` and `.seh_*` are then rejected as unknown
# directives. Keep the flag explicit as well as setting COMPILER_TARGET because
# CMake 3.22's ASM driver does not consistently project the latter.
set(CMAKE_ASM_FLAGS_INIT "-target x86_64-pc-win32-msvc -m64")
set(CMAKE_EXE_LINKER_FLAGS_INIT "-fuse-ld=lld")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
