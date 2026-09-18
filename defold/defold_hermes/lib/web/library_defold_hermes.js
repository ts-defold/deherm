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
        runtime: this.runtime,
        slot: slot,
        generation: this.generations[slot],
        type: this.type
      };
    },

    resolve: function(handle) {
      return this.resolveParts(handle.runtime, handle.slot, handle.generation, handle.type);
    },

    resolveParts: function(runtime, slot, generation, type) {
      if (runtime !== this.runtime || type !== this.type) return null;
      if (this.generations[slot] !== generation) return null;
      return this.functions[slot] || null;
    },

    release: function(handle) {
      return this.releaseParts(handle.runtime, handle.slot, handle.generation, handle.type);
    },

    releaseParts: function(runtime, slot, generation, type) {
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
    '$DEFOLD_HERMES_SCRIPT_BRIDGE',
    '$UTF8ToString'
  ],
  $DEFOLD_HERMES_BRIDGE: {
    app: null,

    reset: function() {
      this.app = null;
      globalThis.__defoldAppV1 = undefined;
      globalThis.__defoldHostV1 = undefined;
      globalThis.__defoldModulesV1 = undefined;
      globalThis.__defoldScriptBridgeV1 = undefined;
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
      globalThis.__defoldScriptBridgeV1 = DEFOLD_HERMES_SCRIPT_BRIDGE.install();

      try {
        (0, eval)(source + '\n//# sourceURL=defold-hermes://app.js');
        DEFOLD_HERMES_BRIDGE.app = globalThis.__defoldAppV1;
        if (!DEFOLD_HERMES_BRIDGE.app) throw new Error('Application did not register');
      } catch (error) {
        DEFOLD_HERMES_BRIDGE.reset();
        throw error;
      }
    },

    init: function() {
      if (DEFOLD_HERMES_BRIDGE.app && DEFOLD_HERMES_BRIDGE.app.init) {
        DEFOLD_HERMES_BRIDGE.app.init();
      }
    },

    update: function(dt) {
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
