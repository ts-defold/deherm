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
};
      }
      this.cursor = 0;
      this.live = 0;
this.revision = (this.revision + 1) >>> 0 || 1;
      return this.revision;
    },

    reset: function() {
      this.slots = null;
      this.cursor = 0;
      this.live = 0;
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
slot.live = true;
      this.cursor = (slotIndex + 1) % this.capacity;
      ++this.live;
      return {slot: slotIndex, generation: slot.generation};
    },

    setProperty: function(slot, generation, name, value) {
      var entry = this.resolve(slot, generation);
entry.self[name] = value;
},
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
