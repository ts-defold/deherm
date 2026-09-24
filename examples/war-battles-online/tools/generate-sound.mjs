import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "defold/assets/derived/audio");
const check = process.argv.includes("--check");
const SAMPLE_RATE = 22_050;

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function envelope(time, duration, attack = 0.005, release = 0.08) {
  const fadeIn = Math.min(1, time / attack);
  const fadeOut = Math.min(1, Math.max(0, duration - time) / release);
  return fadeIn * fadeOut;
}

function square(phase) {
  return Math.sin(phase) >= 0 ? 1 : -1;
}

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffff_ffff) * 2 - 1;
  };
}

function tone(duration, sample) {
  const count = Math.ceil(duration * SAMPLE_RATE);
  const values = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const time = index / SAMPLE_RATE;
    values[index] = Math.round(clamp(sample(time, duration)) * 0x7fff);
  }
  return values;
}

function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(samples[index], 44 + index * 2);
  }
  return bytes;
}

const fireNoise = seededNoise(0xf1_2e_09);
const hitNoise = seededNoise(0x48_17_aa);
const explosionNoise = seededNoise(0xe7_10_de);

const cues = new Map([
  [
    "fire.wav",
    tone(0.11, (time, duration) => {
      const frequency = 240 - time * 1_450;
      const body = square(time * frequency * Math.PI * 2) * 0.55;
      return (body + fireNoise() * 0.28) * envelope(time, duration, 0.002, 0.055);
    }),
  ],
  [
    "hit.wav",
    tone(0.08, (time, duration) => {
      const ring = Math.sin(time * 880 * Math.PI * 2) * 0.35;
      return (hitNoise() * 0.72 + ring) * envelope(time, duration, 0.001, 0.06);
    }),
  ],
  [
    "explosion.wav",
    tone(0.38, (time, duration) => {
      const rumble = Math.sin(time * (72 - time * 55) * Math.PI * 2) * 0.62;
      const grit = explosionNoise() * (0.55 - time * 0.9);
      return (rumble + grit) * envelope(time, duration, 0.003, 0.22);
    }),
  ],
  [
    "pickup.wav",
    tone(0.2, (time, duration) => {
      const frequency = time < 0.065 ? 523.25 : time < 0.13 ? 659.25 : 783.99;
      return square(time * frequency * Math.PI * 2) * 0.42 * envelope(time, duration, 0.002, 0.04);
    }),
  ],
  [
    "round.wav",
    tone(0.32, (time, duration) => {
      const step = Math.min(3, Math.floor(time / 0.08));
      const frequency = [261.63, 329.63, 392, 523.25][step];
      return (
        square(time * frequency * Math.PI * 2) *
        0.38 *
        envelope(time % 0.08, 0.08, 0.002, 0.025) *
        envelope(time, duration, 0.002, 0.04)
      );
    }),
  ],
]);

await mkdir(outputDirectory, { recursive: true });
for (const [name, samples] of cues) {
  const path = resolve(outputDirectory, name);
  const expected = wav(samples);
  if (check) {
    let actual;
    try {
      actual = await readFile(path);
    } catch {
      throw new Error(`${name} is missing; run pnpm sound`);
    }
    if (!actual.equals(expected)) throw new Error(`${name} is stale; run pnpm sound`);
  } else {
    await writeFile(path, expected);
  }
}

console.log(`war-battles-sound:${check ? "fresh" : "generated"}:${cues.size}`);
