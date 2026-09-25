cmake_minimum_required(VERSION 3.24)

project(deherm_webtransport_cpp LANGUAGES C CXX)

include(FetchContent)
find_package(Git REQUIRED)

# Picoquic is source-built into the Defold extension.  The pins are intentional:
# WebTransport still tracks an evolving draft and must be interoperability-tested
# before either revision changes.
set(DEHERM_PICOQUIC_REV "8616f9d402cf886ade825e299e781a24fb4293db" CACHE STRING "Pinned picoquic revision")
set(DEHERM_PICOTLS_REV "bfa67875982afc4c24f21e146cef4747fa189c2f" CACHE STRING "Pinned picotls revision")
set(DEHERM_MBEDTLS_REV "068ff080b369adfac81509f9b57b2afabaf82dc5" CACHE STRING "Pinned Mbed TLS revision")

# The installable extension links its own pinned Mbed TLS. Defold's engine
# dmbedtls uses private headers/configuration and renamed dm_* symbols; it is
# deliberately not treated as a public dmSDK dependency.
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "" FORCE)
FetchContent_Declare(
  mbedtls
  GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
  GIT_TAG "${DEHERM_MBEDTLS_REV}"
  GIT_SHALLOW OFF
  GIT_SUBMODULES framework
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_MakeAvailable(mbedtls)

# Picoquic's FindMbedTLS module expects library variables. Supplying the
# already-declared static targets preserves one dependency graph and exact pin.
set(MBEDTLS_INCLUDE_DIR "${mbedtls_SOURCE_DIR}/include" CACHE PATH "" FORCE)
set(MBEDTLS_INCLUDE_DIRS "${mbedtls_SOURCE_DIR}/include" CACHE PATH "" FORCE)
set(MBEDTLS_LIBRARY "${mbedtls_BINARY_DIR}/library/${CMAKE_STATIC_LIBRARY_PREFIX}mbedtls${CMAKE_STATIC_LIBRARY_SUFFIX}" CACHE FILEPATH "" FORCE)
set(MBEDTLS_X509 "${mbedtls_BINARY_DIR}/library/${CMAKE_STATIC_LIBRARY_PREFIX}mbedx509${CMAKE_STATIC_LIBRARY_SUFFIX}" CACHE FILEPATH "" FORCE)
set(MBEDTLS_CRYPTO "${mbedtls_BINARY_DIR}/library/${CMAKE_STATIC_LIBRARY_PREFIX}mbedcrypto${CMAKE_STATIC_LIBRARY_SUFFIX}" CACHE FILEPATH "" FORCE)
set(MBEDTLS_LIBRARIES "${MBEDTLS_LIBRARY};${MBEDTLS_X509};${MBEDTLS_CRYPTO}" CACHE STRING "" FORCE)
set(WITH_OPENSSL OFF CACHE BOOL "" FORCE)
set(WITH_MBEDTLS ON CACHE BOOL "" FORCE)
set(WITH_DTRACE OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  picotls
  GIT_REPOSITORY https://github.com/h2o/picotls.git
  GIT_TAG "${DEHERM_PICOTLS_REV}"
  GIT_SHALLOW OFF
  PATCH_COMMAND
    "${CMAKE_COMMAND}"
      "-DDEHERM_GIT=${GIT_EXECUTABLE}"
      "-DDEHERM_PATCH=${CMAKE_CURRENT_SOURCE_DIR}/patches/picotls-dtrace-probe-output.patch"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/apply_patch.cmake"
)

# Picoquic carries its own Mbed TLS adapter, which is compatible with our
# pinned Mbed TLS 3.6 line. Picotls' optional standalone Mbed TLS signer uses a
# private mbedtls_pk_load_file helper and must not be built. Materialize the
# core/minicrypto targets first with that optional adapter disabled; picoquic
# then adds its adapter below when WITH_MBEDTLS is restored.
set(WITH_MBEDTLS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(picotls)
set(WITH_MBEDTLS ON CACHE BOOL "" FORCE)

set(PICOQUIC_FETCH_PTLS ON CACHE BOOL "" FORCE)
set(PICOQUIC_FETCH_PTLS_TAG "${DEHERM_PICOTLS_REV}" CACHE STRING "" FORCE)
if(FETCHCONTENT_SOURCE_DIR_PICOTLS)
  set(PTLS_INCLUDE_DIR "${FETCHCONTENT_SOURCE_DIR_PICOTLS}/include" CACHE PATH "" FORCE)
else()
  set(PTLS_INCLUDE_DIR "${CMAKE_BINARY_DIR}/_deps/picotls-src/include" CACHE PATH "" FORCE)
endif()
set(picoquic_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_DEMO OFF CACHE BOOL "" FORCE)
set(BUILD_PICO_SIM OFF CACHE BOOL "" FORCE)
set(BUILD_PQBENCH OFF CACHE BOOL "" FORCE)
# picohttp-core's public link interface references picoquic-log even when the
# optional readers are disabled, so keep the small static log target available.
set(BUILD_LOGLIB ON CACHE BOOL "" FORCE)
set(BUILD_LOGREADER OFF CACHE BOOL "" FORCE)
set(BUILD_HTTP ON CACHE BOOL "" FORCE)
set(DISABLE_DEBUG_PRINTF ON CACHE BOOL "" FORCE)

FetchContent_Declare(
  picoquic
  GIT_REPOSITORY https://github.com/private-octopus/picoquic.git
  GIT_TAG "${DEHERM_PICOQUIC_REV}"
  GIT_SHALLOW OFF
  PATCH_COMMAND
    "${CMAKE_COMMAND}"
      "-DDEHERM_GIT=${GIT_EXECUTABLE}"
      "-DDEHERM_PATCH=${CMAKE_CURRENT_SOURCE_DIR}/patches/picoquic-legacy-webtransport.patch"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/apply_patch.cmake"
)
FetchContent_MakeAvailable(picoquic)

add_library(deherm_webtransport_cpp STATIC
  src/client.cpp
  src/public_api.cpp
  src/url.cpp
)
set(DEHERM_WEBTRANSPORT_EXTENSION_INCLUDE
  "${CMAKE_CURRENT_SOURCE_DIR}/../../extensions/defold-webtransport/defold_webtransport/include")
target_include_directories(deherm_webtransport_cpp
  PUBLIC include "${DEHERM_WEBTRANSPORT_EXTENSION_INCLUDE}"
  PRIVATE src "${picotls_SOURCE_DIR}/include")
target_compile_features(deherm_webtransport_cpp PUBLIC cxx_std_17)
set_target_properties(deherm_webtransport_cpp PROPERTIES OUTPUT_NAME defold_webtransport_core)
if(WIN32)
  # Windows headers define min/max macros unless NOMINMAX is set. Those macros
  # corrupt std::min calls in the bounded close-reason path.
  target_compile_definitions(deherm_webtransport_cpp PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" OR ANDROID)
  # picohttp and picoquic carry a circular static dependency through the qlog
  # helper. GNU ld resolves each archive only when it is encountered, while
  # CMake de-duplicates an explicit trailing picoquic-log. RESCAN is the
  # allocation-free, deterministic equivalent of --start-group/--end-group.
  set(DEHERM_PICOQUIC_LINK "$<LINK_GROUP:RESCAN,picohttp-core,picoquic-core,picoquic-log>")
else()
  set(DEHERM_PICOQUIC_LINK picohttp-core picoquic-core picoquic-log)
endif()

target_link_libraries(deherm_webtransport_cpp
  PUBLIC
    ${DEHERM_PICOQUIC_LINK}
  PRIVATE
    mbedtls
    mbedcrypto
    mbedx509
)

if(APPLE)
  target_compile_options(deherm_webtransport_cpp PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(deherm_webtransport_cpp_test test/client_test.cpp)
target_link_libraries(deherm_webtransport_cpp_test PRIVATE deherm_webtransport_cpp)
target_include_directories(deherm_webtransport_cpp_test PRIVATE src)

add_executable(deherm_webtransport_cpp_probe test/interop_probe.cpp)
target_link_libraries(deherm_webtransport_cpp_probe PRIVATE deherm_webtransport_cpp)

add_executable(deherm_webtransport_public_api_probe test/public_api_probe.cpp)
target_link_libraries(deherm_webtransport_public_api_probe PRIVATE deherm_webtransport_cpp)

enable_testing()
add_test(NAME deherm_webtransport_cpp_test COMMAND deherm_webtransport_cpp_test)
