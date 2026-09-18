// In-process headless Defold conformance driver.
//
// This is the RUNTIME evidence instrument for generated binding conformance.
// It links the déherm native extension against the pinned Defold SDK with the
// null graphics/sound/hid/window/platform backends selected by Defold's own
// `headless` bundle variant, and drives the engine one tick at a time through
// the public lifecycle API in upstream/defold/engine/engine/src/engine.h.
//
// It is deliberately content-agnostic: every conformance case is selected by
// argv, exactly as Defold's own engine/src/test/test_engine.cpp does, and the
// generated harness content decides pass/fail and signals it through the
// engine exit code. This file therefore contains no per-contract and no
// per-route knowledge and never needs regeneration when the plan changes.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <engine.h>

extern "C" void dmExportedSymbols();  // native/headless_conformance_exported_symbols.cpp

namespace {

struct Case {
  std::string id;
  std::string collection;
  int max_ticks = 0;
};

struct Outcome {
  const char* disposition;
  int exit_code;
  int ticks;
};

// Mirrors the caller-owned reading of engine/src/test/test_engine.cpp: the
// harness owns create/loop/destroy so the tick budget is ours, not inferred
// from process behaviour.
Outcome RunCase(const std::string& project_file, const Case& item, int argc_extra, char** argv_extra) {
  std::string boot = "--config=bootstrap.main_collection=" + item.collection;
  std::string selected = "--config=deherm_conformance.case=" + item.id;

  std::vector<const char*> argv;
  argv.push_back("deherm-headless-conformance");
  argv.push_back(boot.c_str());
  argv.push_back(selected.c_str());
  argv.push_back("--config=dmengine.unload_builtins=0");
  for (int i = 0; i < argc_extra; ++i) argv.push_back(argv_extra[i]);
  argv.push_back(project_file.c_str());

  dmEngine::HEngine engine = dmEngineCreate(static_cast<int>(argv.size()), const_cast<char**>(argv.data()));
  if (engine == 0) {
    return Outcome{"engine-create-failed", -1, 0};
  }

  dmEngine::UpdateResult result = dmEngine::RESULT_OK;
  int ticks = 0;
  while (result == dmEngine::RESULT_OK && ticks < item.max_ticks) {
    result = dmEngineUpdate(engine);
    ++ticks;
  }

  int run_action = 0;
  int exit_code = 0;
  int reboot_argc = 0;
  char** reboot_argv = 0;
  const char* disposition = "tick-budget-exhausted";
  if (result != dmEngine::RESULT_OK) {
    dmEngineGetResult(engine, &run_action, &exit_code, &reboot_argc, &reboot_argv);
    disposition = result == dmEngine::RESULT_REBOOT ? "rebooted" : "exited";
    if (reboot_argv != 0) {
      for (int i = 0; i < reboot_argc; ++i) free(reboot_argv[i]);
      free(reboot_argv);
    }
  }
  dmEngineDestroy(engine);
  return Outcome{disposition, exit_code, ticks};
}

bool ReadManifest(const char* path, std::vector<Case>* cases) {
  FILE* file = fopen(path, "rb");
  if (file == 0) return false;
  char line[4096];
  while (fgets(line, sizeof(line), file) != 0) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = '\0';
    if (length == 0 || line[0] == '#') continue;
    char* first = strchr(line, '\t');
    if (first == 0) { fclose(file); return false; }
    *first = '\0';
    char* second = strchr(first + 1, '\t');
    if (second == 0) { fclose(file); return false; }
    *second = '\0';
    Case item;
    item.id = line;
    item.collection = first + 1;
    item.max_ticks = atoi(second + 1);
    if (item.max_ticks <= 0) { fclose(file); return false; }
    cases->push_back(item);
  }
  fclose(file);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  const char* project_file = 0;
  const char* manifest = 0;
  int extra_start = argc;
  for (int i = 1; i < argc; ++i) {
    if (strcmp(argv[i], "--project-file") == 0 && i + 1 < argc) { project_file = argv[++i]; continue; }
    if (strcmp(argv[i], "--manifest") == 0 && i + 1 < argc) { manifest = argv[++i]; continue; }
    if (strcmp(argv[i], "--") == 0) { extra_start = i + 1; break; }
    fprintf(stderr, "headless-conformance:usage-error:%s\n", argv[i]);
    return 2;
  }
  if (project_file == 0 || manifest == 0) {
    fprintf(stderr, "headless-conformance:usage: --project-file <game.projectc> --manifest <tsv> [-- <extra engine argv>]\n");
    return 2;
  }

  std::vector<Case> cases;
  if (!ReadManifest(manifest, &cases)) {
    fprintf(stderr, "headless-conformance:manifest-unreadable:%s\n", manifest);
    return 2;
  }

  int argc_extra = extra_start < argc ? argc - extra_start : 0;
  char** argv_extra = argc_extra > 0 ? argv + extra_start : 0;

  // engine_main.cpp calls this before the run loop; the driver replaces
  // engine_main, so it owns the same registration step.
  dmExportedSymbols();
  dmEngineInitialize();
  int failures = 0;
  printf("headless-conformance:driver:cases:%zu\n", cases.size());
  fflush(stdout);
  for (size_t i = 0; i < cases.size(); ++i) {
    printf("headless-conformance:case-begin\t%s\n", cases[i].id.c_str());
    fflush(stdout);
    Outcome outcome = RunCase(project_file, cases[i], argc_extra, argv_extra);
    printf("headless-conformance:case-end\t%s\t%s\t%d\t%d\n",
           cases[i].id.c_str(), outcome.disposition, outcome.exit_code, outcome.ticks);
    fflush(stdout);
    if (strcmp(outcome.disposition, "exited") != 0 || outcome.exit_code != 0) ++failures;
  }
  dmEngineFinalize();
  printf("headless-conformance:driver:failures:%d\n", failures);
  fflush(stdout);
  return failures == 0 ? 0 : 1;
}
