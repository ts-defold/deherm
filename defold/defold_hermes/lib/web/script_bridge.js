var LibraryDefoldHermesScriptBridge = {
  $DEFOLD_HERMES_SCRIPT_BRIDGE__deps: [
    'defoldHermesScriptCall',
    'defoldHermesScriptLastError',
    '$stackSave',
    '$stackAlloc',
    '$stackRestore',
    '$UTF8ToString',
    '$stringToUTF8',
    '$lengthBytesUTF8'
  ],
  $DEFOLD_HERMES_SCRIPT_BRIDGE: {
    depth: 0,
    normalizeString: function(value) {
      var result = null;
      for (var index = 0; index < value.length; ++index) {
        var code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          var next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) {
            if (result !== null) result += value[index] + value[index + 1];
            ++index;
            continue;
          }
          if (result === null) result = value.slice(0, index);
          result += '\ufffd';
          continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff) {
          if (result === null) result = value.slice(0, index);
          result += '\ufffd';
          continue;
        }
        if (result !== null) result += value[index];
      }
      return result === null ? value : result;
    },
    call: function(stableId, args) {
      if (!Number.isInteger(stableId) || stableId < 0 || stableId > 0xffffffff) {
        throw new TypeError('Defold script stable ID must be a u32');
      }
      if (!Array.isArray(args) || args.length > 6) {
        throw new TypeError('Defold script scalar lane expects an array with at most 6 arguments');
      }
      if (this.depth >= 16) {
        throw new RangeError('Defold script bridge reentrancy depth is exhausted');
      }
      this.depth += 1;
      var checkpoint;
      try {
        checkpoint = stackSave();
        var tags = stackAlloc(6);
        var handleKinds = stackAlloc(6);
        var numbers = stackAlloc(6 * 8);
        var payloads = stackAlloc(6 * 8);
        var offsets = stackAlloc(6 * 4);
        var lengths = stackAlloc(6 * 4);
        var strings = stackAlloc(64 * 1024);
        var stringCursor = 0;
        for (var index = 0; index < args.length; ++index) {
          var value = args[index];
          var tag = 0;
          var number = 0;
          var handleKind = 0;
          var payload = BigInt(0);
          var offset = 0;
          var length = 0;
          if (value === undefined) tag = 0;
          else if (value === null) tag = 1;
          else if (typeof value === 'boolean') { tag = 2; number = value ? 1 : 0; }
          else if (typeof value === 'number') { tag = 3; number = value; }
          else if (typeof value === 'bigint') {
            if (value < BigInt(0) || value > BigInt('0xffffffffffffffff')) throw new RangeError('Defold hash must be an unsigned 64-bit bigint');
            tag = 5;
            handleKind = 1;
            payload = value;
          }
          else if (typeof value === 'string') {
            value = this.normalizeString(value);
            tag = 4;
            length = lengthBytesUTF8(value);
            if (stringCursor + length + 1 > 64 * 1024) throw new RangeError('Defold script string scratch is exhausted');
            offset = stringCursor;
            stringToUTF8(value, strings + stringCursor, length + 1);
            stringCursor += length;
          } else {
            throw new TypeError('Defold script scalar lane does not yet support tables, callbacks, or Defold values');
          }
          HEAPU8[tags + index] = tag;
          HEAPU8[handleKinds + index] = handleKind;
          HEAPF64[(numbers >> 3) + index] = number;
          HEAPU32[(payloads >> 2) + index * 2] = Number(payload & 0xffffffffn);
          HEAPU32[(payloads >> 2) + index * 2 + 1] = Number(payload >> BigInt(32));
          HEAPU32[(offsets >> 2) + index] = offset;
          HEAPU32[(lengths >> 2) + index] = length;
        }
        var outTag = stackAlloc(1);
        var outHandleKind = stackAlloc(1);
        var outNumber = stackAlloc(8);
        var outPayload = stackAlloc(8);
        var outString = stackAlloc(64 * 1024);
        var outLength = stackAlloc(4);
        if (!_defoldHermesScriptCall(
            stableId, args.length, tags, handleKinds, numbers, payloads, offsets, lengths, strings,
            stringCursor, outTag, outHandleKind, outNumber, outPayload, outString, 64 * 1024, outLength)) {
          throw new Error(UTF8ToString(_defoldHermesScriptLastError()));
        }
        var resultTag = HEAPU8[outTag];
        if (resultTag === 0) return undefined;
        if (resultTag === 1) return null;
        if (resultTag === 2) return HEAPF64[outNumber >> 3] !== 0;
        if (resultTag === 3) return HEAPF64[outNumber >> 3];
        if (resultTag === 4) return UTF8ToString(outString, HEAPU32[outLength >> 2]);
        if (resultTag === 5 && HEAPU8[outHandleKind] === 1) {
          return BigInt(HEAPU32[outPayload >> 2]) |
              (BigInt(HEAPU32[(outPayload >> 2) + 1]) << BigInt(32));
        }
        throw new Error('Defold script bridge returned a value tag not implemented by the browser adapter');
      } finally {
        if (checkpoint !== undefined) stackRestore(checkpoint);
        this.depth -= 1;
      }
    },
    install: function() {
      return { target: 'html5-browser-host', call: this.call.bind(this) };
    }
  }
};

autoAddDeps(LibraryDefoldHermesScriptBridge, '$DEFOLD_HERMES_SCRIPT_BRIDGE');
addToLibrary(LibraryDefoldHermesScriptBridge);
