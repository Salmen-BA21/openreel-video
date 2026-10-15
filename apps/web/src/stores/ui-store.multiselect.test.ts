import "../test/install-local-storage-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "./ui-store";

describe("ui-store multi-select mode", () => {
  beforeEach(() => {
    useUIStore.setState({ selectedItems: [], lastSelectedItem: null });
    useUIStore.getState().setClipMultiSelectMode(false);
  });

  it("tracks the multi-select mode flag", () => {
    expect(useUIStore.getState().clipMultiSelectMode).toBe(false);
    useUIStore.getState().setClipMultiSelectMode(true);
    expect(useUIStore.getState().clipMultiSelectMode).toBe(true);
    useUIStore.getState().setClipMultiSelectMode(false);
    expect(useUIStore.getState().clipMultiSelectMode).toBe(false);
  });

  it("starts with multi-select mode off", () => {
    expect(useUIStore.getState().clipMultiSelectMode).toBe(false);
  });

  it("does not persist the transient multi-select mode", () => {
    useUIStore.getState().setClipMultiSelectMode(true);
    const raw = window.localStorage.getItem("openreel-ui-preferences");
    expect(raw ?? "").not.toContain("clipMultiSelectMode");
  });
});
