import { describe, expect, it } from "vitest";
import type { SelectionItem } from "../../../stores/ui-store";
import { resolveClipTapSelection } from "./clip-selection";

const clip = (id: string): SelectionItem => ({
  type: "clip",
  id,
  trackId: "t1",
});

describe("resolveClipTapSelection", () => {
  it("replaces the selection on a plain tap", () => {
    const next = resolveClipTapSelection([clip("a"), clip("b")], clip("c"), {
      addToSelection: false,
      multiSelectMode: false,
    });
    expect(next.map((s) => s.id)).toEqual(["c"]);
  });

  it("appends on a desktop modifier tap", () => {
    const next = resolveClipTapSelection([clip("a")], clip("b"), {
      addToSelection: true,
      multiSelectMode: false,
    });
    expect(next.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("never duplicates on a modifier tap of an already-selected clip", () => {
    const next = resolveClipTapSelection([clip("a")], clip("a"), {
      addToSelection: true,
      multiSelectMode: false,
    });
    expect(next.map((s) => s.id)).toEqual(["a"]);
  });

  it("adds a clip in multi-select mode", () => {
    const next = resolveClipTapSelection([clip("a")], clip("b"), {
      addToSelection: false,
      multiSelectMode: true,
    });
    expect(next.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("removes a clip in multi-select mode", () => {
    const next = resolveClipTapSelection([clip("a"), clip("b")], clip("a"), {
      addToSelection: false,
      multiSelectMode: true,
    });
    expect(next.map((s) => s.id)).toEqual(["b"]);
  });

  it("can empty the selection in multi-select mode", () => {
    const next = resolveClipTapSelection([clip("a")], clip("a"), {
      addToSelection: false,
      multiSelectMode: true,
    });
    expect(next).toEqual([]);
  });
});
