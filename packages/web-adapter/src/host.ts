import type { DefoldApiV1, LogLevel } from "@defold-hermes/sdk";

declare global {
  var __defoldTranscript: string[] | undefined;
}

const transcript: string[] = [];
globalThis.__defoldTranscript = transcript;

function append(line: string): void {
  transcript.push(line);
  const output = document.querySelector<HTMLPreElement>("#output");
  if (output) output.textContent = `${transcript.join("\n")}\n`;
}

const host: DefoldApiV1 = {
  version: 1,
  runtime: "browser",
  log(level: LogLevel, message: string) {
    append(`host.log:${level}:${message}`);
  },
  now() {
    return performance.now();
  },
  request(channel: string, payload: string) {
    const reply = `browser:${channel}:${payload}`;
    append(`host.request:${channel}:${payload}`);
    return reply;
  }
};

globalThis.__defoldHostV1 = host;

type TimerCallback = (handle: number, elapsed: number) => void;
type BrowserTimer = {
  callback: TimerCallback;
  repeating: boolean;
  startedAt: number;
  browserHandle: number;
};

const browserTimers = new Map<number, BrowserTimer>();
let nextTimerHandle = 1;

function fireTimer(handle: number): boolean {
  const timer = browserTimers.get(handle);
  if (!timer) return false;
  timer.callback(handle, (performance.now() - timer.startedAt) / 1000);
  if (!timer.repeating) browserTimers.delete(handle);
  return true;
}

globalThis.__defoldModulesV1 = {
  ExampleMath: {
    add(a: number, b: number) {
      return a + b;
    },
    multiply(a: number, b: number) {
      return a * b;
    }
  },
  Timer: {
    delay(delay: number, repeating: boolean, callback: TimerCallback) {
      const handle = nextTimerHandle++;
      const milliseconds = Math.max(0, delay * 1000);
      const browserHandle = repeating
        ? window.setInterval(() => fireTimer(handle), milliseconds)
        : window.setTimeout(() => fireTimer(handle), milliseconds);
      browserTimers.set(handle, {
        callback,
        repeating,
        startedAt: performance.now(),
        browserHandle
      });
      return handle;
    },
    cancel(handle: number) {
      const timer = browserTimers.get(handle);
      if (!timer) return false;
      if (timer.repeating) window.clearInterval(timer.browserHandle);
      else window.clearTimeout(timer.browserHandle);
      browserTimers.delete(handle);
      return true;
    },
    trigger(handle: number) {
      return fireTimer(handle);
    }
  }
};
append("host.ready:browser");
