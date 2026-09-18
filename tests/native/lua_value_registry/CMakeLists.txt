cmake_minimum_required(VERSION 3.20)
project(DehermLuaValueRegistryTest LANGUAGES C CXX)

get_filename_component(DEHERM_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(DEFOLD_LUA_ROOT "${DEHERM_ROOT}/upstream/defold/engine/lua/src")
set(DEFOLD_LUA_SOURCE_DIR "${DEFOLD_LUA_ROOT}/lua")
set(DEFOLD_LUA_SOURCES
  lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c
  lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c
  lundump.c lvm.c lzio.c lauxlib.c lbaselib.c ldblib.c liolib.c
  lmathlib.c loslib.c ltablib.c lstrlib.c loadlib.c linit.c
)
list(TRANSFORM DEFOLD_LUA_SOURCES PREPEND "${DEFOLD_LUA_SOURCE_DIR}/")

add_library(pinned-defold-lua STATIC ${DEFOLD_LUA_SOURCES})
target_compile_definitions(pinned-defold-lua PRIVATE LUA_ANSI DM_LUA_USE_LUA51)
target_include_directories(pinned-defold-lua PUBLIC
  "${DEFOLD_LUA_ROOT}"
  "${DEFOLD_LUA_SOURCE_DIR}"
)

add_executable(lua-value-registry-test
  lua_value_registry_test.cpp
  "${DEHERM_ROOT}/defold/defold_hermes/src/lua_value_registry.cpp"
)
target_compile_features(lua-value-registry-test PRIVATE cxx_std_17)
target_include_directories(lua-value-registry-test PRIVATE
  "${DEHERM_ROOT}/defold/defold_hermes/include"
)
target_link_libraries(lua-value-registry-test PRIVATE pinned-defold-lua)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(lua-value-registry-test PRIVATE
    -Wall -Wextra -Werror -pedantic
  )
endif()

option(DEHERM_SANITIZE "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(DEHERM_SANITIZE AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(pinned-defold-lua PRIVATE -fsanitize=address,undefined)
  target_link_options(pinned-defold-lua PRIVATE -fsanitize=address,undefined)
  target_compile_options(lua-value-registry-test PRIVATE -fsanitize=address,undefined)
  target_link_options(lua-value-registry-test PRIVATE -fsanitize=address,undefined)
endif()
