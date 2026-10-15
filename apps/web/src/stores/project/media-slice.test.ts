import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { MediaItem, Project } from "@openreel/core";
import type { ProjectState } from "../project-store";
import { createEmptyProject } from "./project-helpers";
import { createMediaSlice } from "./media-slice";
import type { MediaPersistJob } from "../../services/media-persist-queue";

const { bridge, mediaPersistQueue, deleteMediaBlob } = vi.hoisted(() => ({
  bridge: {
    isInitialized: vi.fn(() => true),
    importFile: vi.fn(),
    generateThumbnailsForMedia: vi.fn(async () => []),
  },
  mediaPersistQueue: {
    enqueue: vi.fn<[MediaPersistJob], void>(),
    cancel: vi.fn<[string], void>(),
  },
  deleteMediaBlob: vi.fn(async () => {}),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: () => bridge,
  initializeMediaBridge: vi.fn(async () => {}),
}));
vi.mock("../../services/media-storage", () => ({
  deleteMediaBlob,
}));
vi.mock("../../services/media-persist-queue", () => ({ mediaPersistQueue }));

const decodedAudio = () => ({
  success: true,
  media: {
    metadata: {
      duration: 12,
      width: 0,
      height: 0,
      frameRate: 0,
      codec: "pcm",
      sampleRate: 48_000,
      channels: 2,
      hasVideo: false,
      hasAudio: true,
    },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createMediaStore(initial: Project = createEmptyProject("Original")) {
  return createStore<ProjectState>((set, get) => ({
    project: initial,
    actionExecutor: { execute: vi.fn(async () => ({ success: true })) },
    ...createMediaSlice(set, get),
  } as unknown as ProjectState));
}

function originalMedia(): MediaItem {
  return {
    id: "existing-media",
    name: "missing.wav",
    type: "audio",
    blob: null,
    fileHandle: null,
    metadata: { ...decodedAudio().media.metadata, fileSize: 3 },
    thumbnailUrl: null,
    waveformData: null,
    isPlaceholder: true,
  };
}

describe("Media slice asynchronous imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.importFile.mockReset();
    mediaPersistQueue.enqueue.mockReset();
    mediaPersistQueue.cancel.mockReset();
  });

  it("retains every concurrent import and edits made while files decode", async () => {
    const first = deferred<ReturnType<typeof decodedAudio>>();
    const second = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createMediaStore();
    const importingFirst = store.getState().importMedia(new File(["a"], "first.wav"));
    const importingSecond = store.getState().importMedia(new File(["b"], "second.wav"));
    store.setState({ project: { ...store.getState().project, name: "Edited while importing" } });

    second.resolve(decodedAudio());
    expect((await importingSecond).success).toBe(true);
    first.resolve(decodedAudio());
    expect((await importingFirst).success).toBe(true);

    expect(store.getState().project.name).toBe("Edited while importing");
    expect(store.getState().project.mediaLibrary.items.map((item) => item.name))
      .toEqual(["second.wav", "first.wav"]);
    expect(mediaPersistQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not reopen an old project when its media finishes importing", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const store = createMediaStore();
    const importing = store.getState().importMedia(new File(["a"], "first.wav"));
    const newProject = createEmptyProject("New project");
    store.setState({ project: newProject });
    decoding.resolve(decodedAudio());

    expect((await importing).success).toBe(false);
    expect(store.getState().project).toBe(newProject);
    expect(mediaPersistQueue.enqueue).not.toHaveBeenCalled();
  });

  it("persists replacement media and retains edits made while relinking", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const file = new File(["replacement"], "relinked.wav");
    const replacing = store.getState().replaceMediaAsset("existing-media", file);
    store.setState({ project: { ...store.getState().project, name: "Renamed while relinking" } });
    decoding.resolve(decodedAudio());

    expect((await replacing).success).toBe(true);
    expect(store.getState().project.name).toBe("Renamed while relinking");
    expect(store.getState().project.mediaLibrary.items[0]).toMatchObject({
      name: "relinked.wav",
      blob: file,
      isPlaceholder: false,
    });
    expect(mediaPersistQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: initial.id,
        mediaId: "existing-media",
        name: "relinked.wav",
        blob: file,
        metadata: expect.objectContaining({ fileSize: file.size }),
      }),
    );
  });

  it("does not resurrect media removed while a replacement decodes", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const replacing = store.getState().replaceMediaAsset(
      "existing-media",
      new File(["replacement"], "relinked.wav"),
    );
    store.setState({ project: { ...initial, mediaLibrary: { items: [] } } });
    decoding.resolve(decodedAudio());

    expect((await replacing).success).toBe(false);
    expect(store.getState().project.mediaLibrary.items).toEqual([]);
    expect(mediaPersistQueue.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the most recently requested replacement when decoding completes out of order", async () => {
    const older = deferred<ReturnType<typeof decodedAudio>>();
    const newer = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const replacingOlder = store.getState().replaceMediaAsset(
      "existing-media", new File(["older"], "older.wav"),
    );
    const replacingNewer = store.getState().replaceMediaAsset(
      "existing-media", new File(["newer"], "newer.wav"),
    );
    newer.resolve(decodedAudio());
    expect((await replacingNewer).success).toBe(true);
    older.resolve(decodedAudio());
    expect((await replacingOlder).success).toBe(false);

    expect(store.getState().project.mediaLibrary.items[0].name).toBe("newer.wav");
    expect(mediaPersistQueue.enqueue).toHaveBeenCalledOnce();
  });

  it("returns the asset without waiting on the blob write", async () => {
    bridge.importFile.mockResolvedValueOnce(decodedAudio());
    const store = createMediaStore();

    const result = await store.getState().importMedia(new File(["a"], "big.mp4"));

    expect(result.success).toBe(true);
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(mediaPersistQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "big.mp4",
        onSettled: expect.any(Function),
      }),
    );
  });

  it("marks the asset as saving until the background write settles", async () => {
    bridge.importFile.mockResolvedValueOnce(decodedAudio());
    let settle!: (persisted: boolean) => void;
    mediaPersistQueue.enqueue.mockImplementationOnce((job) => {
      settle = job.onSettled!;
    });
    const store = createMediaStore();

    await store.getState().importMedia(new File(["a"], "big.mp4"));
    expect(store.getState().project.mediaLibrary.items[0].isSaving).toBe(true);

    settle(true);
    expect(store.getState().project.mediaLibrary.items[0].isSaving).toBe(false);
  });

  it("keeps the asset marked as saving when the write fails", async () => {
    bridge.importFile.mockResolvedValueOnce(decodedAudio());
    let settle!: (persisted: boolean) => void;
    mediaPersistQueue.enqueue.mockImplementationOnce((job) => {
      settle = job.onSettled!;
    });
    const store = createMediaStore();

    await store.getState().importMedia(new File(["a"], "big.mp4"));
    settle(false);

    expect(store.getState().project.mediaLibrary.items[0].isSaving).toBe(true);
  });

  it("cancels a queued write when its asset is deleted", async () => {
    const store = createMediaStore();

    await store.getState().deleteMedia("existing-media");

    expect(mediaPersistQueue.cancel).toHaveBeenCalledWith("existing-media");
  });
});
