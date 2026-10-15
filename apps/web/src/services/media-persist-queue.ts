import { createStore } from "zustand/vanilla";
import type { MediaMetadata } from "@openreel/core";
import { saveMediaBlob } from "./media-storage";
import { toast } from "../stores/notification-store";

export type MediaPersistStatus = "queued" | "writing" | "done" | "error";

export interface MediaPersistState {
  /** Media id → persistence status for writes enqueued this session. */
  entries: Record<string, MediaPersistStatus>;
}

export interface MediaPersistJob {
  projectId: string;
  mediaId: string;
  /** Source file name, used in the failure toast. */
  name: string;
  blob: Blob;
  metadata: MediaMetadata;
  /** Failure toast headline. Defaults to the import wording. */
  failureTitle?: string;
  /** Runs once the write settles. `persisted` is false when it failed or was cancelled. */
  onSettled?: (persisted: boolean) => void;
}

/**
 * Single-flight background writer for media blobs.
 *
 * Importing used to `await` the IndexedDB commit for the whole blob before
 * `importMedia` resolved, which stalled clip placement on large files until
 * hundreds of megabytes had been written. Importers hand the write here
 * instead and return immediately; the asset stays marked `isSaving` until the
 * commit lands.
 *
 * Writes are strictly serial so two multi-hundred-megabyte commits never
 * compete, and a re-import of the same asset supersedes its queued write.
 */
export class MediaPersistQueue {
  readonly store = createStore<MediaPersistState>(() => ({ entries: {} }));

  private queue: MediaPersistJob[] = [];
  private running = false;
  private cancelled = new Set<string>();
  private idleWaiters: Array<() => void> = [];

  enqueue(job: MediaPersistJob): void {
    // A later write for the same asset replaces the pending one.
    this.queue = this.queue.filter((queued) => queued.mediaId !== job.mediaId);
    this.cancelled.delete(job.mediaId);
    this.queue.push(job);
    this.patch(job.mediaId, "queued");
    void this.drain();
  }

  /**
   * Drops a queued write for a deleted asset. A write already in flight cannot
   * be interrupted, but nothing further will be committed on its behalf.
   */
  cancel(mediaId: string): void {
    this.queue = this.queue.filter((job) => job.mediaId !== mediaId);
    this.cancelled.add(mediaId);
    const state = this.store.getState();
    if (!state.entries[mediaId]) return;
    const entries = { ...state.entries };
    delete entries[mediaId];
    this.store.setState({ entries });
  }

  getStatus(mediaId: string): MediaPersistStatus | undefined {
    return this.store.getState().entries[mediaId];
  }

  /** Resolves once every write enqueued so far has settled. */
  async flush(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private patch(mediaId: string, status: MediaPersistStatus): void {
    const state = this.store.getState();
    this.store.setState({ entries: { ...state.entries, [mediaId]: status } });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        if (this.cancelled.has(job.mediaId)) continue;

        this.patch(job.mediaId, "writing");
        let persisted = false;
        try {
          await saveMediaBlob(job.projectId, job.mediaId, job.blob, job.metadata);
          if (this.cancelled.has(job.mediaId)) continue;
          persisted = true;
          this.patch(job.mediaId, "done");
        } catch (error) {
          console.error("[MediaPersistQueue] Failed to persist media blob:", error);
          if (this.cancelled.has(job.mediaId)) continue;
          this.patch(job.mediaId, "error");
          toast.warning(
            job.failureTitle ?? "Media could not be saved in browser storage",
            `Keep the original ${job.name} so you can relink it after reloading.`,
          );
        } finally {
          job.onSettled?.(persisted);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

export const mediaPersistQueue = new MediaPersistQueue();
