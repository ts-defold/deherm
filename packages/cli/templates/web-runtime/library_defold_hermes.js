var LibraryDefoldHermes = {
  $DEFOLD_HERMES_WEB_CALLBACKS: {
    runtime: 1,
    type: 1,
    capacity: 4096,
    functions: [],
    generations: [],
    free: [],

    acquire: function(callback) {
      if (typeof callback !== 'function') throw new TypeError('Expected a timer callback');
      if (!this.free.length && this.functions.length >= this.capacity) {
        throw new RangeError('Browser callback pool is exhausted');
      }
      var slot = this.free.length ? this.free.pop() : this.functions.length;
      if (this.generations[slot] === undefined) this.generations[slot] = 1;
      this.functions[slot] = callback;
      return {
        runtime: this.runtime >>> 0,
        slot: slot >>> 0,
        generation: this.generations[slot] >>> 0,
        type: this.type >>> 0
      };
    },

    resolve: function(handle) {
      return this.resolveParts(handle.runtime, handle.slot, handle.generation, handle.type);
    },

    resolveParts: function(runtime, slot, generation, type) {
      runtime = runtime >>> 0;
      slot = slot >>> 0;
      generation = generation >>> 0;
      type = type >>> 0;
      if (slot >= this.capacity) return null;
      if (runtime !== this.runtime || type !== this.type) return null;
      if (this.generations[slot] !== generation) return null;
      return this.functions[slot] || null;
    },

    release: function(handle) {
      return this.releaseParts(handle.runtime, handle.slot, handle.generation, handle.type);
    },

    releaseParts: function(runtime, slot, generation, type) {
      runtime = runtime >>> 0;
      slot = slot >>> 0;
      generation = generation >>> 0;
      type = type >>> 0;
      if (!this.resolveParts(runtime, slot, generation, type)) return false;
      this.functions[slot] = null;
      this.generations[slot] = (this.generations[slot] + 1) >>> 0 || 1;
      this.free.push(slot);
      return true;
    },

    reset: function() {
      this.functions.length = 0;
      this.generations.length = 0;
      this.free.length = 0;
      this.runtime = (this.runtime + 1) >>> 0 || 1;
    }
  },

  $DEFOLD_HERMES_BRIDGE__deps: [
    '$DEFOLD_HERMES_GENERATED_MODULES',
    '$DEFOLD_HERMES_WEB_CALLBACKS',
    '$DEFOLD_HERMES_SCRIPT_UNIVERSAL',
    '$DEFOLD_HERMES_COMPONENTS',
    '$UTF8ToString',
    '$stringToUTF8'
  ],
  $DEFOLD_HERMES_BRIDGE: {
    app: null,
    // The browser host's own bundle generation. There is no Defold resource
    // generation here: HTML5 has no engine service, so a reload is not a
    // resource recreate but a bundle handed to `activate` from outside.
    generation: 0,
    // Genuinely observed frame numbers, recorded where the engine already
    // calls in. Nothing here is sampled or estimated.
    frames: 0,
    lastFrameDtMs: null,

    reset: function() {
      if (DEFOLD_HERMES_SCRIPT_UNIVERSAL && typeof DEFOLD_HERMES_SCRIPT_UNIVERSAL.dispose === 'function') {
        DEFOLD_HERMES_SCRIPT_UNIVERSAL.dispose();
      }
      this.app = null;
      this.generation = 0;
      this.frames = 0;
      this.lastFrameDtMs = null;
      globalThis.__defoldAppV1 = undefined;
      globalThis.__defoldHostV1 = undefined;
      globalThis.__defoldModulesV1 = undefined;
      globalThis.__defoldScriptBridgeV1 = undefined;
      globalThis.__defoldComponentsV1 = undefined;
      globalThis.__defoldHermesDevV1 = undefined;
      DEFOLD_HERMES_COMPONENTS.reset();
      DEFOLD_HERMES_WEB_CALLBACKS.reset();
    },

    load: function(sourcePointer, sourceSize) {
      var source = UTF8ToString(sourcePointer, sourceSize);
      globalThis.__defoldHostV1 = {
        version: 1,
        runtime: 'browser',
        log: function(level, message) {
          var logger = console[level] || console.log;
          logger.call(console, '[defold-hermes]', message);
        },
        now: function() {
          return performance.now();
        },
        request: function(channel, payload) {
          return 'browser:' + channel + ':' + payload;
        }
      };
      globalThis.__defoldModulesV1 = DEFOLD_HERMES_GENERATED_MODULES.install();
      globalThis.__defoldScriptBridgeV1 = DEFOLD_HERMES_SCRIPT_UNIVERSAL.install();

      try {
        (0, eval)(source + '\n//# sourceURL=defold-hermes://app.js');
        DEFOLD_HERMES_BRIDGE.app = globalThis.__defoldAppV1 || null;
        // A bundle registers an application lifecycle, a component registry, or
        // both. `runtime.cpp` applies exactly this rule for dynamic Hermes.
        var components = globalThis.__defoldComponentsV1;
        var hasComponents = Boolean(components) && typeof components === 'object';
        if (!DEFOLD_HERMES_BRIDGE.app && !hasComponents) {
          throw new Error('Bundle registered neither __defoldAppV1 nor __defoldComponentsV1');
        }
        if (hasComponents) DEFOLD_HERMES_COMPONENTS.activate();
        DEFOLD_HERMES_BRIDGE.generation = 1;
        // The development control plane reaches the browser host from outside
        // the page - there is no engine service on HTML5 to post a resource
        // reload to. This is that entry point, and it is the only way in.
        globalThis.__defoldHermesDevV1 = {
          version: 1,
          runtime: 'browser',
          activate: function(candidate) { return DEFOLD_HERMES_BRIDGE.activate(candidate); },
          telemetry: function() { return DEFOLD_HERMES_BRIDGE.telemetry(); }
          /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
          ,
          componentSnapshot: function() { return DEFOLD_HERMES_BRIDGE.componentSnapshot(); }
          /* DEHERM_DEBUG_SNAPSHOT_END */
        };
      } catch (error) {
        DEFOLD_HERMES_BRIDGE.reset();
        throw error;
      }
    },

    /**
     * Replace the running bundle with `candidate`, or leave the running one
     * untouched.
     *
     * The ordering is the native transaction's ordering, for the same reason:
     * the candidate's `init` runs before the outgoing generation's `final`, so
     * a candidate that throws cannot tear down the last good application
     * (`extension.cpp` ActivateBundle). Live component attachments are rebound
     * to the new definitions by id, which keeps the engine-side Lua proxies,
     * their `self` tables and their component ids alive across the swap.
     *
     * One difference from native is structural and is reported rather than
     * hidden: the browser host has exactly one JavaScript realm, so a
     * candidate is evaluated in the same global as the generation it replaces.
     * Rollback restores the registered surface - the app, the component
     * registry and the fingerprint - and cannot undo arbitrary global writes a
     * failed candidate performed on its way to failing.
     */
    activate: function(candidate) {
      if (typeof candidate !== 'string' || !candidate) {
        return {status: 'rejected', diagnostic: 'Candidate bundle source must be a non-empty string'};
      }
      if (!globalThis.__defoldHostV1) {
        return {status: 'rejected', diagnostic: 'Browser host is not loaded'};
      }
      var previous = {
        app: DEFOLD_HERMES_BRIDGE.app,
        registered: globalThis.__defoldAppV1,
        components: globalThis.__defoldComponentsV1,
        fingerprint: globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__
      };
      var pending = DEFOLD_HERMES_BRIDGE.generation + 1;
      var fingerprint = null;
      try {
        // Clear the running generation's fingerprint first, so the value read
        // back after evaluation is the candidate's own. Inheriting the previous
        // one would let the host acknowledge a bundle it never ran.
        globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__ = undefined;
        (0, eval)(candidate + '\n//# sourceURL=defold-hermes://app.' + pending + '.js');
        var app = globalThis.__defoldAppV1 || null;
        var components = globalThis.__defoldComponentsV1;
        var hasComponents = Boolean(components) && typeof components === 'object';
        if (!app && !hasComponents) {
          throw new Error('Bundle registered neither __defoldAppV1 nor __defoldComponentsV1');
        }
        var candidateFingerprint = globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__;
        if (typeof candidateFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(candidateFingerprint)) {
          throw new Error('Candidate bundle carries no build fingerprint');
        }
        fingerprint = candidateFingerprint;
        DEFOLD_HERMES_BRIDGE.app = app;
        if (app && app.init) app.init();
        var rebind = hasComponents
          ? DEFOLD_HERMES_COMPONENTS.rebindAll()
          : {rebound: 0, live: 0, failed: []};
        if (rebind.failed.length) {
          throw new Error('Component rebind failed: ' + rebind.failed
            .map(function(entry) { return entry.componentId + ': ' + entry.message; }).join('; '));
        }
        // Accepted. The outgoing finalizer runs after the accepted candidate's
        // init, exactly as the native transaction orders it.
        if (previous.app && previous.app !== app && previous.app.final) {
          try {
            previous.app.final();
          } catch (failure) {
            console.warn('[defold-hermes] previous generation finalizer failed', failure);
          }
        }
        DEFOLD_HERMES_BRIDGE.generation = pending;
        console.log('[defold-hermes] DEHERM_EVENT bundle-activated fingerprint=' + fingerprint +
          ' resource_generation=' + pending +
          ' runtime_id=' + (DEFOLD_HERMES_COMPONENTS.revision >>> 0) + ' initial=false');
        return {
          status: 'activated',
          fingerprint: fingerprint,
          generation: pending,
          componentRevision: DEFOLD_HERMES_COMPONENTS.revision >>> 0,
          reboundComponents: rebind.rebound,
          liveComponents: rebind.live
        };
      } catch (error) {
        DEFOLD_HERMES_BRIDGE.app = previous.app;
        globalThis.__defoldAppV1 = previous.registered;
        globalThis.__defoldComponentsV1 = previous.components;
        globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__ = previous.fingerprint;
        var diagnostic = error && error.message ? error.message : String(error);
        console.error('[defold-hermes] DEHERM_EVENT bundle-rejected fingerprint=' +
          (fingerprint || 'unavailable') + ' resource_generation=' + pending +
          ' runtime_id=' + (DEFOLD_HERMES_COMPONENTS.revision >>> 0) + ' initial=false');
        console.error('[defold-hermes] browser bundle generation ' + pending + ' was rejected: ' + diagnostic);
        return {status: 'rejected', generation: pending, diagnostic: diagnostic};
      }
    },

    /**
     * What the browser host genuinely knows, and what it does not.
     *
     * Every counter the native extension reports is answered here exactly
     * once, either with a measured value or with the reason no value exists.
     * Nothing is estimated, and no native counter is imitated by a browser
     * number that means something else: `performance.memory` is the page's
     * JavaScript heap, so it is reported under its own name rather than as a
     * Hermes heap.
     */
    telemetry: function() {
      var callbacks = DEFOLD_HERMES_WEB_CALLBACKS;
      var liveCallbacks = 0;
      for (var index = 0; index < callbacks.functions.length; ++index) {
        if (callbacks.functions[index]) ++liveCallbacks;
      }
      var memory = (typeof performance !== 'undefined' && performance.memory) || null;
      var componentsLoaded = Boolean(DEFOLD_HERMES_COMPONENTS.slots);
      // The frame delta reaches this host only through the application
      // lifecycle's update, which the engine calls from the bootstrap script
      // attachment. A component-only bundle registers no such attachment, so
      // there is no frame delta to report and saying so is the only honest
      // answer available.
      var frameDeltaMeasured = DEFOLD_HERMES_BRIDGE.frames > 0;
      return {
        runtime: 'browser',
        generation: DEFOLD_HERMES_BRIDGE.generation,
        componentRevision: DEFOLD_HERMES_COMPONENTS.revision >>> 0,
        frames: DEFOLD_HERMES_BRIDGE.frames,
        available: {
          frameDtMs: frameDeltaMeasured ? DEFOLD_HERMES_BRIDGE.lastFrameDtMs : null,
          componentInstances: componentsLoaded ? DEFOLD_HERMES_COMPONENTS.live : 0,
          componentCapacity: DEFOLD_HERMES_COMPONENTS.capacity,
          callbackRoots: liveCallbacks,
          callbackCapacity: callbacks.capacity,
          jsHeapBytes: memory ? memory.usedJSHeapSize : null,
          jsHeapSizeBytes: memory ? memory.totalJSHeapSize : null,
          jsHeapLimitBytes: memory ? memory.jsHeapSizeLimit : null
        },
        unavailable: {
          frameDtMs: frameDeltaMeasured
            ? null
            : 'No application lifecycle is attached, so the engine never calls the browser host update. A component-only bundle measures no frame delta here; Defold\'s own frame timing is inside the Wasm engine.',
          hermesHeapBytes: 'The browser runtime embeds no Hermes. performance.memory measures the page JavaScript heap and is reported as jsHeapBytes instead.',
          hermesHeapPeakBytes: 'The browser runtime embeds no Hermes.',
          luaHandles: 'The Lua value registry lives inside the Wasm engine and exports no counter to the browser host.',
          arenaHighWaterBytes: 'The generated browser value bridge resets its per-call arena state and records no high-water mark; adding one is a generator change.',
          jsHeapBytesWhenAbsent: memory ? null : 'performance.memory is a Chromium-only extension and this browser does not expose it.'
        }
      };
    },

    /* DEHERM_DEBUG_SNAPSHOT_BEGIN */
    componentSnapshot: function() {
      return DEFOLD_HERMES_COMPONENTS.componentSnapshot(DEFOLD_HERMES_WEB_CALLBACKS.runtime);
    },
    /* DEHERM_DEBUG_SNAPSHOT_END */

    fingerprint: function(buffer, capacity) {
      var value = globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__;
      if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) return 0;
      if (!capacity) return 0;
      stringToUTF8(value, buffer, capacity);
      return value.length;
    },

    init: function() {
      if (DEFOLD_HERMES_BRIDGE.app && DEFOLD_HERMES_BRIDGE.app.init) {
        DEFOLD_HERMES_BRIDGE.app.init();
      }
    },

    update: function(dt) {
      // The engine already passes the frame delta here, so recording it is a
      // measurement rather than an instrument.
      DEFOLD_HERMES_BRIDGE.frames = (DEFOLD_HERMES_BRIDGE.frames + 1) >>> 0;
      DEFOLD_HERMES_BRIDGE.lastFrameDtMs = dt * 1000;
      if (DEFOLD_HERMES_BRIDGE.app && DEFOLD_HERMES_BRIDGE.app.update) {
        DEFOLD_HERMES_BRIDGE.app.update(dt);
      }
    },

    finalize: function() {
      try {
        if (DEFOLD_HERMES_BRIDGE.app && DEFOLD_HERMES_BRIDGE.app.final) {
          DEFOLD_HERMES_BRIDGE.app.final();
        }
      } finally {
        DEFOLD_HERMES_BRIDGE.reset();
      }
    }
  },

  defoldHermesWebLoad__deps: [
    '$DEFOLD_HERMES_BRIDGE',
    'defold_hermes_example_math_add'
  ],
  defoldHermesWebLoad: function(sourcePointer, sourceSize) {
    DEFOLD_HERMES_BRIDGE.load(sourcePointer, sourceSize);
  },

  defoldHermesWebBundleFingerprint__deps: ['$DEFOLD_HERMES_BRIDGE', '$stringToUTF8'],
  defoldHermesWebBundleFingerprint: function(buffer, capacity) {
    return DEFOLD_HERMES_BRIDGE.fingerprint(buffer, capacity);
  },

  defoldHermesWebUpdate__deps: ['$DEFOLD_HERMES_BRIDGE'],
  defoldHermesWebUpdate: function(dt) {
    DEFOLD_HERMES_BRIDGE.update(dt);
  },

  defoldHermesWebInit__deps: ['$DEFOLD_HERMES_BRIDGE'],
  defoldHermesWebInit: function() {
    DEFOLD_HERMES_BRIDGE.init();
  },

  defoldHermesWebFinalize__deps: ['$DEFOLD_HERMES_BRIDGE'],
  defoldHermesWebFinalize: function() {
    DEFOLD_HERMES_BRIDGE.finalize();
  },

  defoldHermesWebInvokeCallback__deps: ['$DEFOLD_HERMES_WEB_CALLBACKS'],
  defoldHermesWebInvokeCallback: function(runtime, slot, generation, type, timer, elapsed) {
    var callback = DEFOLD_HERMES_WEB_CALLBACKS.resolveParts(runtime, slot, generation, type);
    if (!callback) return 0;
    try {
      callback(timer, elapsed);
      return 1;
    } catch (error) {
      console.error('[defold-hermes] timer callback failed', error);
      return 0;
    }
  },

  defoldHermesWebReleaseCallback__deps: ['$DEFOLD_HERMES_WEB_CALLBACKS'],
  defoldHermesWebReleaseCallback: function(runtime, slot, generation, type) {
    DEFOLD_HERMES_WEB_CALLBACKS.releaseParts(runtime, slot, generation, type);
  }
};

autoAddDeps(LibraryDefoldHermes, '$DEFOLD_HERMES_BRIDGE');
addToLibrary(LibraryDefoldHermes);
