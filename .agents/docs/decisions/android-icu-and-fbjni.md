---
type: Architecture Decision
title: Build ICU and fbjni statically per Android ABI instead of using Hermes' Java unicode backend
description: The Android lane selects the ICU unicode backend with HERMES_PLATFORM_UNICODE=3, builds a filtered static ICU and a trimmed static fbjni for each ABI inside the image, and merges both into libhermes.a.
tags: [decision, android, hermes, icu, fbjni, unicode, toolchain, native-artifacts]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-19T00:00:00-04:00 }
sources:
  - id: hermes-platform-unicode
    resource: https://github.com/facebook/hermes/blob/static_h/include/hermes/Platform/Unicode/PlatformUnicode.h
    title: Hermes platform unicode backend selection
    author: team:meta-hermes
  - id: hermes-api
    resource: https://github.com/facebook/hermes/blob/static_h/API/hermes/hermes.cpp
    title: Hermes JSI API and finalizer worker thread
    author: team:meta-hermes
  - id: fbjni
    resource: https://github.com/facebookincubator/fbjni
    title: fbjni, Apache-2.0
    author: team:meta
  - id: icu4c
    resource: https://github.com/unicode-org/icu/releases/tag/release-73-2
    title: ICU4C 73.2 source release
    author: team:unicode-org
  - id: icu-data-filtering
    resource: https://unicode-org.github.io/icu/userguide/icu_data/buildtool.html
    title: ICU data build tool and filter files
    author: team:unicode-org
---

# Decision

`toolchains/hermes/Dockerfile.android` builds its own **static ICU** and its own
**static fbjni**, once per Android ABI, inside the image, and merges both into
the single `libhermes.a` the extension publishes. Hermes is configured with
`-DHERMES_PLATFORM_UNICODE=3` (ICU), `HERMES_IS_ANDROID=OFF`,
`HERMES_IS_MOBILE_BUILD=ON`, `HERMES_USE_STATIC_ICU=ON` and
`HERMES_ENABLE_INTL=OFF`.

Nothing in the archive resolves against a shared library, and nothing in it is
left for the Defold engine to satisfy.

# Why ICU rather than the Java backend

`include/hermes/Platform/Unicode/PlatformUnicode.h:21` selects the unicode
backend from the **preprocessor**, not from a CMake option:

```c
#ifndef HERMES_PLATFORM_UNICODE
#if defined(__ANDROID__)
#define HERMES_PLATFORM_UNICODE HERMES_PLATFORM_UNICODE_JAVA
```

The NDK toolchain defines `__ANDROID__`, so the default on this lane is backend
1, the Java backend. `PlatformUnicodeJava.cpp` calls into
`com/facebook/hermes/unicode/AndroidUnicodeUtils` through fbjni, which means the
class has to be on the APK's classpath and fbjni has to have been handed the
process's `JavaVM`. React Native ships both in its Hermes AAR. A Defold APK
ships neither, and this project cannot add Java to the engine's APK from a
native extension.

The guard is `#ifndef`, so the macro is overridable. Defining
`HERMES_PLATFORM_UNICODE=3` selects `PlatformUnicodeICU.cpp`;
`PlatformUnicodeJava.cpp` then compiles to an empty translation unit and the
classpath and JavaVM requirements go away with it.

The alternatives were rejected:

* **`HERMES_UNICODE_LITE`** is not usable. `PlatformUnicodeLite.cpp` has empty
  `convertToCase` and `normalize` bodies and a `dateFormat` that returns the
  literal string `"dateFormat not implemented"`. `String.cpp` has an ASCII fast
  path, so this is not a visible no-op - it silently breaks `toUpperCase` and
  `toLowerCase` for every non-ASCII string.
* **The NDK's own ICU** cannot be linked. The sysroot carries
  `usr/include/unicode/*.h` at every API level but `libicu.so` only under API
  31, 32 and 33. The pinned engine builds Android at API 19 (armv7) and 21
  (64-bit), so there is nothing to link at Defold's floor - and even at 31 it
  would be a *shared* dependency, which the extension delivery model rules out.
* **`HERMES_IS_ANDROID=ON`** is the switch that looks like the answer and is
  not. It is what pulls in the Java unicode backend
  (`lib/Platform/Unicode/CMakeLists.txt:19`), the Java Intl backend
  (`lib/Platform/Intl/CMakeLists.txt:9`) and `find_package(fbjni REQUIRED
  CONFIG)` (`CMakeLists.txt:776`). It stays OFF.

Leaving it OFF has one consequence that must be paid explicitly:
`CMakeLists.txt:101` makes `HERMES_IS_ANDROID` the default for
`HERMES_IS_MOBILE_BUILD`, which is what adds `-DHERMES_IS_MOBILE_BUILD` at
`CMakeLists.txt:352`. With the flag off, Android would silently get desktop VM
tuning, so the lane passes `-DHERMES_IS_MOBILE_BUILD=ON` itself.

`HERMES_ENABLE_INTL` stays OFF. ICU is still required, because plain
`String.prototype` and `Date.prototype` methods - `localeCompare`, `normalize`,
`toUpperCase`/`toLowerCase`, `toLocaleDateString` - route through the platform
unicode backend whether or not `Intl` exists.

# Why fbjni is unavoidable

Selecting the ICU backend does not remove fbjni. `API/hermes/hermes.cpp:73` is

```c
#ifdef __ANDROID__
#include <fbjni/fbjni.h>
#endif
```

`#ifdef __ANDROID__`, **not** `#ifdef HERMES_IS_ANDROID`. So the include
compiles on this lane regardless of every CMake option, and
`makeDefaultFinalizerThreadRunner()` at `hermes.cpp:260` wraps the JSI finalizer
worker thread in a `facebook::jni::ThreadScope`, because finalizers may release
JNI references.

fbjni is not in the NDK - verified against the central directory of the pinned
`android-ndk-r25b-linux.zip`, which has no entry matching `fbjni`. It is
Apache-2.0, CMake-based, and builds against the NDK, so the lane builds it.

One of its translation units must **not** reach an archive Extender force-loads
into the engine, and the lane excludes it: `cxx/fbjni/OnLoad.cpp` defines
`JNI_OnLoad`. The Defold engine already defines it; a second definition is a
duplicate symbol, and winning that race would hijack the engine's own JNI
initialisation. Nothing reaches it from `ThreadScope`, which is the only fbjni
symbol `hermes.cpp` references.

`cxx/lyra/cxa_throw.cpp` was excluded in a first pass on the assumption that it
interposes `__cxa_throw`, and that was **wrong for v0.7.0** - checked rather
than assumed. It defines no ABI symbol: the hook is
`facebook::lyra::cxa_throw`, published behind a `HookInfo` struct for an
external installer to apply, and nothing here applies it. It also owns the
definition of `lyra::detail::getExceptionTraceHolder`, which
`lyra_exceptions.cpp` calls, so excluding it left the archive unresolved. It is
built. The image asserts the property that actually matters instead of the
file list: the archive must define neither `JNI_OnLoad` nor `__cxa_throw`.

# The Android finalizer-thread integration

`ThreadScope`'s constructor throws when fbjni has never been given a `JavaVM`
(`fbjni/cxx/fbjni/detail/Environment.cpp:266`):

```cpp
ThreadScope::ThreadScope() : thisAttached_(false) {
  if (g_vm == nullptr) {
    throw std::runtime_error(
        "fbjni is uninitialized; no thread can be attached.");
  }
```

`g_vm` is set only by `facebook::jni::initialize(vm, ...)`, which is called from
the `JNI_OnLoad` this lane deliberately excludes. React Native registers a VM
that way; a Defold APK does not.

**The finalizer runner is reachable, and this is a runtime fatal, not a
theoretical one.** The chain is fully determined by the pinned source:

1. `HermesRuntimeImpl` constructs `finalizerExecutor_` with
   `finalizerThreadRunner(runtimeConfig)` (`hermes.cpp:312`), which returns the
   platform default whenever the embedder configured none (`hermes.cpp:286`).
2. `SerialExecutor::add` lazily spawns the worker thread on the first enqueue
   (`lib/Support/SerialExecutor.cpp:51-83`), and `threadMain` calls the runner
   (`SerialExecutor.cpp:139`).
3. Three sites enqueue: `JsiProxy::~JsiProxy` (HostObject, `hermes.cpp:976`),
   `HFContext::finalize` (HostFunction, `hermes.cpp:1140`) and
   `NativeStateContext::finalize` (`hermes.cpp:1159`).
4. Hermes catches the `std::runtime_error` and converts it to
   `hermes_fatal("Exception on the JSI finalizer thread: ...")`, which aborts.

So the first garbage collection that finalizes any host function, host object or
native state aborts the process. `defold/defold_hermes/src/runtime.cpp:45`
constructs the runtime with `facebook::hermes::makeHermesRuntime()` and a
default `RuntimeConfig`, which is exactly the configuration that selects the
platform default. The bridge registers host functions, so this is on the normal
path, not an edge case.

Upstream documents the escape in `public/hermes/Public/RuntimeConfig.h:146-157`:
an **explicitly empty** runner suppresses the platform default and leaves the
thread unwrapped, and it has to be spelled
`withFinalizerThreadRunner(ThreadRunner{})`, because a bare `{}` is `nullopt`
and selects the platform default again.

`defold/defold_hermes/src/runtime.cpp` now applies that exact configuration on
`DM_PLATFORM_ANDROID`: its `makeRuntime()` builds a `RuntimeConfig` with
`withFinalizerThreadRunner(::hermes::vm::ThreadRunner{})`. Other platforms keep
Hermes' default configuration. A source-level regression test rejects both a
missing Android branch and the deceptively different bare `{}` spelling.

This closes the deterministic configuration defect, but it is **not packaged
Android runtime evidence**. The Android archive still has to build in CI, link
through Extender into an APK, and survive a host-function/host-object GC on a
device or emulator before that runtime lane is marked verified. Until then the
policy/report must describe Android as emitted but runtime-unverified rather
than silently treating the source fix as execution evidence. Nothing about the
archive carrying `ThreadScope` changes: `hermes.cpp` references it
unconditionally even when the configured empty runner makes it unreachable at
runtime.

# The ICU data filter

ICU's full data package is about 30 MB, and almost none of it is reachable from
a Hermes with `HERMES_ENABLE_INTL=OFF`. `lib/Platform/Unicode/PlatformUnicodeICU.cpp`
calls exactly four families of entry point:

| ES surface | ICU call | Data it needs |
| --- | --- | --- |
| `String.prototype.localeCompare` | `ucol_open`, `ucol_strcoll` | root collation (`coll_ucadata`) and the `coll` tree |
| `Date.prototype.toLocale*String` | `udat_open`, `udat_format` | the `locales` tree, the `zone` tree, `misc` (`zoneinfo64`) |
| `toUpperCase`/`toLowerCase` | `u_strToUpper`, `u_strToLower` | character case data |
| `String.prototype.normalize` | `unorm2_get{NFC,NFD,NFKC,NFKD}Instance` | normalization data |

The important property is that **character data is not filterable and therefore
cannot be lost**. `icu/source/data/BUILDRULES.py:294-300` records that
`pnames.icu`, `uprops.icu`, `ucase.icu`, `ubidi.icu` and `nfc.nrm` are compiled
into `libicuuc` itself rather than into the data package. Case mapping and
NFC/NFD keep working no matter what the filter drops.

The filter (`ICU_DATA_FILTER_FILE`, written into the image) is therefore:

* **kept**: `normalization` (NFKC/NFKD), `coll_ucadata` as `implicithan` rather
  than the larger `unihan` table, `misc`, `ulayout`, `uemoji`, `cnvalias`, the
  currency and zone supplementals, and the `en` + `root` subtree of every locale
  tree (`locales`, `coll`, `zone`) via a top-level `localeFilter`;
* **dropped**: `brkitr_rules`, `brkitr_dictionaries`, `brkitr_tree`,
  `confusables`, `conversion_mappings`, `stringprep`, `translit`, `unames`, and
  the `curr`, `lang`, `region`, `rbnf` and `unit` trees - text segmentation,
  charset conversion tables, character names and everything only `Intl` reaches.

Applying the filter is not the same as the filter taking effect, and the
difference is silent. `icu/source/data/Makefile.in:143` sets
`ICUDATA_SOURCE_ARCHIVE` from `$(wildcard $(srcdir)/in/icudt73l.dat)`; when that
is non-empty, `build-local` at `:261` drops `$(ICUDATA_ALL_OUTPUT_FILES)` - the
rules the filter produced - and `:272` builds the package list by unpacking the
prebuilt archive with `icupkg --list -x \*` instead. Measured: a configure that
printed *"Applying filters from /work/icu/filters.json"* produced a
**32,030,300-byte** `libicudata.a`, the whole package, with
`rules.mk: warning: ignoring old recipe for target out/tmp/icudata.lst` as the
only clue. The lane therefore deletes exactly that one prebuilt archive before
the cross configure, keeps everything else under `data/in` (those files are
*input* to the filtered rules), and asserts that no other `icudt73*.dat` is left
for the second wildcard at `:145` to find.

The same reasoning trims ICU's *code*: the lane compiles ICU with `-Os` and with
`UCONFIG_NO_LEGACY_CONVERSION`, `UCONFIG_NO_TRANSLITERATION`,
`UCONFIG_NO_REGULAR_EXPRESSIONS` and `U_CHARSET_IS_UTF8`. Those macros are part
of the ABI of the ICU headers, so the Dockerfile sets them once and applies the
same string to the ICU build and to the Hermes build that includes those
headers.

Two consequences are behavioural and are accepted rather than hidden:

* `localeCompare` on a locale with no tailoring in the package falls back to
  root collation.
* `Date.prototype.toLocaleDateString` on a locale outside `en`/`root` falls back
  to root formats.

`Intl` - the API where per-locale formatting is actually specified - is OFF on
every target, so neither changes a behaviour this project claims to provide.

# Build concurrency

The three ABI rows are independent and run concurrently in CI. Inside a row,
ICU and Hermes default to `BUILD_JOBS=2` instead of inheriting every visible CPU
from `nproc`: both are memory-heavy C++ graphs, and unbounded parallelism made
an NDK clang process segfault during the locally reproduced ICU compile while
the hosted runs ended only with Docker exit 1. Two workers keep peak memory
bounded without serialising the ABI matrix. The value is a Docker build
argument for controlled experiments, and the Dockerfile that declares its
default is part of the native-artifact fingerprint, so changing it cannot reuse
an old release identity.

# Size cost

<!-- SIZES -->

# Pinned upstreams

| Upstream | Identity | Verification |
| --- | --- | --- |
| ICU4C 73.2 source | `icu4c-73_2-src.tgz`, 26,519,906 bytes | vendor SHA-512 `76dd782d…27ce62` from the release's `SHASUM512.txt`, plus SHA-256 `818a8071…04ce1` recorded here, plus the byte length |
| ICU4C 73.2 CLDR data | `icu4c-73_2-data.zip`, 19,990,179 bytes | vendor SHA-512 `7f25816d…a0730` from the same `SHASUM512.txt`, plus SHA-256 `ca1ee076…42701`, plus the byte length |
| fbjni v0.7.0 | commit `474795fa9ff0dda60b838871171be935432bae16` | `git checkout` of the exact object name, asserted after fetch |

The data asset is not optional, and finding that out is worth recording because
the failure is silent. `icu4c-73_2-src.tgz` ships **no CLDR sources** - only the
prebuilt 32 MB `data/in/icudt73l.dat` - and `source/configure:9302` runs the
filtering data builder only `if test -f "$srcdir/data/locales/root.txt"`.
Without the data asset, configure prints *"Not rebuilding data/rules.mk,
assuming prebuilt data in data/in"*, `ICU_DATA_FILTER_FILE` is never consulted,
and the full package is linked in. Checked directly: running
`icutools.databuilder` against the source tarball alone fails on a missing
`data/locales/LOCALE_DEPS.json`, and against source + data it emits rules for
the filtered set. The lane therefore asserts `data/locales/root.txt` exists
after unpacking, so a future release that reorganises the assets fails loudly.

fbjni is pinned by git commit rather than by a tarball digest on purpose:
GitHub's auto-generated source tarballs are not a vendor-published artifact and
carry no vendor checksum, whereas a git object name is a digest over the whole
tree and history. This is the identity discipline `upstream.lock` already uses
for Hermes and Defold. ICU does publish a signed checksum file, so it is pinned
the same way the NDK is - a vendor digest and an independently recorded stronger
one over the same bytes, plus the length.

Licences: ICU4C is under the Unicode licence (permissive, attribution); fbjni is
Apache-2.0. Both are redistributable inside a statically linked archive with
attribution.
