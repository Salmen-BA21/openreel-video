import "../../test/install-local-storage-mock";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaItem } from "@openreel/core";
import { installCryptoRandomUUID } from "../../utils/crypto-random-uuid";
import { createEmptyProject } from "./project-helpers";
import { useProjectStore } from "../project-store";

type MutableCrypto = Crypto & { randomUUID?: () => string };

/**
 * Regression: over a non-secure context (plain HTTP on a LAN address while
 * testing on a phone) `crypto.randomUUID` is undefined. Adding media used to
 * create the track and then throw while minting the clip id, leaving an empty
 * track and nothing on the timeline.
 */
describe("clip placement in an insecure context", () => {
  const originalRandomUUID = (globalThis.crypto as MutableCrypto).randomUUID;

  function disableNativeRandomUUID(): void {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  function seedAudioMedia(): MediaItem {
    const item: MediaItem = {
      id: "voice",
      name: "voice.mp3",
      type: "audio",
      blob: new Blob(["audio-bytes"]),
      fileHandle: null,
      waveformData: null,
      thumbnailUrl: null,
      metadata: {
        width: 0,
        height: 0,
        duration: 3,
        frameRate: 0,
        codec: "mp3",
        sampleRate: 44100,
        channels: 2,
        fileSize: 11,
      },
    };
    const project = createEmptyProject("Insecure context");
    useProjectStore.setState({
      hasOpenProject: true,
      project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: [item] },
      },
    });
    return item;
  }

  afterEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("leaves an empty track when randomUUID is missing (the bug)", async () => {
    const item = seedAudioMedia();
    disableNativeRandomUUID();

    const result = await useProjectStore
      .getState()
      .addClipToNewTrack(item.id, 0);

    const tracks = useProjectStore.getState().project.timeline.tracks;
    expect(result.success).toBe(false);
    expect(tracks.every((track) => track.clips.length === 0)).toBe(true);
  });

  it("places the audio clip once the polyfill restores randomUUID", async () => {
    const item = seedAudioMedia();
    disableNativeRandomUUID();
    installCryptoRandomUUID();

    const result = await useProjectStore
      .getState()
      .addClipToNewTrack(item.id, 0);

    expect(result.success).toBe(true);
    const tracks = useProjectStore.getState().project.timeline.tracks;
    const audioTrack = tracks.find((track) => track.type === "audio");
    expect(audioTrack?.clips).toHaveLength(1);
    expect(audioTrack?.clips[0].mediaId).toBe(item.id);
  });
});
