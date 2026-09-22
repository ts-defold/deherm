// Browser-host component attachment provider.
//
// Defold's Lua component proxies run inside the Wasm engine; the TypeScript
// component definitions run in the browser's own JavaScript engine. This
// library owns the browser half of the same contract `runtime.cpp` implements
// for dynamic Hermes: a fixed-capacity generational slot pool over
// `__defoldComponentsV1`, one `self` object per live attachment, and lifecycle
// dispatch with arguments decoded from the generated universal wire format.
//
// Nothing here is target-specific policy. Value decoding is delegated to the
// generated `DEFOLD_HERMES_SCRIPT_UNIVERSAL.decodeWireRoots`, so the browser
// observes exactly the value shapes the native runtime materializes.
var LibraryDefoldHermesComponents = {
  $DEFOLD_HERMES_COMPONENTS__deps: [
    '$DEFOLD_HERMES_SCRIPT_UNIVERSAL',
    '$UTF8ToString',
    '$stringToUTF8'
  ],
  $DEFOLD_HERMES_COMPONENTS: {
    // A zero revision means "no browser component runtime"; the Lua gate reads
    // it exactly the way it reads a missing Hermes runtime.
    revision: 0,
    capacity: 1024,
    slots: null,
    cursor: 0,
    live: 0,
    /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
    snapshotSequence: 0,
    snapshotByteCapacity: 512 * 1024,
    snapshotStringByteCapacity: 256,
    reflectApply: Reflect.apply,
    objectCreate: Object.create,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    defineProperty: Object.defineProperty,
    numberIsFinite: Number.isFinite,
    numberToString: Number.prototype.toString,
    bigintToString: BigInt.prototype.toString,
    bigintZero: 0n,
    bigintMaximum: 0xffffffffffffffffn,
    stringCharCodeAt: String.prototype.charCodeAt,
    sampleUnixMilliseconds: Date.now,

    appendArray: function(array, value) {
      this.defineProperty(array, array.length, {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    },
    /* DEHERM_DEBUG_SNAPSHOT_END */

    activate: function() {
      this.slots = new Array(this.capacity);
      for (var index = 0; index < this.capacity; ++index) {
        this.slots[index] = {
          live: false,
          generation: 1,
          definition: null,
          self: null,
          componentId: '',
          schema: '',
          contextKind: '',
          /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
          declaredProperties: null,
          trustedPropertyObjects: null,
          omittedProperties: 0
          /* DEHERM_DEBUG_SNAPSHOT_END */
        };
      }
      this.cursor = 0;
      this.live = 0;
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      this.snapshotSequence = 0;
      /* DEHERM_DEBUG_SNAPSHOT_END */
      this.revision = (this.revision + 1) >>> 0 || 1;
      return this.revision;
    },

    reset: function() {
      this.slots = null;
      this.cursor = 0;
      this.live = 0;
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      this.snapshotSequence = 0;
      /* DEHERM_DEBUG_SNAPSHOT_END */
      this.revision = 0;
    },

    registry: function() {
      var registry = globalThis.__defoldComponentsV1;
      if (!registry || typeof registry !== 'object') throw new Error('Component registry is not installed');
      return registry;
    },

    entry: function(componentId) {
      var found = this.registry()[componentId];
      if (!found || typeof found !== 'object') throw new Error('Component is not registered: ' + componentId);
      return found;
    },

    resolve: function(slot, generation) {
      if (!this.slots || slot >= this.capacity) throw new Error('Component handle is out of range');
      var entry = this.slots[slot];
      if (!entry.live || entry.generation !== generation) throw new Error('Component handle is stale');
      return entry;
    },

    attach: function(componentId, schemaFingerprint, contextKind) {
      if (!this.slots) throw new Error('Browser component runtime is not loaded');
      var slotIndex = this.capacity;
      for (var probe = 0; probe < this.capacity; ++probe) {
        var candidate = (this.cursor + probe) % this.capacity;
        if (!this.slots[candidate].live) { slotIndex = candidate; break; }
      }
      if (slotIndex === this.capacity) {
        throw new Error('Component instance pool is exhausted: all ' + this.capacity +
          ' slots are live. Component \'' + componentId + '\' cannot attach.');
      }
      var registered = this.entry(componentId);
      if (registered.schemaFingerprint !== schemaFingerprint) throw new Error('Component schema fingerprint is stale');
      if (registered.contextKind !== contextKind) throw new Error('Component context does not match its registration');
      if (!registered.definition || typeof registered.definition !== 'object') throw new Error('Component definition is not an object');
      var slot = this.slots[slotIndex];
      slot.definition = registered.definition;
      slot.self = {};
      slot.componentId = componentId;
      slot.schema = schemaFingerprint;
      slot.contextKind = contextKind;
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      slot.declaredProperties = [];
      slot.trustedPropertyObjects = [];
      slot.omittedProperties = 0;
      /* DEHERM_DEBUG_SNAPSHOT_END */
      slot.live = true;
      this.cursor = (slotIndex + 1) % this.capacity;
      ++this.live;
      return {slot: slotIndex, generation: slot.generation};
    },

    setProperty: function(slot, generation, name, value) {
      var entry = this.resolve(slot, generation);
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      // The attach path projects each declaration once. Remember whether an
      // overflowed name was already projected so a defensive repeated call
      // cannot inflate the omission counter without retaining a 33rd name.
      var previouslyOwn = this.getOwnPropertyDescriptor(entry.self, name) !== undefined;
      /* DEHERM_DEBUG_SNAPSHOT_END */
      entry.self[name] = value;
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      for (var index = 0; index < entry.declaredProperties.length; ++index) {
        if (entry.declaredProperties[index] === name) {
          entry.trustedPropertyObjects[index] = value !== null && typeof value === 'object' ? value : null;
          return;
        }
      }
      if (entry.declaredProperties.length < 32) {
        this.appendArray(entry.declaredProperties, name);
        this.appendArray(entry.trustedPropertyObjects,
          value !== null && typeof value === 'object' ? value : null);
      }
      else if (!previouslyOwn && entry.omittedProperties < 0xffffffff) ++entry.omittedProperties;
      /* DEHERM_DEBUG_SNAPSHOT_END */
    },

    /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
    snapshotString: function(value) {
      var bytes = 0;
      var normalized = '';
      for (var index = 0; index < value.length; ++index) {
        var code = this.reflectApply(this.stringCharCodeAt, value, [index]);
        if (code <= 0x7f) { ++bytes; normalized += value[index]; }
        else if (code <= 0x7ff) { bytes += 2; normalized += value[index]; }
        else if (code >= 0xd800 && code <= 0xdbff) {
          var next = index + 1 < value.length
            ? this.reflectApply(this.stringCharCodeAt, value, [index + 1])
            : 0;
          if (next >= 0xdc00 && next <= 0xdfff) {
            bytes += 4;
            normalized += value[index] + value[index + 1];
            ++index;
          } else {
            bytes += 3;
            normalized += '\ufffd';
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          bytes += 3;
          normalized += '\ufffd';
        } else {
          bytes += 3;
          normalized += value[index];
        }
      }
      return {value: normalized, byteLength: bytes};
    },

    jsonStringByteLength: function(value) {
      var bytes = 2;
      for (var index = 0; index < value.length; ++index) {
        var code = this.reflectApply(this.stringCharCodeAt, value, [index]);
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c ||
            code === 0x0a || code === 0x0d || code === 0x09) bytes += 2;
        else if (code < 0x20) bytes += 6;
        else if (code <= 0x7f) ++bytes;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
          var next = index + 1 < value.length
            ? this.reflectApply(this.stringCharCodeAt, value, [index + 1])
            : 0;
          if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; ++index; }
          else bytes += 6;
        } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
        else bytes += 3;
      }
      return bytes;
    },

    hex64: function(value) {
      if (typeof value !== 'bigint' ||
          value < this.bigintZero || value > this.bigintMaximum) return null;
      var hex = this.reflectApply(this.bigintToString, value, [16]);
      while (hex.length < 16) hex = '0' + hex;
      return hex;
    },

    ownData: function(object, name) {
      if (object === null || (typeof object !== 'object' && typeof object !== 'function')) {
        return {available: false, reason: 'structured value is not an object'};
      }
      var descriptor;
      try {
        descriptor = this.getOwnPropertyDescriptor(object, name);
      } catch (_failure) {
        return {available: false, reason: 'own property descriptor could not be read'};
      }
      if (!descriptor) return {available: false, reason: 'required own property is missing'};
      var valueDescriptor = this.getOwnPropertyDescriptor(descriptor, 'value');
      if (!valueDescriptor) return {available: false, reason: 'required own property is an accessor'};
      return {available: true, value: valueDescriptor.value};
    },

    encodeSnapshotValue: function(value) {
      if (value === null) return {kind: 'nil'};
      if (typeof value === 'boolean') return {kind: 'boolean', value: value};
      if (typeof value === 'number') {
        return this.numberIsFinite(value)
          ? {kind: 'number', value: value}
          : {kind: 'unavailable', reason: 'non-finite-number'};
      }
      if (typeof value === 'string') {
        var normalized = this.snapshotString(value);
        if (normalized.byteLength > this.snapshotStringByteCapacity) {
          return {kind: 'unavailable', reason: 'string-too-long'};
        }
        return {kind: 'string', value: normalized.value};
      }
      if (typeof value === 'bigint') {
        var hash = this.hex64(value);
        return hash === null
          ? {kind: 'unavailable', reason: 'bigint-out-of-range'}
          : {kind: 'hash', value: hash};
      }
      if (value === null || typeof value !== 'object') {
        return {kind: 'unavailable', reason: value === undefined ? 'undefined' : 'unsupported-type'};
      }

      var marker = this.ownData(value, '__dehermUrlV1');
      if (marker.available && marker.value === true) {
        var url = this.objectCreate(null);
        url.kind = 'url';
        var urlNames = ['socket', 'reserved', 'path', 'fragment'];
        for (var urlIndex = 0; urlIndex < urlNames.length; ++urlIndex) {
          var urlName = urlNames[urlIndex];
          var lane = this.ownData(value, urlName);
          if (!lane.available) return {kind: 'unavailable', reason: 'invalid-url'};
          var encodedLane = this.hex64(lane.value);
          if (encodedLane === null) return {kind: 'unavailable', reason: 'invalid-url'};
          url[urlName] = encodedLane;
        }
        return url;
      }

      var kind = this.ownData(value, '__dehermValueKind');
      if (kind.available &&
          (kind.value === 'vector3' || kind.value === 'vector4' || kind.value === 'quaternion')) {
        var laneNames = ['x', 'y', 'z', 'w'];
        var laneCount = kind.value === 'vector3' ? 3 : 4;
        var lanes = laneCount === 3 ? [0, 0, 0] : [0, 0, 0, 0];
        for (var laneIndex = 0; laneIndex < laneCount; ++laneIndex) {
          var component = this.ownData(value, laneNames[laneIndex]);
          if (!component.available) return {kind: 'unavailable', reason: 'invalid-vector'};
          if (typeof component.value !== 'number' || !this.numberIsFinite(component.value)) {
            return {kind: 'unavailable', reason: 'invalid-vector'};
          }
          lanes[laneIndex] = component.value;
        }
        return {kind: kind.value, value: lanes};
      }
      return {kind: 'unavailable', reason: 'unsupported-object'};
    },

    snapshotProperty: function(entry, index) {
      var name = entry.declaredProperties[index];
      var descriptor;
      try {
        descriptor = this.getOwnPropertyDescriptor(entry.self, name);
      } catch (_failure) {
        entry.trustedPropertyObjects[index] = null;
        return {name: name, value: {kind: 'unavailable', reason: 'inspection-failed'}};
      }
      if (!descriptor) {
        entry.trustedPropertyObjects[index] = null;
        return {name: name, value: {kind: 'unavailable', reason: 'missing-own-property'}};
      }
      var valueDescriptor = this.getOwnPropertyDescriptor(descriptor, 'value');
      if (!valueDescriptor) {
        entry.trustedPropertyObjects[index] = null;
        return {name: name, value: {kind: 'unavailable', reason: 'accessor-property'}};
      }
      var value = valueDescriptor.value;
      if (value === null || typeof value !== 'object' || typeof value === 'function') {
        entry.trustedPropertyObjects[index] = null;
      } else if (value !== entry.trustedPropertyObjects[index]) {
        entry.trustedPropertyObjects[index] = null;
        return {name: name, value: {kind: 'unavailable', reason: 'untrusted-structured-value'}};
      }
      return {name: name, value: this.encodeSnapshotValue(value)};
    },

    snapshotInstance: function(slotIndex, entry) {
      var properties = [];
      for (var index = 0; index < entry.declaredProperties.length; ++index) {
        this.appendArray(properties, this.snapshotProperty(entry, index));
      }
      return {
        instanceId: {slot: slotIndex >>> 0, generation: entry.generation >>> 0},
        componentId: entry.componentId,
        schemaFingerprint: entry.schema,
        contextKind: entry.contextKind,
        properties: properties
      };
    },

    snapshotValueByteLength: function(value) {
      if (value.kind === 'nil') return 14;
      if (value.kind === 'boolean') return 27 + (value.value ? 4 : 5);
      if (value.kind === 'number') {
        return 26 + this.reflectApply(this.numberToString, value.value, []).length;
      }
      if (value.kind === 'string') {
        return 26 + this.jsonStringByteLength(value.value);
      }
      if (value.kind === 'hash') return 24 + this.jsonStringByteLength(value.value);
      if (value.kind === 'url') {
        return 56 + this.jsonStringByteLength(value.socket) +
          this.jsonStringByteLength(value.reserved) +
          this.jsonStringByteLength(value.path) +
          this.jsonStringByteLength(value.fragment);
      }
      if (value.kind === 'vector3' || value.kind === 'vector4' || value.kind === 'quaternion') {
        var bytes = 20 + this.jsonStringByteLength(value.kind);
        for (var lane = 0; lane < value.value.length; ++lane) {
          if (lane) ++bytes;
          bytes += this.reflectApply(this.numberToString, value.value[lane], []).length;
        }
        return bytes;
      }
      return 32 + this.jsonStringByteLength(value.reason);
    },

    snapshotInstanceByteLength: function(instance) {
      var bytes = 105 +
        this.reflectApply(this.numberToString, instance.instanceId.slot, []).length +
        this.reflectApply(this.numberToString, instance.instanceId.generation, []).length +
        this.jsonStringByteLength(instance.componentId) +
        this.jsonStringByteLength(instance.schemaFingerprint) +
        this.jsonStringByteLength(instance.contextKind);
      for (var index = 0; index < instance.properties.length; ++index) {
        if (index) ++bytes;
        var property = instance.properties[index];
        bytes += 18 + this.jsonStringByteLength(property.name) +
          this.snapshotValueByteLength(property.value);
      }
      return bytes;
    },

    componentSnapshot: function(runtimeId) {
      this.snapshotSequence += 1;
      if (this.snapshotSequence > 9007199254740991) this.snapshotSequence = 1;
      var snapshot = {
        schemaVersion: 1,
        type: 'component-snapshot',
        runtimeId: runtimeId >>> 0,
        sequence: this.snapshotSequence,
        sampledAt: this.sampleUnixMilliseconds(),
        complete: true,
        omitted: {instances: 0, properties: 0},
        instances: []
      };
      var live = 0;
      var omittedProperties = 0;
      if (this.slots) {
        for (var countIndex = 0; countIndex < this.capacity; ++countIndex) {
          if (!this.slots[countIndex].live) continue;
          ++live;
          omittedProperties += this.slots[countIndex].omittedProperties;
          if (omittedProperties > 0xffffffff) omittedProperties = 0xffffffff;
        }
      }
      snapshot.omitted.properties = omittedProperties >>> 0;

      // Native reserves the same fixed 1024 bytes for its wrapper, envelope,
      // and omission counters. Account the instance JSON ourselves: even a
      // pristine JSON.stringify would honor an inherited application toJSON.
      var used = 1024;
      var included = 0;
      if (this.slots) {
        for (var slotIndex = 0; slotIndex < this.capacity; ++slotIndex) {
          var entry = this.slots[slotIndex];
          if (!entry.live) continue;
          var instance = this.snapshotInstance(slotIndex, entry);
          var encodedBytes = this.snapshotInstanceByteLength(instance);
          var separatorBytes = included ? 1 : 0;
          if (used + separatorBytes + encodedBytes > this.snapshotByteCapacity) break;
          this.appendArray(snapshot.instances, instance);
          used += separatorBytes + encodedBytes;
          ++included;
        }
      }
      snapshot.omitted.instances = (live - included) >>> 0;
      snapshot.complete = snapshot.omitted.instances === 0 && snapshot.omitted.properties === 0;
      return snapshot;
    },
    /* DEHERM_DEBUG_SNAPSHOT_END */

    dispatch: function(slot, generation, lifecycle, args) {
      var entry = this.resolve(slot, generation);
      var hook = entry.definition[lifecycle];
      if (hook === undefined || hook === null) return false;
      if (typeof hook !== 'function') throw new Error('Component hook is not a function: ' + lifecycle);
      var applied = [entry.self];
      for (var index = 0; index < args.length; ++index) applied.push(args[index]);
      var result = hook.apply(entry.definition, applied);
      if (lifecycle === 'onInput') {
        if (typeof result !== 'boolean') throw new Error('Component onInput must return an exact boolean');
        return result;
      }
      return false;
    },

    reload: function(slot, generation) {
      var entry = this.resolve(slot, generation);
      var definition = this.entry(entry.componentId).definition;
      if (!definition || typeof definition !== 'object') throw new Error('Reloaded component definition is invalid');
      entry.definition = definition;
      return this.dispatch(slot, generation, 'onReload', []);
    },

    // Rebind every live attachment to the definitions a newly activated bundle
    // registered, under the identities the engine still holds. This is the
    // browser half of what a Defold `.script` reload does natively: the
    // component instance, its `self` table and its stable id survive, the
    // lifecycle functions are replaced, `init` is not called again, and
    // `onReload` is. A slot whose registered schema fingerprint changed is not
    // rebound: a property-schema change is an editor build, not a bundle swap.
    rebindAll: function() {
      var outcome = {rebound: 0, live: this.live, failed: []};
      if (!this.slots) return outcome;
      for (var index = 0; index < this.capacity; ++index) {
        var entry = this.slots[index];
        if (!entry.live) continue;
        try {
          var registered = this.entry(entry.componentId);
          if (registered.schemaFingerprint !== entry.schema) {
            throw new Error('Component schema fingerprint changed; a property-schema change needs a project build');
          }
          this.reload(index, entry.generation);
          ++outcome.rebound;
        } catch (failure) {
          outcome.failed.push({
            componentId: entry.componentId,
            message: failure && failure.message ? failure.message : String(failure)
          });
        }
      }
      return outcome;
    },

    detach: function(slot, generation) {
      if (!this.slots || slot >= this.capacity) return;
      var entry = this.slots[slot];
      if (!entry.live || entry.generation !== generation) return;
      entry.live = false;
      entry.definition = null;
      entry.self = null;
      entry.componentId = '';
      entry.schema = '';
      entry.contextKind = '';
      /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
      entry.declaredProperties = null;
      entry.trustedPropertyObjects = null;
      entry.omittedProperties = 0;
      /* DEHERM_DEBUG_SNAPSHOT_END */
      entry.generation = (entry.generation + 1) >>> 0 || 1;
      if (this.live) --this.live;
    },

    report: function(error, errorCapacity, failure) {
      if (!errorCapacity) return;
      var message = failure && failure.message ? failure.message : String(failure);
      stringToUTF8(message, error, errorCapacity);
    }
  },

  defoldHermesWebComponentRevision__deps: ['$DEFOLD_HERMES_COMPONENTS'],
  defoldHermesWebComponentRevision: function() {
    return DEFOLD_HERMES_COMPONENTS.revision >>> 0;
  },

  defoldHermesWebComponentAttach__deps: ['$DEFOLD_HERMES_COMPONENTS', '$UTF8ToString'],
  defoldHermesWebComponentAttach: function(componentId, schema, contextKind, outSlot, outGeneration, error, errorCapacity) {
    if (errorCapacity) HEAPU8[error] = 0;
    try {
      var kinds = ['game-object', 'gui-scene', 'render-instance+graphics'];
      if (contextKind >= kinds.length) throw new Error('Component context kind is invalid');
      var handle = DEFOLD_HERMES_COMPONENTS.attach(
        UTF8ToString(componentId), UTF8ToString(schema), kinds[contextKind]);
      HEAPU32[outSlot >> 2] = handle.slot;
      HEAPU32[outGeneration >> 2] = handle.generation;
      return 1;
    } catch (failure) {
      DEFOLD_HERMES_COMPONENTS.report(error, errorCapacity, failure);
      return 0;
    }
  },

  defoldHermesWebComponentSetProperty__deps: [
    '$DEFOLD_HERMES_COMPONENTS', '$DEFOLD_HERMES_SCRIPT_UNIVERSAL', '$UTF8ToString'
  ],
  defoldHermesWebComponentSetProperty: function(
      slot, generation, name,
      values, valueCount, entries, entryCount, strings, stringBytes,
      floats, floatCount, urls, urlCount, roots, rootCount,
      error, errorCapacity) {
    if (errorCapacity) HEAPU8[error] = 0;
    try {
      var decoded = DEFOLD_HERMES_SCRIPT_UNIVERSAL.decodeWireRoots(
        values, valueCount, entries, entryCount, strings, stringBytes,
        floats, floatCount, urls, urlCount, roots, rootCount, true);
      if (decoded.length !== 1) throw new Error('Component property expects exactly one value');
      DEFOLD_HERMES_COMPONENTS.setProperty(slot, generation, UTF8ToString(name), decoded[0]);
      return 1;
    } catch (failure) {
      DEFOLD_HERMES_COMPONENTS.report(error, errorCapacity, failure);
      return 0;
    }
  },

  defoldHermesWebComponentDispatch__deps: [
    '$DEFOLD_HERMES_COMPONENTS', '$DEFOLD_HERMES_SCRIPT_UNIVERSAL', '$UTF8ToString'
  ],
  defoldHermesWebComponentDispatch: function(
      slot, generation, lifecycle,
      values, valueCount, entries, entryCount, strings, stringBytes,
      floats, floatCount, urls, urlCount, roots, rootCount,
      consumed, error, errorCapacity) {
    if (errorCapacity) HEAPU8[error] = 0;
    if (consumed) HEAPU8[consumed] = 0;
    try {
      var args = DEFOLD_HERMES_SCRIPT_UNIVERSAL.decodeWireRoots(
        values, valueCount, entries, entryCount, strings, stringBytes,
        floats, floatCount, urls, urlCount, roots, rootCount, true);
      var result = DEFOLD_HERMES_COMPONENTS.dispatch(slot, generation, UTF8ToString(lifecycle), args);
      if (consumed) HEAPU8[consumed] = result ? 1 : 0;
      return 1;
    } catch (failure) {
      DEFOLD_HERMES_COMPONENTS.report(error, errorCapacity, failure);
      return 0;
    }
  },

  defoldHermesWebComponentReload__deps: ['$DEFOLD_HERMES_COMPONENTS'],
  defoldHermesWebComponentReload: function(slot, generation, error, errorCapacity) {
    if (errorCapacity) HEAPU8[error] = 0;
    try {
      DEFOLD_HERMES_COMPONENTS.reload(slot, generation);
      return 1;
    } catch (failure) {
      DEFOLD_HERMES_COMPONENTS.report(error, errorCapacity, failure);
      return 0;
    }
  },

  defoldHermesWebComponentDetach__deps: ['$DEFOLD_HERMES_COMPONENTS'],
  defoldHermesWebComponentDetach: function(slot, generation) {
    DEFOLD_HERMES_COMPONENTS.detach(slot, generation);
  },

  defoldHermesWebComponentLive__deps: ['$DEFOLD_HERMES_COMPONENTS'],
  defoldHermesWebComponentLive: function() {
    return DEFOLD_HERMES_COMPONENTS.live >>> 0;
  }
};

addToLibrary(LibraryDefoldHermesComponents);
