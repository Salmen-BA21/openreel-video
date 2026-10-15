import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAutoSyncBridge,
  disposeAutoSyncBridge,
} from "./auto-sync-bridge";
import { loadAudioBuffer } from "../utils/load-audio-buffer";
import { useProjectStore } from "../stores/project-store";

vi.mock("../utils/load-audio-buffer", () => ({
  loadAudioBuffer: vi.fn(),
}));

vi.mock("../stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(),
  },
}));

const SR = 16000;

/** Deterministic 32-bit PRNG (mulberry32) — mirrors the core engine tests. */
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

/**
 * Structured signal with beats and transients — mirrors the core/Python
 * synthetic tests. (Plain white noise makes the envelope nearly constant,
 * which the correlation cannot localize.)
 */
function makeMusicLike(random: () => number, seconds: number): Float32Array {
  const count = Math.floor(seconds * SR);
  const out = new Float32Array(count);
  const beatNoise = makeGaussians(random, count, 0.3);
  for (let i = 0; i < count; i++) {
    const t = i / SR;
    const base =
      0.2 * Math.sin(2 * Math.PI * 220 * t) +
      0.1 * Math.sin(2 * Math.PI * 330 * t);
    const beat = 0.5 * (1 + Math.sin(2 * Math.PI * 2 * t));
    out[i] = base + beat * (beatNoise[i] ?? 0);
  }
  const transientCount = Math.floor(seconds * 4);
  for (let k = 0; k < transientCount; k++) {
    const at = random() * (seconds - 0.01);
    const start = Math.floor(at * SR);
    const burst = makeGaussians(random, Math.min(80, count - start), 1.0);
    for (let j = 0; j < burst.length && start + j < count; j++) {
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

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function makeAudioBuffer(
  channels: Float32Array[],
  sampleRate = SR,
): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (index: number) => channels[index],
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

/** AudioContext whose native decode always fails (forces the extraction path). */
class RejectingAudioContext {
  sampleRate = 48000;
  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.reject(new Error("unsupported format"));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

interface FakeClip {
  id: string;
  mediaId: string;
  trackId: string;
  startTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  speed: number;
  reversed?: boolean;
  audioTrackIndex?: number;
}

interface FakeStore {
  project: {
    timeline: {
      tracks: Array<{
        id: string;
        name: string;
        type: string;
        locked: boolean;
        clips: FakeClip[];
      }>;
    };
  };
  getClip: (id: string) => FakeClip | undefined;
  getMediaItem: (
    id: string,
  ) => { id: string; type: string; name: string; blob: Blob } | undefined;
  beginHistoryGroup: ReturnType<typeof vi.fn>;
  endHistoryGroup: ReturnType<typeof vi.fn>;
  moveClip: ReturnType<typeof vi.fn>;
  trimClip: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
}

const targetBlob = new Blob([new Uint8Array([1])], { type: "video/mp4" });
const referenceBlob = new Blob([new Uint8Array([2])], { type: "audio/wav" });

// 2 s music-like reference content.
const referenceSignal = makeMusicLike(mulberry32(11), 2.0);
// 0.5 s quiet head + reference content → target starts 0.5 s BEFORE the reference.
const headNoiseTarget = concat(
  Float32Array.from(makeGaussians(mulberry32(22), 8000, 0.02)),
  scaled(referenceSignal, 0.5, mulberry32(33), 0.02),
);
// Missing the first 0.5 s of the reference → target starts 0.5 s AFTER it.
const lateTarget = scaled(
  referenceSignal.slice(8000),
  0.5,
  mulberry32(44),
  0.02,
);
// A clip with no audio content → no match.
const silentTarget = new Float32Array(40000);

let currentTargetBuffer: AudioBuffer = makeAudioBuffer([headNoiseTarget]);
let currentReferenceBuffer: AudioBuffer = makeAudioBuffer([referenceSignal]);

function buildStore(): FakeStore {
  const targetClip: FakeClip = {
    id: "target-clip",
    mediaId: "video-1",
    trackId: "track-video",
    startTime: 10,
    duration: 2.5,
    inPoint: 0,
    outPoint: 2.5,
    speed: 1,
  };
  const referenceClip: FakeClip = {
    id: "reference-clip",
    mediaId: "audio-1",
    trackId: "track-audio",
    startTime: 3,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
  };
  const secondAudioClip: FakeClip = {
    id: "second-audio",
    mediaId: "audio-2",
    trackId: "track-audio",
    startTime: 20,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
  };
  const spedUpClip: FakeClip = {
    id: "sped-up",
    mediaId: "audio-3",
    trackId: "track-audio",
    startTime: 40,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    speed: 2,
  };

  const mediaItems: Record<
    string,
    { id: string; type: string; name: string; blob: Blob }
  > = {
    "video-1": {
      id: "video-1",
      type: "video",
      name: "Camera.mp4",
      blob: targetBlob,
    },
    "audio-1": {
      id: "audio-1",
      type: "audio",
      name: "Song.wav",
      blob: referenceBlob,
    },
    "audio-2": {
      id: "audio-2",
      type: "audio",
      name: "Voice.mp3",
      blob: referenceBlob,
    },
    "audio-3": {
      id: "audio-3",
      type: "audio",
      name: "Loop.mp3",
      blob: referenceBlob,
    },
  };

  const clips = [targetClip, referenceClip, secondAudioClip, spedUpClip];

  return {
    project: {
      timeline: {
        tracks: [
          {
            id: "track-video",
            name: "Video 1",
            type: "video",
            locked: false,
            clips: [targetClip],
          },
          {
            id: "track-audio",
            name: "Audio 1",
            type: "audio",
            locked: false,
            clips: [referenceClip, secondAudioClip, spedUpClip],
          },
        ],
      },
    },
    getClip: (id) => clips.find((clip) => clip.id === id),
    getMediaItem: (id) => mediaItems[id],
    beginHistoryGroup: vi.fn(),
    endHistoryGroup: vi.fn(),
    moveClip: vi.fn().mockResolvedValue({ success: true }),
    trimClip: vi.fn().mockResolvedValue({ success: true }),
    undo: vi.fn().mockResolvedValue(undefined),
  };
}

let store: FakeStore;

async function analyzeTimelineReference(
  targetBuffer?: AudioBuffer,
): Promise<boolean> {
  if (targetBuffer) currentTargetBuffer = targetBuffer;
  const bridge = getAutoSyncBridge();
  bridge.setReferenceMode("timeline");
  bridge.setReferenceClipId("reference-clip");
  return bridge.analyze("target-clip");
}

describe("auto-sync-bridge", () => {
  let previousAudioContext: typeof AudioContext;

  beforeEach(() => {
    // setup.ts defines AudioContext as writable-but-not-configurable, so
    // assign directly: native decode must fail to force the extraction path.
    previousAudioContext = window.AudioContext;
    window.AudioContext =
      RejectingAudioContext as unknown as typeof AudioContext;
    store = buildStore();
    vi.mocked(useProjectStore.getState).mockReturnValue(
      store as unknown as ReturnType<typeof useProjectStore.getState>,
    );
    vi.mocked(loadAudioBuffer).mockImplementation((_ctx, blob) => {
      if (blob === targetBlob) return Promise.resolve(currentTargetBuffer);
      if (blob === referenceBlob)
        return Promise.resolve(currentReferenceBuffer);
      return Promise.resolve(null);
    });
    currentTargetBuffer = makeAudioBuffer([headNoiseTarget]);
    currentReferenceBuffer = makeAudioBuffer([referenceSignal]);
  });

  afterEach(() => {
    disposeAutoSyncBridge();
    window.AudioContext = previousAudioContext;
    vi.clearAllMocks();
  });

  describe("getReferenceOptions", () => {
    it("lists audio clips except the target and non-default-speed clips", () => {
      const bridge = getAutoSyncBridge();
      const options = bridge.getReferenceOptions("target-clip");
      expect(options.map((option) => option.clipId).sort()).toEqual([
        "reference-clip",
        "second-audio",
      ]);
      expect(options[0]).toMatchObject({
        name: "Song.wav",
        trackName: "Audio 1",
      });
    });
  });

  describe("analyze", () => {
    it("refuses to run without a reference selection", async () => {
      const bridge = getAutoSyncBridge();
      const ok = await bridge.analyze("target-clip");
      expect(ok).toBe(false);
      expect(bridge.getState().error).toMatch(/reference/i);
      expect(loadAudioBuffer).not.toHaveBeenCalled();
    });

    it("recovers a negative offset (target head precedes the reference)", async () => {
      const ok = await analyzeTimelineReference();
      expect(ok).toBe(true);
      const result = getAutoSyncBridge().getState().result;
      expect(result).not.toBeNull();
      expect(result?.valid).toBe(true);
      expect(result?.syncTime).toBeGreaterThan(-0.52);
      expect(result?.syncTime).toBeLessThan(-0.48);
    });

    it("recovers a positive offset (target missing the reference head)", async () => {
      const targetClip = store.getClip("target-clip")!;
      targetClip.duration = 1.5;
      targetClip.outPoint = 1.5;
      const ok = await analyzeTimelineReference(makeAudioBuffer([lateTarget]));
      expect(ok).toBe(true);
      const result = getAutoSyncBridge().getState().result;
      expect(result?.valid).toBe(true);
      expect(result?.syncTime).toBeGreaterThan(0.48);
      expect(result?.syncTime).toBeLessThan(0.52);
    });

    it("reports a weak match for a clip without audio content", async () => {
      const ok = await analyzeTimelineReference(
        makeAudioBuffer([silentTarget]),
      );
      expect(ok).toBe(true);
      const state = getAutoSyncBridge().getState();
      expect(state.result?.valid).toBe(false);
      expect(state.error).toMatch(/weak match/i);
    });

    it("rejects clips with non-default speed", async () => {
      store.getClip("target-clip")!.speed = 2;
      const ok = await analyzeTimelineReference();
      expect(ok).toBe(false);
      expect(getAutoSyncBridge().getState().error).toMatch(/speed/i);
      expect(loadAudioBuffer).not.toHaveBeenCalled();
    });

    it("clears the result when the reference source changes", async () => {
      await analyzeTimelineReference();
      expect(getAutoSyncBridge().getState().result).not.toBeNull();
      getAutoSyncBridge().setReferenceClipId("second-audio");
      expect(getAutoSyncBridge().getState().result).toBeNull();
    });
  });

  describe("apply", () => {
    it("trims the head for a negative offset and moves to the reference start", async () => {
      await analyzeTimelineReference();
      const ok = await getAutoSyncBridge().apply("target-clip");
      expect(ok).toBe(true);

      expect(store.beginHistoryGroup).toHaveBeenCalledWith(
        "Auto sync to reference",
      );
      expect(store.endHistoryGroup).toHaveBeenCalledTimes(1);

      expect(store.trimClip).toHaveBeenCalledTimes(1);
      const [trimmedClipId, inPoint, outPoint] = store.trimClip.mock.calls[0];
      expect(trimmedClipId).toBe("target-clip");
      expect(inPoint).toBeGreaterThan(0.47);
      expect(inPoint).toBeLessThan(0.53);
      expect(outPoint).toBeCloseTo(2.5, 5);

      expect(store.moveClip).toHaveBeenCalledTimes(1);
      const [movedClipId, startTime] = store.moveClip.mock.calls[0];
      expect(movedClipId).toBe("target-clip");
      expect(startTime).toBeCloseTo(3, 2);

      const state = getAutoSyncBridge().getState();
      expect(state.applied).toBe(true);
      expect(state.result).toBeNull();
    });

    it("delays the clip for a positive offset without trimming", async () => {
      const targetClip = store.getClip("target-clip")!;
      targetClip.duration = 1.5;
      targetClip.outPoint = 1.5;
      await analyzeTimelineReference(makeAudioBuffer([lateTarget]));

      const ok = await getAutoSyncBridge().apply("target-clip");
      expect(ok).toBe(true);
      expect(store.trimClip).not.toHaveBeenCalled();
      expect(store.moveClip).toHaveBeenCalledTimes(1);
      const [movedClipId, startTime] = store.moveClip.mock.calls[0];
      expect(movedClipId).toBe("target-clip");
      expect(startTime).toBeCloseTo(3.5, 2);
    });

    it("uses the clip's own position as the anchor for file references", async () => {
      const bridge = getAutoSyncBridge();
      bridge.setReferenceMode("file");
      bridge.setReferenceFile(
        new File([new Uint8Array([9])], "reference.wav", {
          type: "audio/wav",
        }),
      );
      vi.mocked(loadAudioBuffer).mockImplementation((_ctx, blob) =>
        Promise.resolve(
          blob instanceof File ? currentReferenceBuffer : currentTargetBuffer,
        ),
      );

      const ok = await bridge.analyze("target-clip");
      expect(ok).toBe(true);
      expect(bridge.getState().result?.valid).toBe(true);

      const applied = await bridge.apply("target-clip");
      expect(applied).toBe(true);
      // Negative offset in file mode: trim head, keep the clip in place.
      expect(store.trimClip).toHaveBeenCalledTimes(1);
      expect(store.moveClip).not.toHaveBeenCalled();
      expect(store.beginHistoryGroup).toHaveBeenCalledTimes(1);
      expect(store.endHistoryGroup).toHaveBeenCalledTimes(1);
    });

    it("refuses to apply a weak match", async () => {
      await analyzeTimelineReference(makeAudioBuffer([silentTarget]));
      const ok = await getAutoSyncBridge().apply("target-clip");
      expect(ok).toBe(false);
      expect(store.trimClip).not.toHaveBeenCalled();
      expect(store.moveClip).not.toHaveBeenCalled();
      expect(store.beginHistoryGroup).not.toHaveBeenCalled();
    });

    it("refuses to apply when the timeline changed after analysis", async () => {
      await analyzeTimelineReference();
      store.getClip("reference-clip")!.inPoint = 0.1;
      const ok = await getAutoSyncBridge().apply("target-clip");
      expect(ok).toBe(false);
      expect(getAutoSyncBridge().getState().error).toMatch(/analyze again/i);
      expect(store.trimClip).not.toHaveBeenCalled();
      expect(store.moveClip).not.toHaveBeenCalled();
    });

    it("undoes partial work when a store operation fails", async () => {
      await analyzeTimelineReference();
      store.moveClip.mockResolvedValue({
        success: false,
        error: { message: "track locked" },
      });
      const ok = await getAutoSyncBridge().apply("target-clip");
      expect(ok).toBe(false);
      expect(store.trimClip).toHaveBeenCalledTimes(1);
      expect(store.endHistoryGroup).toHaveBeenCalledTimes(1);
      expect(store.undo).toHaveBeenCalledTimes(1);
      expect(getAutoSyncBridge().getState().error).toMatch(/track locked/);
    });
  });

  describe("syncPair (toolbar one-click flow)", () => {
    it("forces timeline mode, analyzes, and applies in one call", async () => {
      const bridge = getAutoSyncBridge();
      bridge.setReferenceMode("file");
      bridge.setReferenceFile(
        new File([new Uint8Array([9])], "old-reference.wav", {
          type: "audio/wav",
        }),
      );

      const outcome = await bridge.syncPair("target-clip", "reference-clip");
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.valid).toBe(true);
      expect(outcome.result?.syncTime).toBeGreaterThan(-0.52);
      expect(outcome.result?.syncTime).toBeLessThan(-0.48);

      const state = bridge.getState();
      expect(state.referenceMode).toBe("timeline");
      expect(state.referenceClipId).toBe("reference-clip");
      expect(state.referenceFile).toBeNull();
      expect(state.applied).toBe(true);
      expect(state.result).toBeNull();
      expect(state.error).toBeNull();

      expect(store.beginHistoryGroup).toHaveBeenCalledWith(
        "Auto sync to reference",
      );
      expect(store.trimClip).toHaveBeenCalledTimes(1);
      expect(store.moveClip).toHaveBeenCalledTimes(1);
    });

    it("refuses to apply a weak match", async () => {
      currentTargetBuffer = makeAudioBuffer([silentTarget]);
      const outcome = await getAutoSyncBridge().syncPair(
        "target-clip",
        "reference-clip",
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.result?.valid).toBe(false);
      expect(store.beginHistoryGroup).not.toHaveBeenCalled();
      expect(store.trimClip).not.toHaveBeenCalled();
      expect(store.moveClip).not.toHaveBeenCalled();
    });

    it("rejects syncing a clip with itself", async () => {
      const outcome = await getAutoSyncBridge().syncPair(
        "target-clip",
        "target-clip",
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/different clips/i);
      expect(loadAudioBuffer).not.toHaveBeenCalled();
    });
  });
});
