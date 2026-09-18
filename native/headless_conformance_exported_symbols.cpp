// Defold resolves its statically linked component types, resource types, script
// extensions and adapters through `dmExportedSymbols`, which the Extender
// normally synthesises from `extender/build.yml` plus the selected variant
// appmanifest. The headless conformance driver links the same pinned SDK
// archives without the Extender, so it declares the same symbol set here:
// the common list from `defoldsdk/extender/build.yml`, the macOS additions, and
// the `headless.appmanifest` substitutions (null sound device and null
// graphics adapter replacing the platform ones).
//
// This file is engine link configuration, not generated binding code: it
// carries no route, contract or API-surface knowledge.

extern "C" {

// build.yml: context.symbols (common), minus headless excludeSymbols
void ComponentTypeAnim();
void ComponentTypeGui();
void ComponentTypeMesh();
void ComponentTypeScript();
void ComponentTypeSound();
void ComponentTypeLight();
void ComponentTypeParticleFX();
void ComponentTypeTileMap();
void CrashExt();
void LiveUpdateExt();
void ProfilerExt();
void ResourceProviderArchive();
void ResourceProviderFile();
void ResourceProviderHttp();
void ResourceProviderZip();
void ResourceTypeAnim();
void ResourceTypeAnimationSet();
void ResourceTypeCollection();
void ResourceTypeFont();
void ResourceTypeGameObject();
void ResourceTypeGui();
void ResourceTypeGuiScript();
void ResourceTypeLua();
void ResourceTypeOgg();
void ResourceTypeScript();
void ResourceTypeTTF();
void ResourceTypeWav();
void ResourceTypeLight();
void ResourceTypeParticleFX();
void ResourceTypeTileMap();
void ScriptBox2DExt();
void ScriptBullet3DExt();
void ScriptFont();
void ScriptHttp();
void ScriptImageExt();
void ScriptModelExt();
void ScriptTypesExt();
void ScriptMaterialExt();
void ScriptLibParticleFX();
void ScriptLibTileMap();

// build.yml: osx context.symbols, minus headless excludeSymbols. ProfilerRemotery
// is dropped with the real profiler libraries: a conformance harness must not
// open a websocket or start a sampling thread per engine instance.
void ScriptComputeExt();

// headless.appmanifest: osx context.symbols
void NullSoundDevice();
void GraphicsAdapterNull();

// The déherm native extension. Extender derives this from the extension folder
// name and appends it to the same exported-symbol list.
void defold_hermes();

void dmExportedSymbols() {
  ComponentTypeAnim();
  ComponentTypeGui();
  ComponentTypeMesh();
  ComponentTypeScript();
  ComponentTypeSound();
  ComponentTypeLight();
  ComponentTypeParticleFX();
  ComponentTypeTileMap();
  CrashExt();
  LiveUpdateExt();
  ProfilerExt();
  ResourceProviderArchive();
  ResourceProviderFile();
  ResourceProviderHttp();
  ResourceProviderZip();
  ResourceTypeAnim();
  ResourceTypeAnimationSet();
  ResourceTypeCollection();
  ResourceTypeFont();
  ResourceTypeGameObject();
  ResourceTypeGui();
  ResourceTypeGuiScript();
  ResourceTypeLua();
  ResourceTypeOgg();
  ResourceTypeScript();
  ResourceTypeTTF();
  ResourceTypeWav();
  ResourceTypeLight();
  ResourceTypeParticleFX();
  ResourceTypeTileMap();
  ScriptBox2DExt();
  ScriptBullet3DExt();
  ScriptFont();
  ScriptHttp();
  ScriptImageExt();
  ScriptModelExt();
  ScriptTypesExt();
  ScriptMaterialExt();
  ScriptLibParticleFX();
  ScriptLibTileMap();
  ScriptComputeExt();
  NullSoundDevice();
  GraphicsAdapterNull();
  defold_hermes();
}

}  // extern "C"
