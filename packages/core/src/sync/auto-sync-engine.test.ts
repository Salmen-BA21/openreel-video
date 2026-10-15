import { describe, expect, it } from "vitest";
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_MIN_SAMPLES,
  AUTO_SYNC_SCORE_THRESHOLD,
  AutoSyncInputError,
  computeAutoSync,
  computeEnvelope,
  downmixToMono,
  resampleToAnalysisRate,
} from "./auto-sync-engine";

/**
 * Synthetic lag-recovery suite — port of filmora-auto-sync/test_synthetic.py
 * (6 cases, no media required). Noise uses a seeded local PRNG instead of
 * numpy's default_rng, but signal structure, offsets, and tolerances match
 * the Python reference exactly.
 */

const SR = AUTO_SYNC_ANALYSIS_SAMPLE_RATE;

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussians(
  random: () => number,
  count: number,
  sigma: number,
): Float64Array {
  const out = new Float64Array(count);
  for (let index = 0; index < count; index += 2) {
    // Box-Muller
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    out[index] = radius * Math.cos(angle) * sigma;
    if (index + 1 < count) {
      out[index + 1] = radius * Math.sin(angle) * sigma;
    }
  }
  return out;
}

function makeMusicLike(random: () => number, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const beatNoise = makeGaussians(random, n, 0.3);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const base =
      0.2 * Math.sin(2 * Math.PI * 220 * t) +
      0.1 * Math.sin(2 * Math.PI * 330 * t);
    const beat = 0.5 * (1 + Math.sin(2 * Math.PI * 2 * t));
    out[i] = base + beat * (beatNoise[i] ?? 0);
  }
  // ~4 transients per second — 80-sample bursts (mirror of the Python helper)
  const transientCount = Math.floor(seconds * 4);
  for (let k = 0; k < transientCount; k++) {
    const at = random() * (seconds - 0.01);
    const start = Math.floor(at * SR);
    const burst = makeGaussians(random, Math.min(80, n - start), 1.0);
    for (let j = 0; j < burst.length && start + j < n; j++) {
      out[start + j] = (out[start + j] ?? 0) + (burst[j] ?? 0);
    }
  }
  return out;
}

function scaled(
  signal: Float32Array,
  gain: number,
  random: () => number,
  noiseSigma: number,
): Float32Array {
  const noise = makeGaussians(random, signal.length, noiseSigma);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    out[i] = (signal[i] ?? 0) * gain + (noise[i] ?? 0);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function slice(signal: Float32Array, from: number, to: number): Float32Array {
  return signal.slice(from, to);
}

function runCase(
  name: string,
  reference: Float32Array,
  target: Float32Array,
  expected: number,
  tolerance = 0.01,
): void {
  const result = computeAutoSync(reference, target);
  const error = Math.abs(result.syncTime - expected);
  expect(
    error,
    `${name}: expect ${expected}s got ${result.syncTime}s err ${error * 1000}ms score ${result.score} valid ${result.valid}`,
  ).toBeLessThanOrEqual(tolerance);
  expect(result.valid, `${name}: expected valid match`).toBe(true);
}

describe("auto-sync engine", () => {
  it("recovers a negative offset when the video has a noise head", () => {
    const random = mulberry32(42);
    const reference = makeMusicLike(random, 20.0);
    const head = Float32Array.from(
      makeGaussians(random, Math.floor(2.5 * SR), 0.02),
    );
    const body = scaled(reference, 0.35, random, 0.02);
    runCase("video-head-noise", reference, concat(head, body), -2.5);
  });

  it("reports zero offset for aligned inputs", () => {
    const random = mulberry32(42);
    const reference = makeMusicLike(random, 20.0);
    const target = scaled(reference, 0.5, random, 0.02);
    runCase("aligned", reference, target, 0.0);
  });

  it("recovers a positive offset when the video started late", () => {
    const random = mulberry32(42);
    const reference = makeMusicLike(random, 20.0);
    const cut = Math.floor(1.7 * SR);
    const body = scaled(slice(reference, cut, reference.length), 0.4, random, 0.02);
    const tail = Float32Array.from(makeGaussians(random, 4000, 0.02));
    runCase("video-started-late", reference, concat(body, tail), 1.7);
  });

  it("rejects inputs shorter than one second", () => {
    const random = mulberry32(42);
    const reference = makeMusicLike(random, 20.0);
    const tooShort = new Float32Array(AUTO_SYNC_MIN_SAMPLES - 1).fill(0.1);
    expect(() => computeAutoSync(tooShort, reference)).toThrow(
      AutoSyncInputError,
    );
    expect(() => computeAutoSync(reference, tooShort)).toThrow(
      AutoSyncInputError,
    );
  });

  it("finds a short target deep inside a long reference", () => {
    const random = mulberry32(42);
    const longReference = makeMusicLike(random, 60.0);
    const clip = slice(
      longReference,
      Math.floor(40 * SR),
      Math.floor(50 * SR),
    );
    const target = scaled(clip, 0.5, random, 0.02);
    runCase(
      "short-tgt-deep-in-long-ref",
      longReference,
      target,
      40.0,
      0.02,
    );
  });

  it("finds a short reference inside a long target", () => {
    const random = mulberry32(42);
    const longReference = makeMusicLike(random, 60.0);
    const clip = slice(
      longReference,
      Math.floor(10 * SR),
      Math.floor(20 * SR),
    );
    const preRoll = Float32Array.from(
      makeGaussians(random, Math.floor(10 * SR), 0.02),
    );
    const body = scaled(clip, 0.5, random, 0.02);
    const postRoll = Float32Array.from(
      makeGaussians(random, Math.floor(30 * SR), 0.02),
    );
    runCase(
      "long-tgt-contains-short-ref",
      clip,
      concat(preRoll, body, postRoll),
      -10.0,
      0.02,
    );
  });

  it("produces an envelope of length floor(frames / 16)", () => {
    const random = mulberry32(7);
    const signal = makeMusicLike(random, 3.0);
    const envelope = computeEnvelope(signal);
    expect(envelope.length).toBe(signal.length >> 4);
  });

  it("throws on empty channel lists and short audio", () => {
    expect(() => downmixToMono([])).toThrow(AutoSyncInputError);
    const short = new Float32Array(AUTO_SYNC_MIN_SAMPLES - 1);
    expect(() => computeEnvelope(short)).toThrow(AutoSyncInputError);
  });

  it("passes audio through untouched at the analysis rate", () => {
    const signal = new Float32Array(32000).fill(0.5);
    expect(resampleToAnalysisRate(signal, SR)).toBe(signal);
    // 48000 samples @ 48 kHz = 1 s → 16000 samples @ 16 kHz
    const resampled = resampleToAnalysisRate(
      new Float32Array(48000).fill(0.5),
      48000,
    );
    expect(resampled.length).toBe(16000);
  });

  it("exposes the Filmora score threshold", () => {
    expect(AUTO_SYNC_SCORE_THRESHOLD).toBe(0.32);
    expect(SR).toBe(16000);
  });
});
