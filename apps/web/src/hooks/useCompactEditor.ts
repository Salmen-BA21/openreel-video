import { useEditorLayout, COMPACT_EDITOR_QUERY } from "./useEditorLayout";

export { COMPACT_EDITOR_QUERY };

/**
 * True whenever the editor is NOT in the multi-column desktop workspace
 * (i.e. phone or compact/tablet stacked layout). Kept as a thin wrapper over
 * `useEditorLayout` so every call site and the layout tiers stay in sync.
 */
export function useCompactEditor(): boolean {
  return useEditorLayout() !== "desktop";
}
