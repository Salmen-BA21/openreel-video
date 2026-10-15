import { useSyncExternalStore } from "react";

/**
 * Editor layout tiers.
 *
 *   phone    < 640px            — vertical stack: preview + timeline + tool dock,
 *                                 panels open as bottom sheets
 *   compact  640–1099px         — same stack, panels open as side drawers
 *                                 (also coarse-pointer devices up to 1366px)
 *   desktop  ≥ 1100px           — resizable multi-column workspace
 *
 * The tier is mirrored onto the editor root as `data-editor-layout` so CSS can
 * scope every responsive rule without media queries (single source of truth —
 * JS and CSS always agree).
 */
export type EditorLayout = "phone" | "compact" | "desktop";

export const PHONE_MAX_WIDTH = 640;
export const DESKTOP_MIN_WIDTH = 1100;
/** Coarse-pointer devices (tablets) stay in the stacked layout up to this width. */
export const COARSE_DESKTOP_MIN_WIDTH = 1366;

export const COMPACT_EDITOR_QUERY =
  "(max-width: 1100px), (pointer: coarse) and (max-width: 1366px)";

function readLayout(): EditorLayout {
  if (typeof window === "undefined") return "desktop";
  const width = window.innerWidth;
  if (width < PHONE_MAX_WIDTH) return "phone";
  if (width <= DESKTOP_MIN_WIDTH) return "compact";
  // Large touch-first devices keep the stacked layout instead of the
  // pointer-driven multi-column workspace.
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches &&
    width <= COARSE_DESKTOP_MIN_WIDTH
  ) {
    return "compact";
  }
  return "desktop";
}

function subscribe(onChange: () => void): () => void {
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia(COMPACT_EDITOR_QUERY)
      : null;
  const coarse =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)")
      : null;
  media?.addEventListener("change", onChange);
  coarse?.addEventListener("change", onChange);
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    media?.removeEventListener("change", onChange);
    coarse?.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

export function useEditorLayout(): EditorLayout {
  return useSyncExternalStore(subscribe, readLayout, () => "desktop");
}
