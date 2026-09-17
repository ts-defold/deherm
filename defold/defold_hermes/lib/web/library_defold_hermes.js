var LibraryDefoldHermes = {
  $DEFOLD_HERMES_WEB_CALLBACKS: {
    runtime: 1,
    type: 1,
    functions: [],
    generations: [],
    free: [],

    acquire: function(callback) {
      if (typeof callback !== 'function') throw new TypeError('Expected a timer callback');
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
      if (handle.runtime !== this.runtime || handle.type !== this.type) return null;
      if (this.generations[handle.slot] !== handle.generation) return null;
      return this.functions[handle.slot] || null;
    },

    release: function(handle) {
      if (!this.resolve(handle)) return false;
      this.functions[handle.slot] = null;
      this.generations[handle.slot] = (this.generations[handle.slot] + 1) >>> 0 || 1;
      this.free.push(handle.slot);
      return true;
    },

    reset: function() {
      this.functions.length = 0;
      this.generations.length = 0;
      this.free.length = 0;
    }
  },

  $DEFOLD_HERMES_BRIDGE__deps: [
    '$DEFOLD_HERMES_GENERATED_MODULES',
    '$DEFOLD_HERMES_WEB_CALLBACKS'
  ],
  $DEFOLD_HERMES_BRIDGE: {
    app: null,

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

      (0, eval)(source + '\n//# sourceURL=defold-hermes://app.js');
      DEFOLD_HERMES_BRIDGE.app = globalThis.__defoldAppV1;
      if (!DEFOLD_HERMES_BRIDGE.app) throw new Error('Application did not register');
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
      if (DEFOLD_HERMES_BRIDGE.app && DEFOLD_HERMES_BRIDGE.app.final) {
        DEFOLD_HERMES_BRIDGE.app.final();
      }
      DEFOLD_HERMES_BRIDGE.app = null;
      globalThis.__defoldAppV1 = undefined;
      globalThis.__defoldHostV1 = undefined;
      globalThis.__defoldModulesV1 = undefined;
      DEFOLD_HERMES_WEB_CALLBACKS.reset();
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
    var handle = { runtime: runtime, slot: slot, generation: generation, type: type };
    var callback = DEFOLD_HERMES_WEB_CALLBACKS.resolve(handle);
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
    DEFOLD_HERMES_WEB_CALLBACKS.release({
      runtime: runtime,
      slot: slot,
      generation: generation,
      type: type
    });
  }
};

autoAddDeps(LibraryDefoldHermes, '$DEFOLD_HERMES_BRIDGE');
addToLibrary(LibraryDefoldHermes);
