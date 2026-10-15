import type { SelectionItem } from "../../../stores/ui-store";

export interface ClipTapOptions {
  /** Desktop modifier (Shift/⌘) — add to the selection instead of replacing. */
  addToSelection: boolean;
  /** Touch multi-select mode, entered by long-pressing a clip. */
  multiSelectMode: boolean;
}

/**
 * Computes the next selection after a clip is tapped.
 *
 * - Touch multi-select mode: the tap toggles the clip in/out of the selection.
 * - Desktop modifier tap (`addToSelection`): append without clearing.
 * - Plain tap: replace the selection with just this clip.
 */
export function resolveClipTapSelection(
  current: SelectionItem[],
  item: SelectionItem,
  { addToSelection, multiSelectMode }: ClipTapOptions,
): SelectionItem[] {
  const isAlreadySelected = current.some((s) => s.id === item.id);

  if (multiSelectMode) {
    return isAlreadySelected
      ? current.filter((s) => s.id !== item.id)
      : [...current, item];
  }

  if (addToSelection) {
    return isAlreadySelected ? current : [...current, item];
  }

  return [item];
}
