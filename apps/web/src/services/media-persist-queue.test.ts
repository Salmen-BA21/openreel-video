import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaMetadata } from "@openreel/core";
import { MediaPersistQueue } from "./media-persist-queue";

const { saveMediaBlob, warning } = vi.hoisted(() => ({
  saveMediaBlob: vi.fn(async () => {}),
  warning: vi.fn(),
}));

vi.mock("./media-storage", () => ({ saveMediaBlob }));
vi.mock("../stores/notification-store", () => ({ toast: { warning } }));

const metadata: MediaMetadata = {
  duration: 12,
  width: 1920,
  height: 1080,
  frameRate: 30,
  codec: "h264",
  sampleRate: 48_000,
  channels: 2,
  fileSize: 400_000_000,
};

function job(overrides: Partial<Parameters<MediaPersistQueue["enqueue"]>[0]> = {}) {
  return {
    projectId: "project-1",
    mediaId: "media-1",
    name: "clip.mp4",
    blob: new Blob(["clip"]),
    metadata,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("MediaPersistQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMediaBlob.mockReset().mockResolvedValue(undefined);
    warning.mockReset();
  });

  it("commits one blob at a time and tracks status", async () => {
    const first = deferred<void>();
    saveMediaBlob.mockImplementationOnce(() => first.promise);
    const queue = new MediaPersistQueue();
    const settled: boolean[] = [];

    queue.enqueue(job({ mediaId: "a", onSettled: (ok) => settled.push(ok) }));
    queue.enqueue(
      job({ mediaId: "b", name: "b.mp4", blob: new Blob(["b"]), onSettled: (ok) => settled.push(ok) }),
    );

    await Promise.resolve();
    expect(queue.getStatus("a")).toBe("writing");
    expect(queue.getStatus("b")).toBe("queued");
    expect(saveMediaBlob).toHaveBeenCalledTimes(1);

    first.resolve();
    await queue.flush();

    expect(saveMediaBlob).toHaveBeenCalledTimes(2);
    expect(queue.getStatus("a")).toBe("done");
    expect(queue.getStatus("b")).toBe("done");
    expect(settled).toEqual([true, true]);
  });

  it("drops superseded queued writes for the same asset", async () => {
    const first = deferred<void>();
    saveMediaBlob.mockImplementationOnce(() => first.promise);
    const queue = new MediaPersistQueue();
    const firstBlob = new Blob(["v1"]);
    const latestBlob = new Blob(["v3"]);

    queue.enqueue(job({ blob: firstBlob }));
    queue.enqueue(job({ blob: new Blob(["v2"]) }));
    queue.enqueue(job({ blob: latestBlob }));

    await Promise.resolve();
    expect(saveMediaBlob).toHaveBeenCalledTimes(1);

    first.resolve();
    await queue.flush();

    // The in-flight write lands; the two queued ones collapse into the newest.
    expect(saveMediaBlob).toHaveBeenCalledTimes(2);
    expect(saveMediaBlob).toHaveBeenLastCalledWith("project-1", "media-1", latestBlob, metadata);
  });

  it("drops a queued write when its asset is deleted", async () => {
    const first = deferred<void>();
    saveMediaBlob.mockImplementationOnce(() => first.promise);
    const queue = new MediaPersistQueue();
    const settled: boolean[] = [];

    queue.enqueue(job({ mediaId: "a", onSettled: (ok) => settled.push(ok) }));
    queue.enqueue(job({ mediaId: "b", name: "b.mp4", onSettled: (ok) => settled.push(ok) }));
    queue.cancel("b");
    expect(queue.getStatus("b")).toBeUndefined();

    await Promise.resolve();
    first.resolve();
    await queue.flush();

    expect(saveMediaBlob).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([true]);
  });

  it("surfaces a failed commit without stalling later writes", async () => {
    saveMediaBlob
      .mockRejectedValueOnce(new Error("QuotaExceededError"))
      .mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new MediaPersistQueue();
    const settled: boolean[] = [];

    queue.enqueue(job({ mediaId: "a", onSettled: (ok) => settled.push(ok) }));
    queue.enqueue(job({ mediaId: "b", name: "next.mp4", onSettled: (ok) => settled.push(ok) }));
    await queue.flush();

    expect(queue.getStatus("a")).toBe("error");
    expect(queue.getStatus("b")).toBe("done");
    expect(settled).toEqual([false, true]);
    expect(warning).toHaveBeenCalledWith(
      "Media could not be saved in browser storage",
      expect.stringContaining("clip.mp4"),
    );
    consoleError.mockRestore();
  });

  it("uses the caller's failure headline for replacement imports", async () => {
    saveMediaBlob.mockRejectedValueOnce(new Error("nope"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new MediaPersistQueue();

    queue.enqueue(
      job({
        name: "relinked.mp4",
        failureTitle: "Replacement media could not be saved in browser storage",
      }),
    );
    await queue.flush();

    expect(warning).toHaveBeenCalledWith(
      "Replacement media could not be saved in browser storage",
      expect.stringContaining("relinked.mp4"),
    );
    consoleError.mockRestore();
  });

  it("resolves flush immediately when idle", async () => {
    await expect(new MediaPersistQueue().flush()).resolves.toBeUndefined();
  });
});
