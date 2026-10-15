import { describe, expect, it, vi } from "vitest";
import { MediaImportService } from "./media-import-service";
import { inferMediaType, resolveMimeType } from "./mediabunny-engine";
import type { MediaBunnyEngine } from "./mediabunny-engine";
import type { FFmpegFallback } from "./ffmpeg-fallback";

/**
 * Windows reports an empty MIME type for `.MOV`, so an iPhone clip used to be
 * rejected by its MIME string before the file was ever opened. These cover the
 * extension fallback that keeps such files importable.
 */

const engine = {
  isAvailable: () => true,
  validateFormat: vi.fn(async () => ({ supported: true, format: "video/quicktime" })),
};

const service = new MediaImportService(
  engine as unknown as MediaBunnyEngine,
  {} as FFmpegFallback,
);

const fileNamed = (name: string, type = "") =>
  new File(["fake-media-bytes"], name, { type });

describe("resolveMimeType", () => {
  it("falls back to the extension when the browser reports no MIME type", () => {
    expect(resolveMimeType(fileNamed("2025_06_13_IMG_0512.MOV"))).toBe("video/quicktime");
  });

  it("prefers a specific browser MIME type over the extension", () => {
    expect(resolveMimeType(fileNamed("clip.mov", "video/quicktime"))).toBe("video/quicktime");
    expect(resolveMimeType(fileNamed("clip.mp4", "video/webm"))).toBe("video/webm");
  });

  it("ignores the generic octet-stream type browsers use for unknown files", () => {
    expect(resolveMimeType(fileNamed("clip.mkv", "application/octet-stream"))).toBe(
      "video/x-matroska",
    );
  });

  it("keeps a browser type when the extension is unknown", () => {
    expect(resolveMimeType(fileNamed("clip.weird", "video/mp4"))).toBe("video/mp4");
  });

  it("returns the browser type when neither MIME nor extension is usable", () => {
    expect(resolveMimeType(fileNamed("clip"))).toBe("");
  });

  it("handles a trailing dot and blobs without a filename", () => {
    expect(resolveMimeType(fileNamed("clip."))).toBe("");
    expect(resolveMimeType(new Blob(["bytes"]))).toBe("");
  });
});

describe("inferMediaType", () => {
  it("classifies an extension-derived MOV as video", () => {
    expect(inferMediaType(resolveMimeType(fileNamed("clip.MOV")))).toBe("video");
  });
});

describe("MediaImportService.validateFormat", () => {
  it("accepts an extension-only MOV instead of rejecting it as unknown", async () => {
    const result = await service.validateFormat(fileNamed("2025_06_13_IMG_0512.MOV"));
    expect(result.supported).toBe(true);
    expect(engine.validateFormat).toHaveBeenCalled();
  });

  it("still rejects a genuinely unsupported extension", async () => {
    const result = await service.validateFormat(fileNamed("archive.zip"));
    expect(result.supported).toBe(false);
    expect(result.error).toContain("Unsupported format");
  });
});
