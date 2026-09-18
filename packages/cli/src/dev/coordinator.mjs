import { postResourceReload } from "./protocol.mjs";

export class HotReloadCoordinator {
  #compiler;
  #targets;
  #emit;
  #postReload;
  #pending = new Set();
  #forcePending = false;
  #loop;
  #generation = 0;
  #closed = false;

  constructor(options) {
    this.#compiler = options.compiler;
    this.#targets = options.targets ?? new Map();
    this.#emit = options.emit ?? (() => {});
    this.#postReload = options.postReload ?? postResourceReload;
  }

  requestBuild(changedSources = []) {
    if (this.#closed) return Promise.reject(new Error("hot reload coordinator is closed"));
    for (const source of changedSources) this.#pending.add(source);
    if (changedSources.length === 0 || (!this.#loop && this.#pending.size === 0)) this.#forcePending = true;
    if (!this.#loop) this.#loop = this.#drain().finally(() => { this.#loop = undefined; });
    return this.#loop;
  }

  async #drain() {
    while (this.#pending.size || this.#forcePending) {
      const changedSources = [...this.#pending].sort();
      this.#pending.clear();
      this.#forcePending = false;
      const generation = ++this.#generation;
      this.#emit({ type: "build-started", generation, changedSources });
      let build;
      try {
        build = await this.#compiler.rebuild(changedSources);
        this.#emit({
          type: "build-succeeded",
          generation,
          fingerprint: build.fingerprint,
          resources: build.resourcePaths,
          metrics: build.metrics
        });
      } catch (error) {
        this.#emit({ type: "build-failed", generation, diagnostic: error instanceof Error ? error.message : String(error) });
        continue;
      }

      await this.reloadResources(build.resourcePaths, generation);
    }
  }

  async reloadResources(resources, generation = this.#generation) {
    const targets = [...this.#targets];
    if (generation <= 0 || resources.length === 0 || targets.length === 0) return;
    for (const [id] of targets) this.#emit({ type: "reload-started", id, generation });
    await Promise.all(targets.map(async ([id, target]) => {
      try {
        await this.#postReload(target.url, resources);
        this.#emit({ type: "target-connected", id, name: target.name, url: target.url });
        this.#emit({ type: "reload-signalled", id, generation });
      } catch (error) {
        this.#emit({ type: "reload-failed", id, generation, diagnostic: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  async close() {
    this.#closed = true;
    await this.#loop;
    await this.#compiler.dispose?.();
  }
}
