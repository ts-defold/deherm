// Open a URL in the user's own browser.
//
// The dev view enables mouse reporting so the log can be drag-selected, which
// takes clicks before the terminal sees them. The terminal still underlines
// URLs, so the affordance is there and the click silently does nothing unless
// the view opens them itself.
//
// The URL is passed as an ARGUMENT, never interpolated into a shell string: log
// lines are not trusted input, and a URL containing shell metacharacters must
// not become a command.

import { spawn } from "node:child_process";

export function openExternal(url) {
  if (!/^https?:\/\//.test(url)) {
    return Promise.reject(new Error(`refusing to open a non-http(s) target: ${url}`));
  }
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      // `start` is a cmd builtin; the empty string is the window title argument,
      // without which a quoted URL would be taken as the title.
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
