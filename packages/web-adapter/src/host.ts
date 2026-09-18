import type { DefoldApiV1, LogLevel } from "@deherm/sdk";

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
  cycleStartedAt: number;
  browserHandle: number;
};

const browserTimers = new Map<number, BrowserTimer>();
let nextTimerHandle = 1;

function elapsedSeconds(timer: BrowserTimer): number {
  return (performance.now() - timer.cycleStartedAt) / 1000;
}

function fireScheduledTimer(handle: number): boolean {
  const timer = browserTimers.get(handle);
  if (!timer) return false;
  const elapsed = elapsedSeconds(timer);
  if (timer.repeating) timer.cycleStartedAt = performance.now();
  else browserTimers.delete(handle);
  timer.callback(handle, elapsed);
  return true;
}

function triggerTimer(handle: number): boolean {
  const timer = browserTimers.get(handle);
  if (!timer) return false;
  // Defold's timer.trigger invokes the callback without changing the timer's
  // schedule or consuming a one-shot timer.
  timer.callback(handle, elapsedSeconds(timer));
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
        ? window.setInterval(() => fireScheduledTimer(handle), milliseconds)
        : window.setTimeout(() => fireScheduledTimer(handle), milliseconds);
      browserTimers.set(handle, {
        callback,
        repeating,
        cycleStartedAt: performance.now(),
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
      return triggerTimer(handle);
    }
  }
};
append("host.ready:browser");
