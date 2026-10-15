import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { autoSync, type AutoSyncAudioInput } from "./auto-sync-engine";

/**
 * TS-vs-Python cross-check for real media pairs.
 *
 * Gated on the `AUTO_SYNC_PAIRS` environment variable and skipped in normal
 * test runs. Each entry is `reference.wav|camera.wav|python-offset` and
 * entries are separated by `;`:
 *
 *   AUTO_SYNC_PAIRS="C:/media/clean.wav|C:/media/camera.wav|-0.461;..." \
 *     pnpm --filter @openreel/core vitest run src/sync/auto-sync-crosscheck.test.ts
 *
 * The WAV files are decoded locally (PCM 16/24/32-bit or float 32/64-bit,
 * any channel count and sample rate — the engine downsamples to its 16 kHz
 * analysis rate itself). Media never needs to be committed to the repo; only
 * the paths go through the environment variable. See apps/web/docs/auto-sync.md.
 */

interface CrosscheckPair {
  refPath: string;
  cameraPath: string;
  /** Offset previously reported by Python's sync_ref.py for this pair. */
  expected: number;
}

function parsePairs(spec: string): CrosscheckPair[] {
  const pairs: CrosscheckPair[] = [];
  for (const rawEntry of spec.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split("|");
    if (parts.length !== 3) {
      throw new Error(
        `AUTO_SYNC_PAIRS: bad entry (expected reference|camera|offset): ${entry}`,
      );
    }
    const expected = Number((parts[2] ?? "").replace(/\u2212/g, "-").trim());
    if (!Number.isFinite(expected)) {
      throw new Error(
        `AUTO_SYNC_PAIRS: bad expected offset in entry: ${entry}`,
      );
    }
    pairs.push({
      refPath: (parts[0] ?? "").trim(),
      cameraPath: (parts[1] ?? "").trim(),
      expected,
    });
  }
  if (pairs.length === 0) {
    throw new Error("AUTO_SYNC_PAIRS: no pairs found in the value");
  }
  return pairs;
}

interface DecodedWav {
  channels: Float32Array[];
  sampleRate: number;
}

function decodeWav(path: string): DecodedWav {
  if (!/\.wav$/i.test(path)) {
    throw new Error(
      `${path}: only .wav input is supported — extract the audio first ` +
        `(ffmpeg -i input.MOV -c:a pcm_s16le output.wav)`,
    );
  }
  const file = readFileSync(path);
  if (file.length < 44) {
    throw new Error(`${path}: file too small to be a WAV`);
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      file[offset] ?? 0,
      file[offset + 1] ?? 0,
      file[offset + 2] ?? 0,
      file[offset + 3] ?? 0,
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > file.length) break;
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40 && body + 26 <= file.length) {
        // WAVE_FORMAT_EXTENSIBLE: real tag is the first field of the SubFormat GUID.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.max(0, Math.min(size, file.length - body));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  const supported =
    (format === 1 && (bits === 16 || bits === 24 || bits === 32)) ||
    (format === 3 && (bits === 32 || bits === 64));
  if (!supported || channels < 1 || sampleRate < 1 || dataOffset < 0) {
    throw new Error(
      `${path}: unsupported WAV (format ${format}, ${bits}-bit, ` +
        `${channels} ch, ${sampleRate} Hz) — re-export as PCM16 or float WAV`,
    );
  }

  const bytesPerSample = bits / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const out: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) {
    out.push(new Float32Array(frameCount));
  }

  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const at =
        dataOffset + (frame * channels + channel) * bytesPerSample;
      let value: number;
      if (format === 3 && bits === 32) {
        value = view.getFloat32(at, true);
      } else if (format === 3 && bits === 64) {
        value = view.getFloat64(at, true);
      } else if (bits === 16) {
        value = view.getInt16(at, true) / 32768;
      } else if (bits === 24) {
        let raw =
          (file[at] ?? 0) |
          ((file[at + 1] ?? 0) << 8) |
          ((file[at + 2] ?? 0) << 16);
        if (raw & 0x800000) raw -= 0x1000000;
        value = raw / 8388608;
      } else {
        value = view.getInt32(at, true) / 2147483648;
      }
      (out[channel] as Float32Array)[frame] = value;
    }
  }

  return { channels: out, sampleRate };
}

function toAudioInput(decoded: DecodedWav): AutoSyncAudioInput {
  return { channels: decoded.channels, sampleRate: decoded.sampleRate };
}

const spec = process.env.AUTO_SYNC_PAIRS?.trim();
const pairs = spec ? parsePairs(spec) : [];
const describeCrosscheck = spec ? describe : describe.skip;

describeCrosscheck("auto-sync cross-check vs Python (AUTO_SYNC_PAIRS)", () => {
  pairs.forEach((pair, index) => {
    it(
      `pair ${index + 1}: ${basename(pair.refPath)} + ${basename(pair.cameraPath)} ≈ ${pair.expected}s`,
      () => {
        const reference = decodeWav(pair.refPath);
        const camera = decodeWav(pair.cameraPath);

        const result = autoSync(
          toAudioInput(reference),
          toAudioInput(camera),
        );
        const deltaMs = (result.syncTime - pair.expected) * 1000;

        console.log(
          [
            `[auto-sync crosscheck] pair ${index + 1}`,
            `  reference : ${pair.refPath}`,
            `  camera    : ${pair.cameraPath}`,
            `  TS        : syncTime ${result.syncTime.toFixed(3)} s  score ${result.score.toFixed(3)}  valid ${result.valid}`,
            `  Python    : syncTime ${pair.expected.toFixed(3)} s`,
            `  delta     : ${deltaMs.toFixed(1)} ms`,
          ].join("\n"),
        );

        expect(
          result.valid,
          `score ${result.score.toFixed(3)} did not pass the match threshold — wrong pair?`,
        ).toBe(true);
        expect(
          Math.abs(deltaMs),
          `TS vs Python delta ${deltaMs.toFixed(1)} ms exceeds 10 ms`,
        ).toBeLessThanOrEqual(10);
      },
      600_000,
    );
  });
});
