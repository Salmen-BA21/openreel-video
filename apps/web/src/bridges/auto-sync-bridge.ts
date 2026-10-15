import {
  AUTO_SYNC_MIN_SAMPLES,
  AUTO_SYNC_SCORE_THRESHOLD,
  AutoSyncInputError,
  computeEnvelope,
  correlateAutoSyncEnvelopes,
  downmixToMono,
  resampleToAnalysisRate,
  zscore,
  type AutoSyncResult,
} from "@openreel/core";
import { loadAudioBuffer } from "../utils/load-audio-buffer";
import { useProjectStore } from "../stores/project-store";

/**
 * Auto Sync bridge — align a single video clip to a reference audio source
 * (a timeline audio clip or a wav/mp3 file) using the envelope cross-correlation
 * engine in `@openreel/core/sync`.
 *
 * Semantics: `syncTime` is where the target clip starts on the reference
 * timeline. A positive offset delays the clip relative to the reference
 * anchor; a negative offset trims that many seconds from the clip's head and
 * places it at the anchor. The anchor is the reference clip's timeline start
 * for a timeline reference, or the target clip's current position for a file
 * reference (the file is treated as starting where the clip is now).
 */

export type AutoSyncReferenceMode = "timeline" | "file";

export interface AutoSyncProgressInfo {
  percent: number;
  message: string;
}

export interface AutoSyncState {
  /** Clip the analysis was run for (the selected video clip). */
  targetClipId: string | null;
  isProcessing: boolean;
  progress: AutoSyncProgressInfo | null;
  referenceMode: AutoSyncReferenceMode;
  /** Selected timeline audio clip (mode === "timeline"). */
  referenceClipId: string | null;
  /** Selected wav/mp3 file (mode === "file"). */
  referenceFile: File | null;
  result: AutoSyncResult | null;
  /** True after a successful apply until the next analysis/setup change. */
  applied: boolean;
  error: string | null;
}

export interface AutoSyncReferenceOption {
  clipId: string;
  name: string;
  trackName: string;
}

type StateListener = (state: AutoSyncState) => void;

const initialState: AutoSyncState = {
  targetClipId: null,
  isProcessing: false,
  progress: null,
  referenceMode: "timeline",
  referenceClipId: null,
  referenceFile: null,
  result: null,
  applied: false,
  error: null,
};

/** Let queued React state updates paint before a heavy synchronous phase. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Copy the [start, end] window of an AudioBuffer as per-channel arrays. */
function sliceWindow(
  buffer: AudioBuffer,
  startSeconds: number,
  endSeconds: number,
): Float32Array[] {
  const start = Math.max(
    0,
    Math.min(buffer.length, Math.floor(startSeconds * buffer.sampleRate)),
  );
  const end = Math.max(
    start,
    Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate)),
  );
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel).slice(start, end));
  }
  return channels;
}

function clipWindow(clip: {
  inPoint?: number;
  outPoint?: number;
  duration: number;
}): { start: number; end: number } {
  const start = clip.inPoint ?? 0;
  const end = Math.min(
    clip.outPoint ?? start + clip.duration,
    start + clip.duration,
  );
  return { start, end };
}

/** Human-readable offset description for toasts and the inspector card. */
export function formatSyncOffset(syncTime: number): string {
  const seconds = Math.abs(syncTime);
  if (!Number.isFinite(syncTime) || seconds < 0.0005) return "already in sync";
  if (syncTime > 0) return `delay ${seconds.toFixed(3)} s`;
  return `trim ${seconds.toFixed(3)} s from head`;
}

export interface AutoSyncPairOutcome {
  ok: boolean;
  /**
   * The analysis result (kept even on success — applying clears it from the
   * bridge state, so callers use this for their summary toast).
   */
  result: AutoSyncResult | null;
  error: string | null;
}

export class AutoSyncBridge {
  private state: AutoSyncState = { ...initialState };
  private listeners = new Set<StateListener>();
  /** Snapshot of analysis inputs, re-checked before applying. */
  private analyzedKey: string | null = null;
  private audioContext: AudioContext | null = null;

  getState(): AutoSyncState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<AutoSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private clearResult(): void {
    this.analyzedKey = null;
    this.setState({
      result: null,
      applied: false,
      error: null,
      progress: null,
    });
  }

  setReferenceMode(mode: AutoSyncReferenceMode): void {
    if (this.state.referenceMode === mode) return;
    this.setState({ referenceMode: mode });
    this.setReferenceClipId(null);
    this.setReferenceFile(null);
  }

  setReferenceClipId(clipId: string | null): void {
    if (this.state.referenceClipId === clipId) return;
    this.setState({ referenceClipId: clipId });
    this.clearResult();
  }

  setReferenceFile(file: File | null): void {
    if (this.state.referenceFile === file) return;
    this.setState({ referenceFile: file });
    this.clearResult();
  }

  reset(): void {
    this.analyzedKey = null;
    this.state = { ...initialState };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Timeline audio clips usable as a reference for `targetClipId`. */
  getReferenceOptions(targetClipId: string): AutoSyncReferenceOption[] {
    const store = useProjectStore.getState();
    const options: AutoSyncReferenceOption[] = [];
    for (const track of store.project.timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.id === targetClipId) continue;
        const media = store.getMediaItem(clip.mediaId);
        if (!media || media.type !== "audio") continue;
        if (
          (clip.speed ?? 1) !== 1 ||
          clip.reversed ||
          clip.speedKeyframes?.length ||
          clip.freezeFrames?.length
        ) {
          continue;
        }
        options.push({ clipId: clip.id, name: media.name, trackName: track.name });
      }
    }
    return options;
  }

  /**
   * Decode reference audio: fast native decode first (wav/mp3/m4a), then the
   * shared extraction path (ffmpeg) as a fallback.
   */
  private async loadReferenceAudio(
    blob: Blob,
    options: { fastDecode: boolean; audioTrackIndex: number },
    onProgress: (percent: number) => void,
  ): Promise<AudioBuffer | null> {
    if (options.fastDecode) {
      try {
        const decoded = await this.getAudioContext().decodeAudioData(
          await blob.arrayBuffer(),
        );
        if (decoded && decoded.length > 0) return decoded;
      } catch {
        // fall through to the extraction path
      }
    }
    onProgress(32);
    return loadAudioBuffer(this.getAudioContext(), blob, {
      audioTrackIndex: options.audioTrackIndex,
      onProgress: (progress) => onProgress(32 + Math.round(progress.progress * 13)),
    });
  }

  async analyze(targetClipId: string): Promise<boolean> {
    if (this.state.isProcessing) return false;

    const store = useProjectStore.getState();
    const clip = store.getClip(targetClipId);
    if (!clip) {
      this.setState({ error: "Clip not found" });
      return false;
    }
    const mediaItem = store.getMediaItem(clip.mediaId);
    if (!mediaItem?.blob) {
      this.setState({ error: "Media blob not found" });
      return false;
    }
    if (
      (clip.speed ?? 1) !== 1 ||
      clip.reversed ||
      clip.speedKeyframes?.length ||
      clip.freezeFrames?.length
    ) {
      this.setState({
        error: "Reset clip speed, reversal, and freeze frames before auto sync.",
      });
      return false;
    }

    const { referenceMode, referenceClipId, referenceFile } = this.state;
    let referenceBlob: Blob;
    let referenceWindow: { start: number; end: number };
    let referenceFastDecode: boolean;
    let referenceTrackIndex = 0;

    if (referenceMode === "timeline") {
      const refClip = referenceClipId ? store.getClip(referenceClipId) : null;
      if (!refClip) {
        this.setState({ error: "Choose a reference audio clip." });
        return false;
      }
      const refMedia = store.getMediaItem(refClip.mediaId);
      if (!refMedia?.blob) {
        this.setState({ error: "The reference clip has no audio." });
        return false;
      }
      referenceBlob = refMedia.blob;
      referenceWindow = clipWindow(refClip);
      referenceFastDecode = refMedia.type === "audio";
      referenceTrackIndex = refClip.audioTrackIndex ?? 0;
    } else {
      if (!referenceFile) {
        this.setState({ error: "Choose a reference audio file (wav/mp3)." });
        return false;
      }
      referenceBlob = referenceFile;
      referenceWindow = { start: 0, end: Number.POSITIVE_INFINITY };
      referenceFastDecode = true;
    }

    this.analyzedKey = this.snapshotKey(targetClipId);
    this.setState({
      targetClipId,
      isProcessing: true,
      progress: { percent: 4, message: "Loading clip audio..." },
      result: null,
      applied: false,
      error: null,
    });

    try {
      const audioContext = this.getAudioContext();
      const targetWindow = clipWindow(clip);

      const targetBuffer = await loadAudioBuffer(
        audioContext,
        mediaItem.blob,
        {
          audioTrackIndex: clip.audioTrackIndex ?? 0,
          onProgress: (progress) =>
            this.setState({
              progress: {
                percent: Math.min(30, 4 + Math.round(progress.progress * 26)),
                message: progress.message,
              },
            }),
        },
      );
      if (!targetBuffer) {
        throw new AutoSyncInputError("Could not read audio from the selected clip.");
      }

      const referenceBuffer = await this.loadReferenceAudio(
        referenceBlob,
        {
          fastDecode: referenceFastDecode,
          audioTrackIndex: referenceTrackIndex,
        },
        (percent) =>
          this.setState({
            progress: { percent, message: "Loading reference audio..." },
          }),
      );
      if (!referenceBuffer) {
        throw new AutoSyncInputError(
          referenceMode === "file"
            ? "Could not decode the reference file. WAV and MP3 are supported."
            : "Could not read audio from the reference clip.",
        );
      }

      const referenceChannels = sliceWindow(
        referenceBuffer,
        referenceWindow.start,
        referenceWindow.end,
      );
      const targetChannels = sliceWindow(
        targetBuffer,
        targetWindow.start,
        targetWindow.end,
      );

      this.setState({
        progress: { percent: 50, message: "Preparing analysis..." },
      });
      await tick();

      const reference16k = resampleToAnalysisRate(
        downmixToMono(referenceChannels),
        referenceBuffer.sampleRate,
      );
      const target16k = resampleToAnalysisRate(
        downmixToMono(targetChannels),
        targetBuffer.sampleRate,
      );
      if (
        reference16k.length < AUTO_SYNC_MIN_SAMPLES ||
        target16k.length < AUTO_SYNC_MIN_SAMPLES
      ) {
        throw new AutoSyncInputError(
          `Both the clip and the reference need at least ${
            AUTO_SYNC_MIN_SAMPLES / 16000
          } second of audio to analyze.`,
        );
      }

      this.setState({
        progress: { percent: 55, message: "Analyzing reference envelope..." },
      });
      await tick();
      const referenceEnvelope = zscore(computeEnvelope(reference16k));

      this.setState({
        progress: { percent: 75, message: "Analyzing clip envelope..." },
      });
      await tick();
      const targetEnvelope = zscore(computeEnvelope(target16k));

      this.setState({ progress: { percent: 92, message: "Correlating..." } });
      await tick();
      const result = correlateAutoSyncEnvelopes(
        referenceEnvelope,
        targetEnvelope,
      );

      this.setState({
        isProcessing: false,
        progress: null,
        result,
        error: result.valid
          ? null
          : `Weak match (score ${result.score.toFixed(2)}, threshold ${AUTO_SYNC_SCORE_THRESHOLD}). The reference may not be the audio from this clip.`,
      });
      return true;
    } catch (error) {
      this.analyzedKey = null;
      this.setState({
        isProcessing: false,
        progress: null,
        result: null,
        error: error instanceof Error ? error.message : "Auto sync analysis failed",
      });
      return false;
    }
  }

  /**
   * Snapshot of everything that must stay unchanged between analyze and apply.
   * Target start time only matters for file mode (it defines the anchor).
   */
  private snapshotKey(targetClipId: string): string {
    const store = useProjectStore.getState();
    const clip = store.getClip(targetClipId);
    const { referenceMode, referenceClipId, referenceFile } = this.state;
    const target = clip
      ? {
          in: clip.inPoint ?? 0,
          out: clip.outPoint ?? (clip.inPoint ?? 0) + clip.duration,
          start: referenceMode === "file" ? clip.startTime : undefined,
        }
      : null;
    let reference: unknown;
    if (referenceMode === "timeline") {
      const refClip = referenceClipId ? store.getClip(referenceClipId) : null;
      reference = refClip
        ? {
            id: refClip.id,
            in: refClip.inPoint ?? 0,
            out:
              refClip.outPoint ??
              (refClip.inPoint ?? 0) + refClip.duration,
            start: refClip.startTime,
          }
        : null;
    } else {
      reference = referenceFile
        ? {
            name: referenceFile.name,
            size: referenceFile.size,
            lastModified: referenceFile.lastModified,
          }
        : null;
    }
    return JSON.stringify({ target, reference });
  }

  /**
   * Apply the analyzed offset: trim the clip's head for a negative offset,
   * then move the clip to `anchor + max(syncTime, 0)` — all inside one undo
   * history group.
   */
  async apply(targetClipId: string): Promise<boolean> {
    if (this.state.isProcessing) return false;

    const { result, targetClipId: analyzedClipId, referenceMode } = this.state;
    if (!result || analyzedClipId !== targetClipId) {
      this.setState({ error: "Run the analysis first." });
      return false;
    }
    if (!result.valid) {
      this.setState({
        error: "The match is too weak to apply. Try a different reference.",
      });
      return false;
    }
    if (this.analyzedKey !== this.snapshotKey(targetClipId)) {
      this.setState({
        error: "The clip or reference changed since analysis. Analyze again.",
      });
      return false;
    }

    const store = useProjectStore.getState();
    const clip = store.getClip(targetClipId);
    if (!clip) {
      this.setState({ error: "Clip not found" });
      return false;
    }
    if (
      (clip.speed ?? 1) !== 1 ||
      clip.reversed ||
      clip.speedKeyframes?.length ||
      clip.freezeFrames?.length
    ) {
      this.setState({
        error: "Reset clip speed, reversal, and freeze frames before auto sync.",
      });
      return false;
    }

    const { start: inPoint, end: outPoint } = clipWindow(clip);
    const trimHead = Math.max(0, -result.syncTime);
    if (trimHead >= outPoint - inPoint) {
      this.setState({
        error: "The offset is longer than the clip — there is nothing left to sync.",
      });
      return false;
    }

    let anchor: number;
    if (referenceMode === "timeline") {
      const refClip = this.state.referenceClipId
        ? store.getClip(this.state.referenceClipId)
        : null;
      if (!refClip) {
        this.setState({ error: "The reference clip no longer exists." });
        return false;
      }
      anchor = refClip.startTime;
    } else {
      anchor = clip.startTime;
    }
    const newStartTime = anchor + Math.max(0, result.syncTime);

    this.setState({ isProcessing: true, error: null });
    let appliedAnything = false;
    store.beginHistoryGroup("Auto sync to reference");
    try {
      if (trimHead > 1e-9) {
        const trimmed = await store.trimClip(
          targetClipId,
          inPoint + trimHead,
          outPoint,
        );
        if (!trimmed.success) {
          throw new Error(trimmed.error?.message ?? "Could not trim clip");
        }
        appliedAnything = true;
      }
      if (Math.abs(newStartTime - clip.startTime) > 1e-6) {
        const moved = await store.moveClip(targetClipId, newStartTime);
        if (!moved.success) {
          throw new Error(moved.error?.message ?? "Could not move clip");
        }
        appliedAnything = true;
      }
      store.endHistoryGroup();
      this.setState({
        isProcessing: false,
        progress: null,
        result: null,
        applied: true,
        error: null,
      });
      return true;
    } catch (error) {
      store.endHistoryGroup();
      if (appliedAnything) await store.undo();
      this.setState({
        isProcessing: false,
        error: error instanceof Error ? error.message : "Failed to apply auto sync",
      });
      return false;
    }
  }

  /**
   * One-click flow behind the timeline toolbar's "Auto Synchronization"
   * button (the Filmora UX): force the timeline reference, analyze the target
   * clip against it, and apply immediately when the match passes the
   * threshold. Returns the captured result so callers can summarize.
   */
  async syncPair(
    targetClipId: string,
    referenceClipId: string,
  ): Promise<AutoSyncPairOutcome> {
    if (targetClipId === referenceClipId) {
      return {
        ok: false,
        result: null,
        error: "Select two different clips — a video and an audio clip.",
      };
    }
    if (this.state.isProcessing) {
      return {
        ok: false,
        result: null,
        error: "An analysis is already running.",
      };
    }
    this.setReferenceMode("timeline");
    this.setReferenceClipId(referenceClipId);

    const analyzed = await this.analyze(targetClipId);
    if (!analyzed) {
      return { ok: false, result: null, error: this.state.error };
    }
    const result = this.state.result;
    if (!result?.valid) {
      return { ok: false, result, error: this.state.error };
    }
    const applied = await this.apply(targetClipId);
    return { ok: applied, result, error: this.state.error };
  }

  dispose(): void {
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.listeners.clear();
  }
}

let bridgeInstance: AutoSyncBridge | null = null;

export function getAutoSyncBridge(): AutoSyncBridge {
  if (!bridgeInstance) bridgeInstance = new AutoSyncBridge();
  return bridgeInstance;
}

export function disposeAutoSyncBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.dispose();
    bridgeInstance = null;
  }
}
