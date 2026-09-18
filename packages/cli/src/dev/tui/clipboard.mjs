import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

// OSC 52 puts the selection on the clipboard of whichever machine is running
// the terminal emulator, which is the operator's machine even when the dev
// session is on the far end of an SSH connection. A local helper is only a
// fallback for terminals that refuse OSC 52.
export function osc52Sequence(text) {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

function localClipboardCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return ["pbcopy", []];
  if (platform === "win32") return ["clip", []];
  if (env.WAYLAND_DISPLAY) return ["wl-copy", []];
  if (env.DISPLAY) return ["xclip", ["-selection", "clipboard"]];
  return undefined;
}

function writeLocalClipboard(text, options) {
  const command = (options.localCommand ?? localClipboardCommand)(options.platform, options.env);
  if (!command) return false;
  try {
    const child = (options.spawn ?? spawn)(command[0], command[1], { stdio: ["pipe", "ignore", "ignore"] });
    child.on?.("error", () => {});
    child.stdin?.on?.("error", () => {});
    child.stdin?.end(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `text` to the operator's clipboard. Returns a machine-readable record of
 * which transports accepted the write so the console can report the truth
 * rather than claiming success it cannot observe.
 */
export function copyToClipboard(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return { copied: false, transports: [], bytes: 0, reason: "empty selection" };
  const transports = [];
  const writeRaw = options.writeRaw;
  if (typeof writeRaw === "function") {
    try {
      writeRaw(osc52Sequence(text));
      transports.push("osc52");
    } catch {
      // A terminal that rejects OSC 52 must not take the local path down with it.
    }
  }
  if (options.local !== false && writeLocalClipboard(text, options)) transports.push("local");
  return transports.length === 0
    ? { copied: false, transports, bytes: Buffer.byteLength(text, "utf8"), reason: "no clipboard transport available" }
    : { copied: true, transports, bytes: Buffer.byteLength(text, "utf8") };
}

export function decodePaste(bytes) {
  if (typeof bytes === "string") return bytes;
  if (!bytes) return "";
  return new TextDecoder().decode(bytes);
}
