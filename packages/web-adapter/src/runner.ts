function append(line: string): void {
  const transcript = globalThis.__defoldTranscript ?? [];
  transcript.push(line);
  const output = document.querySelector<HTMLPreElement>("#output");
  if (output) output.textContent = `${transcript.join("\n")}\n`;
}
try {
  const app = globalThis.__defoldAppV1;
  if (!app) throw new Error("Application did not register");

  app.init?.();
  for (let index = 0; index < 3; index += 1) app.update?.(1 / 60);
  app.onMessage?.("hello-from-browser-host");
  app.final?.();

  append("defold-hermes:ok");
  document.documentElement.dataset.status = "passed";
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  append(`defold-hermes:error:${message}`);
  document.documentElement.dataset.status = "failed";
  throw error;
}
