// Defold's own toolchain pins, read from the revision that declares them.
//
// `build_tools/sdk.py` is the authoritative statement of which Xcode, SDK, NDK,
// clang, MSVC and Emscripten an engine revision is built against. This project
// must never restate one of those numbers as its own constant: a cross build
// against a different SDK, NDK API level or deployment minimum than the engine's
// is an ABI mismatch that Extender finds at link time, or worse does not find.
//
// So the symbols are read verbatim and stored under the engine's own names. A
// key here is `VERSION_IPHONEOS_MIN`, not `iphoneosVersionMin`, because renaming
// a pin into our vocabulary is the first step towards owning it.
//
// Fail closed: a symbol that has moved or whose right-hand side is a shape this
// reader does not understand raises, rather than being silently dropped from the
// policy that the native artifact matrix keys on.

// Every pin the layered-policy decision names, plus the two the engine derives
// them into. A revision that stops declaring one of these is a real event.
export const REQUIRED_SDK_SYMBOLS = Object.freeze([
  "VERSION_EDITOR_JDK",
  "VERSION_XCODE",
  "VERSION_XCODE_CLANG",
  "VERSION_MACOSX",
  "VERSION_IPHONEOS",
  "VERSION_IPHONESIMULATOR",
  "VERSION_IPHONEOS_MIN",
  "VERSION_MACOSX_MIN",
  "SWIFT_VERSION",
  "VERSION_LINUX_CLANG",
  "ANDROID_NDK_VERSION",
  "ANDROID_NDK_API_VERSION",
  "ANDROID_64_NDK_API_VERSION",
  "ANDROID_TARGET_API_LEVEL",
  "ANDROID_BUILD_TOOLS_VERSION",
  "ANDROID_PACKAGE",
  "VERSION_WINDOWS_SDK",
  "VERSION_WINDOWS_MSVC",
  "VISUAL_STUDIO_VERSION",
  "PACKAGES_WIN32_TOOLCHAIN",
  "PACKAGES_WIN32_SDK",
  "EMSCRIPTEN_VERSION_STR",
  "EMSCRIPTEN_SDK",
  "PACKAGES_EMSCRIPTEN_SDK",
  "PACKAGES_IOS_SDK",
  "PACKAGES_IOS_SIMULATOR_SDK",
  "PACKAGES_MACOS_SDK",
  "PACKAGES_XCODE_TOOLCHAIN"
]);

const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/;

function unquote(text) {
  const match = /^(['"])([\s\S]*)\1$/.exec(text);
  return match ? match[2] : null;
}

/**
 * Evaluate the small expression language `sdk.py` actually uses for these
 * symbols: a string literal, an integer, an f-string over previously bound
 * symbols, or a `%`-format over one. Anything else is refused by name.
 */
function evaluate(name, expression, bound) {
  const literal = unquote(expression);
  if (literal !== null) return literal;
  if (/^-?\d+$/.test(expression)) return expression;

  const fstring = /^f(['"])([\s\S]*)\1$/.exec(expression);
  if (fstring) {
    return fstring[2].replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, symbol) => {
      if (!(symbol in bound)) throw new Error(`${name} interpolates ${symbol}, which sdk.py has not bound yet`);
      return bound[symbol];
    });
  }

  const percent = /^(['"])([\s\S]*)\1\s*%\s*([A-Z][A-Z0-9_]*)$/.exec(expression);
  if (percent) {
    const symbol = percent[3];
    if (!(symbol in bound)) throw new Error(`${name} formats ${symbol}, which sdk.py has not bound yet`);
    if (!/%s|%d/.test(percent[2])) throw new Error(`${name} uses a %-format this reader does not understand`);
    return percent[2].replace(/%[sd]/, bound[symbol]);
  }

  throw new Error(`${name} has a right-hand side this reader does not understand: ${expression}`);
}

/**
 * Bind every top-level constant assignment in `sdk.py`, in file order.
 *
 * Only module-level assignments count: an indented one is inside a function and
 * is a local, not a pin.
 */
export function parseSdkPins(source) {
  const bound = {};
  const refusals = [];
  // Git checks out the authoritative Python source with CRLF on Windows. Parse
  // logical source text, not the host checkout's newline encoding: otherwise a
  // trailing `\r` prevents comment stripping and can cascade into false missing
  // pins when a later expression references the rejected declaration.
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s/.test(line) || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line.replace(/\s+#.*$/, ""));
    if (!match) continue;
    const [, name, expression] = match;
    try {
      bound[name] = evaluate(name, expression, bound);
    } catch (error) {
      refusals.push({ symbol: name, reason: error.message });
    }
  }
  return { bound, refusals };
}

/**
 * The toolchain subtree's content for one revision.
 *
 * `platformKeys` comes from `share/extender/build_input.yml`, the companion
 * authority for which platform keys exist at all: a pin is only meaningful for a
 * platform Extender will accept.
 */
export function buildToolchainPins({ sdkSource, buildInputPlatforms }) {
  const { bound, refusals } = parseSdkPins(sdkSource);
  const missing = REQUIRED_SDK_SYMBOLS.filter((symbol) => !(symbol in bound));
  if (missing.length) {
    const blocked = refusals.filter((refusal) => missing.includes(refusal.symbol));
    throw new Error(
      `upstream/defold/build_tools/sdk.py no longer declares: ${missing.join(", ")}` +
      (blocked.length ? `\n  refused: ${blocked.map((row) => `${row.symbol}: ${row.reason}`).join("\n  refused: ")}` : "")
    );
  }
  const pins = Object.fromEntries(REQUIRED_SDK_SYMBOLS.map((symbol) => [symbol, bound[symbol]]));
  return {
    source: "upstream/defold/build_tools/sdk.py",
    companion: "upstream/defold/share/extender/build_input.yml",
    authority: "Defold declares these; deherm never restates one as its own constant.",
    pins,
    platformKeys: [...buildInputPlatforms].sort()
  };
}
