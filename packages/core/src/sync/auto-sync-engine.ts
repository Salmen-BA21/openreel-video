import { FFT, getFFT } from "../audio/fft";

/**
 * Auto audio synchronization — envelope cross-correlation between a clean
 * reference track (wav/mp3) and a camera recording whose audio contains the
 * same content (speaker bleed / room mic).
 *
 * TypeScript port of Filmora 15's `magic_xe_audio_synchronization_v4.dll`
 * pipeline (recovered via static Ghidra analysis), with the documented
 * overlap-guard deviation. See apps/web/docs/auto-sync.md for semantics.
 *
 * Pipeline: 16 kHz mono → analytic-signal envelope → 35 Hz IIR low-pass →
 * decimate to 1 kHz → z-score → normalized cross-correlation → argmax with
 * an 80 % minimum-overlap guard → `{ syncTime, score, valid }`.
 */

/** Analysis rate (Filmora `SetInput` resamples both inputs to 16 kHz). */
export const AUTO_SYNC_ANALYSIS_SAMPLE_RATE = 16000;

/** Envelope window cap in samples — 62.5 s at 16 kHz (Filmora `GetEnvelope`). */
export const AUTO_SYNC_ENVELOPE_CAP = 1_000_000;

/** Both inputs must be at least 1 s of analysis audio (Filmora `ResultGet`). */
export const AUTO_SYNC_MIN_SAMPLES = AUTO_SYNC_ANALYSIS_SAMPLE_RATE;

/** Raw score threshold for a confident match (Filmora `ResultGet`, strict >). */
export const AUTO_SYNC_SCORE_THRESHOLD = 0.32;

/** Lags covering less than this fraction of the shorter stream are discarded. */
export const AUTO_SYNC_MIN_OVERLAP_FRACTION = 0.8;

/**
 * IIR low-pass on the analytic envelope — butter2-ish, fc ≈ 35 Hz @ 16 kHz,
 * coefficients lifted from the binary's kernel constants.
 */
const IIR_B0 = 9.50600294e-05;
const IIR_B: readonly [number, number, number] = [IIR_B0, 2 * IIR_B0, IIR_B0];
const IIR_A: readonly [number, number, number] = [1.0, -1.97223373, 0.97261397];

/** Envelope decimation stride: 16 samples at 16 kHz → 1 kHz envelope. */
const ENVELOPE_STRIDE = 16;

export interface AutoSyncAudioInput {
  /** One entry per channel (AudioBuffer.getChannelData). */
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}

export interface AutoSyncResult {
  /**
   * Where the TARGET starts on the REFERENCE timeline, in seconds.
   * Positive → delay the target; negative → trim that many seconds from the
   * target's head. Only meaningful when `valid` is true.
   */
  readonly syncTime: number;
  /** Raw normalized-xcorr value at the peak — NOT a [0,1] correlation. */
  readonly score: number;
  /** `score > AUTO_SYNC_SCORE_THRESHOLD` (0.32). */
  readonly valid: boolean;
  readonly refEnvelopeLength: number;
  readonly tgtEnvelopeLength: number;
}

export class AutoSyncInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoSyncInputError";
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/**
 * Downmix channels by summing (the binary sums L+R after stereo resample;
 * sum and resample commute for linear resamplers, and the absolute scale is
 * irrelevant after z-scoring).
 */
export function downmixToMono(
  channels: readonly Float32Array[],
): Float32Array {
  if (channels.length === 0) {
    throw new AutoSyncInputError("no audio channels to analyze");
  }
  if (channels.length === 1) return channels[0] ?? new Float32Array(0);
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) {
    const count = Math.min(length, channel.length);
    for (let index = 0; index < count; index++) {
      out[index] = (out[index] ?? 0) + (channel[index] ?? 0);
    }
  }
  return out;
}

/**
 * Linear-interpolation resample to the analysis rate. The reference resampler
 * (PyAV polyphase) differs, but envelope z-scoring plus the 35 Hz low-pass
 * make kernel differences irrelevant (documented deviation in SPEC).
 */
export function resampleToAnalysisRate(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  if (sampleRate === AUTO_SYNC_ANALYSIS_SAMPLE_RATE) return samples;
  if (sampleRate <= 0 || samples.length === 0) {
    throw new AutoSyncInputError("invalid audio for resampling");
  }
  const ratio = sampleRate / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    if (left >= samples.length) break;
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    out[index] =
      (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exact-length DFT (Bluestein / chirp-z on top of the power-of-two FFT)
// ---------------------------------------------------------------------------

interface BluesteinPlan {
  readonly size: number;
  readonly convSize: number;
  readonly chirpReal: Float32Array;
  readonly chirpImag: Float32Array;
  readonly kernelReal: Float32Array;
  readonly kernelImag: Float32Array;
  readonly fft: FFT;
}

let bluesteinPlan: BluesteinPlan | null = null;

function getBluesteinPlan(size: number): BluesteinPlan {
  if (bluesteinPlan && bluesteinPlan.size === size) return bluesteinPlan;
  const convSize = nextPowerOfTwo(2 * size - 1);
  const fft = getFFT(convSize);
  const chirpReal = new Float32Array(size);
  const chirpImag = new Float32Array(size);
  const period = 2 * size;
  for (let t = 0; t < size; t++) {
    // exp(-i·π·t²/size), angle reduced mod 2π via (t² mod 2·size)
    const angle = (Math.PI * ((t * t) % period)) / size;
    chirpReal[t] = Math.cos(angle);
    chirpImag[t] = -Math.sin(angle);
  }
  const kernelReal = new Float32Array(convSize);
  const kernelImag = new Float32Array(convSize);
  for (let t = 0; t < size; t++) {
    // b[t] = conj(chirp[t]); mirrored to index convSize − t for negative lags
    kernelReal[t] = chirpReal[t];
    kernelImag[t] = -chirpImag[t];
    if (t > 0) {
      kernelReal[convSize - t] = chirpReal[t];
      kernelImag[convSize - t] = -chirpImag[t];
    }
  }
  const spectrum = fft.forwardComplex(kernelReal, kernelImag);
  bluesteinPlan = {
    size,
    convSize,
    chirpReal,
    chirpImag,
    kernelReal: spectrum.real,
    kernelImag: spectrum.imag,
    fft,
  };
  return bluesteinPlan;
}

/**
 * Exact `size`-point DFT of complex input — matches numpy `np.fft.fft`
 * (forward sign convention) for arbitrary lengths, not just powers of two.
 */
function exactFft(
  xReal: Float32Array,
  xImag: Float32Array,
  plan: BluesteinPlan,
): { real: Float32Array; imag: Float32Array } {
  const { size, convSize, chirpReal, chirpImag, fft } = plan;
  const aReal = new Float32Array(convSize);
  const aImag = new Float32Array(convSize);
  for (let index = 0; index < size; index++) {
    const xr = xReal[index] ?? 0;
    const xi = xImag[index] ?? 0;
    const cr = chirpReal[index] ?? 0;
    const ci = chirpImag[index] ?? 0;
    aReal[index] = xr * cr - xi * ci;
    aImag[index] = xr * ci + xi * cr;
  }
  const fa = fft.forwardComplex(aReal, aImag);
  const productReal = new Float32Array(convSize);
  const productImag = new Float32Array(convSize);
  for (let index = 0; index < convSize; index++) {
    const ar = fa.real[index] ?? 0;
    const ai = fa.imag[index] ?? 0;
    const br = plan.kernelReal[index] ?? 0;
    const bi = plan.kernelImag[index] ?? 0;
    productReal[index] = ar * br - ai * bi;
    productImag[index] = ar * bi + ai * br;
  }
  const conv = fft.inverseComplex(productReal, productImag);
  const outReal = new Float32Array(size);
  const outImag = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    const cr = conv.real[index] ?? 0;
    const ci = conv.imag[index] ?? 0;
    const wr = chirpReal[index] ?? 0;
    const wi = chirpImag[index] ?? 0;
    outReal[index] = cr * wr - ci * wi;
    outImag[index] = cr * wi + ci * wr;
  }
  return { real: outReal, imag: outImag };
}

/** Exact inverse DFT: `conj(fwd(conj(x))) / size` (numpy `ifft`). */
function exactIfft(
  xReal: Float32Array,
  xImag: Float32Array,
  plan: BluesteinPlan,
): { real: Float32Array; imag: Float32Array } {
  const conjImag = new Float32Array(xImag.length);
  for (let index = 0; index < xImag.length; index++) {
    conjImag[index] = -(xImag[index] ?? 0);
  }
  const y = exactFft(xReal, conjImag, plan);
  const outReal = new Float32Array(y.real.length);
  const outImag = new Float32Array(y.real.length);
  const scale = 1 / plan.size;
  for (let index = 0; index < y.real.length; index++) {
    outReal[index] = (y.real[index] ?? 0) * scale;
    outImag[index] = -(y.imag[index] ?? 0) * scale;
  }
  return { real: outReal, imag: outImag };
}

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

/**
 * |ifft(fft(x) with bins 1..floor(N/2) doubled)| / N — analytic-signal
 * amplitude envelope (binary `GetEnvelope` FFT path). Uses the exact-length
 * DFT so the port matches the numpy reference for arbitrary input lengths.
 */
function analyticMagnitude(x: Float32Array): Float32Array {
  const size = x.length;
  const plan = getBluesteinPlan(size);
  const zeroImag = new Float32Array(size);
  const spectrum = exactFft(x, zeroImag, plan);
  const half = size >> 1;
  for (let bin = 1; bin <= half; bin++) {
    spectrum.real[bin] = (spectrum.real[bin] ?? 0) * 2;
    spectrum.imag[bin] = (spectrum.imag[bin] ?? 0) * 2;
  }
  const analytic = exactIfft(spectrum.real, spectrum.imag, plan);
  const magnitude = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    magnitude[index] =
      Math.hypot(analytic.real[index] ?? 0, analytic.imag[index] ?? 0) / size;
  }
  return magnitude;
}

/**
 * Second-order IIR low-pass over the analytic envelope with carried state
 * (scipy `lfilter` direct-form II transposed, a[0] = 1).
 */
function lfilterBiquad(
  x: Float32Array,
  zi: Float64Array,
): { y: Float64Array; zf: Float64Array } {
  const y = new Float64Array(x.length);
  let z0 = zi[0] ?? 0;
  let z1 = zi[1] ?? 0;
  for (let index = 0; index < x.length; index++) {
    const xi = x[index] ?? 0;
    const yi = IIR_B[0] * xi + z0;
    z0 = IIR_B[1] * xi - IIR_A[1] * yi + z1;
    z1 = IIR_B[2] * xi - IIR_A[2] * yi;
    y[index] = yi;
  }
  return { y, zf: Float64Array.of(z0, z1) };
}

/**
 * Full-rate filtered envelope stream (pre-decimation). Single window up to
 * `AUTO_SYNC_ENVELOPE_CAP` samples; longer inputs use 50 % overlap windows
 * with q1/q2 seam cropping and IIR state carried across windows.
 */
function envelopeStream(x: Float32Array): Float64Array {
  const frames = x.length;
  const windowLength = Math.min(frames, AUTO_SYNC_ENVELOPE_CAP);
  if (frames <= windowLength) {
    return lfilterBiquad(analyticMagnitude(x), Float64Array.of(0, 0)).y;
  }

  const hop = windowLength >> 1;
  const half = (windowLength + 1) >> 1;
  const q1 = half >> 1;
  const q2 = (half + 1) >> 1;
  const windowCount = ((frames - 1) / hop) | 0;
  const segment = new Float32Array(windowLength);
  const chunks: Float64Array[] = [];
  let state: Float64Array = Float64Array.of(0, 0);

  for (let window = 0; window < windowCount; window++) {
    const start = window * hop;
    const segmentLength = Math.min(windowLength, frames - start);
    segment.fill(0);
    segment.set(x.subarray(start, start + segmentLength));
    const mags = analyticMagnitude(segment);
    const from = window === 0 ? 0 : q1;
    const to = window !== windowCount - 1 ? windowLength - q2 : segmentLength;
    if (to > from) {
      const filtered = lfilterBiquad(mags.subarray(from, to), state);
      state = filtered.zf;
      chunks.push(filtered.y);
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float64Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 1 kHz envelope with length `floor(frames / 16)`
 * (`AsyncEnvelopeResampledNorm`: decimate by 16, pad/trim to frames >> 4).
 */
export function computeEnvelope(x: Float32Array): Float64Array {
  if (x.length < AUTO_SYNC_MIN_SAMPLES) {
    throw new AutoSyncInputError(
      `audio shorter than ${AUTO_SYNC_MIN_SAMPLES} samples (${AUTO_SYNC_MIN_SAMPLES / AUTO_SYNC_ANALYSIS_SAMPLE_RATE}s)`,
    );
  }
  const stream = envelopeStream(x);
  const want = x.length >> 4;
  const env = new Float64Array(want);
  const available = Math.min(want, Math.ceil(stream.length / ENVELOPE_STRIDE));
  for (let index = 0; index < available; index++) {
    env[index] = stream[index * ENVELOPE_STRIDE] ?? 0;
  }
  return env;
}

/** Population z-score — (x − mean) / population std (binary `FUN_180007dd0`). */
export function zscore(x: Float64Array): Float64Array {
  const length = x.length;
  if (length === 0) return x;
  let sum = 0;
  for (let index = 0; index < length; index++) sum += x[index] ?? 0;
  const mean = sum / length;
  let variance = 0;
  for (let index = 0; index < length; index++) {
    const centered = (x[index] ?? 0) - mean;
    variance += centered * centered;
  }
  const sigma = Math.sqrt(variance / length);
  const out = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    out[index] = ((x[index] ?? 0) - mean) / (sigma > 0 ? sigma : 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/** Sliding window sums of `a` over `win` samples — output length `len+win-1`. */
function slidingSum(a: Float64Array, win: number): Float64Array {
  const cumulative = new Float64Array(a.length + 1);
  for (let index = 0; index < a.length; index++) {
    cumulative[index + 1] = (cumulative[index] ?? 0) + (a[index] ?? 0);
  }
  const outLength = a.length + win - 1;
  const out = new Float64Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const hi = Math.min(index + 1, a.length);
    const lo = Math.max(index - win + 1, 0);
    out[index] = (cumulative[hi] ?? 0) - (cumulative[lo] ?? 0);
  }
  return out;
}

/**
 * Full-length linear convolution via zero-padded FFT — power-of-two padding
 * is mathematically exact for linear convolution (matches numpy
 * `fftconvolve` up to floating-point precision).
 */
function fftConvolveFull(a: Float64Array, b: Float64Array): Float64Array {
  const outLength = a.length + b.length - 1;
  if (outLength <= 0) return new Float64Array(0);
  const size = nextPowerOfTwo(outLength);
  const aReal = new Float32Array(size);
  const bReal = new Float32Array(size);
  for (let index = 0; index < a.length; index++) {
    aReal[index] = a[index] ?? 0;
  }
  for (let index = 0; index < b.length; index++) {
    bReal[index] = b[b.length - 1 - index] ?? 0;
  }
  const fft = getFFT(size);
  const fa = fft.forward(aReal);
  const fb = fft.forward(bReal);
  const productReal = new Float32Array(size);
  const productImag = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    const ar = fa.real[index] ?? 0;
    const ai = fa.imag[index] ?? 0;
    const br = fb.real[index] ?? 0;
    const bi = fb.imag[index] ?? 0;
    productReal[index] = ar * br - ai * bi;
    productImag[index] = ar * bi + ai * br;
  }
  const { real } = fft.inverseComplex(productReal, productImag);
  const out = new Float64Array(outLength);
  for (let index = 0; index < outLength; index++) {
    out[index] = real[index] ?? 0;
  }
  return out;
}

/**
 * Normalized envelope cross-correlation (binary `ResultGet`): full-lag search
 * with the overlap-guard deviation — lags covering < 80 % of the shorter
 * envelope are discarded before argmax (see SPEC "Overlap guard").
 *
 * `syncTime = (peak − T + 1) × 0.001` = target start on reference timeline.
 */
function correlateEnvelopes(
  envR: Float64Array,
  envT: Float64Array,
): AutoSyncResult {
  const r = envR.length;
  const t = envT.length;
  const numerator = fftConvolveFull(envR, envT);
  const sumR = slidingSum(envR, t);
  const squares = new Float64Array(r);
  for (let index = 0; index < r; index++) {
    const value = envR[index] ?? 0;
    squares[index] = value * value;
  }
  const sumRSquared = slidingSum(squares, t);

  const minOverlap = AUTO_SYNC_MIN_OVERLAP_FRACTION * Math.min(r, t);
  let peak = -1;
  let bestScore = -Infinity;

  for (let index = 0; index < numerator.length; index++) {
    const lag = index - t + 1;
    const overlap = Math.max(0, Math.min(t, r - lag) - Math.max(0, -lag));
    if (overlap < minOverlap) continue;
    const sum = sumR[index] ?? 0;
    const variance = (sumRSquared[index] ?? 0) - (sum * sum) / t;
    if (variance <= 0) continue;
    const score = (numerator[index] ?? 0) / Math.sqrt(variance);
    if (score > bestScore) {
      bestScore = score;
      peak = index;
    }
  }

  const valid = bestScore > AUTO_SYNC_SCORE_THRESHOLD;
  const syncTime =
    peak >= 0
      ? ((peak - t + 1) * ENVELOPE_STRIDE) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE
      : NaN;
  return {
    syncTime,
    score: bestScore,
    valid,
    refEnvelopeLength: r,
    tgtEnvelopeLength: t,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full auto-sync on already-16 kHz mono inputs (reference = clean track,
 * target = camera recording). Throws {@link AutoSyncInputError} when either
 * input is shorter than one second of analysis audio.
 */
export function computeAutoSync(
  reference16k: Float32Array,
  target16k: Float32Array,
): AutoSyncResult {
  if (
    reference16k.length < AUTO_SYNC_MIN_SAMPLES ||
    target16k.length < AUTO_SYNC_MIN_SAMPLES
  ) {
    throw new AutoSyncInputError(
      `both inputs need at least ${AUTO_SYNC_MIN_SAMPLES} samples at ${AUTO_SYNC_ANALYSIS_SAMPLE_RATE} Hz`,
    );
  }
  const envR = zscore(computeEnvelope(reference16k));
  const envT = zscore(computeEnvelope(target16k));
  return correlateEnvelopes(envR, envT);
}

export type AutoSyncProgressPhase =
  | "resample"
  | "reference-envelope"
  | "target-envelope"
  | "correlate"
  | "complete";

/**
 * Correlate two pre-computed, z-scored envelopes. Lets async callers (e.g. the
 * web bridge) yield to the UI between the heavy envelope phases while still
 * running the exact same correlation as {@link computeAutoSync}.
 */
export function correlateAutoSyncEnvelopes(
  referenceEnvelope: Float64Array,
  targetEnvelope: Float64Array,
): AutoSyncResult {
  return correlateEnvelopes(referenceEnvelope, targetEnvelope);
}

export type AutoSyncProgressCallback = (
  phase: AutoSyncProgressPhase,
  fraction: number,
) => void;

/**
 * Convenience entry point: downmix + resample both inputs to 16 kHz mono and
 * run the correlation. Suitable for decoded `AudioBuffer` channel data.
 */
export function autoSync(
  reference: AutoSyncAudioInput,
  target: AutoSyncAudioInput,
  onProgress?: AutoSyncProgressCallback,
): AutoSyncResult {
  onProgress?.("resample", 0);
  const ref16k = resampleToAnalysisRate(
    downmixToMono(reference.channels),
    reference.sampleRate,
  );
  const tgt16k = resampleToAnalysisRate(
    downmixToMono(target.channels),
    target.sampleRate,
  );
  onProgress?.("reference-envelope", 0.1);
  const envR = zscore(computeEnvelope(ref16k));
  onProgress?.("target-envelope", 0.5);
  const envT = zscore(computeEnvelope(tgt16k));
  onProgress?.("correlate", 0.9);
  const result = correlateEnvelopes(envR, envT);
  onProgress?.("complete", 1);
  return result;
}

/** Singleton engine wrapper mirroring the `BeatDetectionEngine` pattern. */
export class AutoSyncEngine {
  sync(
    reference: AutoSyncAudioInput,
    target: AutoSyncAudioInput,
    onProgress?: AutoSyncProgressCallback,
  ): AutoSyncResult {
    return autoSync(reference, target, onProgress);
  }

  syncMono16k(
    reference16k: Float32Array,
    target16k: Float32Array,
  ): AutoSyncResult {
    return computeAutoSync(reference16k, target16k);
  }
}

let engineInstance: AutoSyncEngine | null = null;

export function getAutoSyncEngine(): AutoSyncEngine {
  if (!engineInstance) engineInstance = new AutoSyncEngine();
  return engineInstance;
}
