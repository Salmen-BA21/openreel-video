import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AutoSyncSection from "./AutoSyncSection";
import {
  getAutoSyncBridge,
  disposeAutoSyncBridge,
} from "../../../bridges/auto-sync-bridge";

const { mockGetState } = vi.hoisted(() => ({ mockGetState: vi.fn() }));

vi.mock("../../../stores/project-store", () => ({
  useProjectStore: { getState: mockGetState },
}));

vi.mock("../../../utils/load-audio-buffer", () => ({
  loadAudioBuffer: vi.fn(),
}));

function emptyProject() {
  return {
    timeline: {
      tracks: [
        {
          id: "t-video",
          name: "Video 1",
          type: "video",
          locked: false,
          clips: [],
        },
        {
          id: "t-audio",
          name: "Audio 1",
          type: "audio",
          locked: false,
          clips: [],
        },
      ],
    },
  };
}

describe("AutoSyncSection", () => {
  beforeEach(() => {
    disposeAutoSyncBridge();
    mockGetState.mockReturnValue({
      project: emptyProject(),
      getClip: vi.fn(() => undefined),
      getMediaItem: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    disposeAutoSyncBridge();
    vi.clearAllMocks();
  });

  it("shows the reference source toggle with Analyze disabled until a reference exists", () => {
    render(<AutoSyncSection clipId="clip-1" />);

    expect(
      screen.getByRole("button", { name: "Timeline audio" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audio file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();
    // No audio clips on the timeline → guidance instead of an empty dropdown.
    expect(screen.getByText(/Add an audio clip/)).toBeInTheDocument();
  });

  it("switches to the file picker in file mode", () => {
    render(<AutoSyncSection clipId="clip-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Audio file" }));
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    expect(screen.queryByText(/Add an audio clip/)).not.toBeInTheDocument();
  });

  it("preselects the only timeline audio clip so Analyze becomes available", () => {
    const media = {
      id: "m-song",
      type: "audio",
      name: "Song.wav",
      blob: new Blob([new Uint8Array([1])]),
    };
    mockGetState.mockReturnValue({
      project: {
        timeline: {
          tracks: [
            {
              id: "t-audio",
              name: "Audio 1",
              type: "audio",
              locked: false,
              clips: [
                {
                  id: "clip-audio",
                  mediaId: "m-song",
                  trackId: "t-audio",
                  startTime: 0,
                  duration: 5,
                  inPoint: 0,
                  outPoint: 5,
                  speed: 1,
                },
              ],
            },
          ],
        },
      },
      getClip: vi.fn(() => undefined),
      getMediaItem: vi.fn((id: string) => (id === "m-song" ? media : undefined)),
    });

    render(<AutoSyncSection clipId="clip-1" />);

    expect(screen.getByRole("combobox")).toHaveValue("clip-audio");
    expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
  });

  it("lists multiple audio clips without auto-selecting one", () => {
    const media = {
      id: "m-song",
      type: "audio",
      name: "Song.wav",
      blob: new Blob([new Uint8Array([1])]),
    };
    const clips = ["clip-a", "clip-b"].map((id) => ({
      id,
      mediaId: "m-song",
      trackId: "t-audio",
      startTime: 0,
      duration: 5,
      inPoint: 0,
      outPoint: 5,
      speed: 1,
    }));
    mockGetState.mockReturnValue({
      project: {
        timeline: {
          tracks: [
            {
              id: "t-audio",
              name: "Audio 1",
              type: "audio",
              locked: false,
              clips,
            },
          ],
        },
      },
      getClip: vi.fn(() => undefined),
      getMediaItem: vi.fn((id: string) => (id === "m-song" ? media : undefined)),
    });

    render(<AutoSyncSection clipId="clip-1" />);

    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();

    // Choosing one enables the analysis.
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "clip-a" },
    });
    expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    expect(getAutoSyncBridge().getState().referenceClipId).toBe("clip-a");
  });
});
