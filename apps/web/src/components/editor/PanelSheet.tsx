import React, { useRef } from "react";
import { X } from "@/icons/lucide-compat";

/**
 * Bottom-sheet chrome for the stacked (phone / tablet) editor layout.
 *
 * The head renders *inside* each panel container at every tier — it is only
 * hidden by CSS on desktop — so panels never remount and never lose state.
 *
 * Behavior follows Apple's sheet guidance (`hig/sheets.md › Mobile`): a
 * grabber, detents the sheet rests at, drag to resize, tap the grabber to
 * cycle detents, and drag down past the lowest detent to dismiss.
 */

export const SHEET_DETENTS = [0.46, 0.68, 0.92] as const;
export const DEFAULT_SHEET_DETENT = 1;
const DISMISS_DISTANCE = 96;

export const sheetDetentPx = (index: number): number => {
  const height = window.innerHeight;
  const fraction =
    SHEET_DETENTS[Math.max(0, Math.min(index, SHEET_DETENTS.length - 1))];
  return Math.round(Math.min(height * fraction, height - 56));
};

export interface PanelSheetHeadProps {
  title: string;
  shellRef: React.RefObject<HTMLDivElement | null>;
  detent: number;
  onDetentChange: (detent: number) => void;
  onClose: () => void;
}

export const PanelSheetHead: React.FC<PanelSheetHeadProps> = ({
  title,
  shellRef,
  detent,
  onDetentChange,
  onClose,
}) => {
  const drag = useRef({ startY: 0, startHeight: 0, moved: false });

  const readHeight = (): number => {
    const shell = shellRef.current;
    if (shell) {
      const raw = window.getComputedStyle(shell).getPropertyValue("--sheet-h").trim();
      const value = parseFloat(raw);
      if (raw.endsWith("px") && Number.isFinite(value)) return value;
    }
    return sheetDetentPx(detent);
  };

  const setHeight = (px: number) => {
    shellRef.current?.style.setProperty("--sheet-h", `${Math.round(px)}px`);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: readHeight(), moved: false };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = event.clientY - drag.current.startY;
    if (Math.abs(delta) > 3) drag.current.moved = true;
    const min = sheetDetentPx(0) * 0.55;
    const max = window.innerHeight - 56;
    setHeight(Math.min(Math.max(drag.current.startHeight - delta, min), max));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (!drag.current.moved) {
      // Tap the grabber to cycle through the detents.
      onDetentChange((detent + 1) % SHEET_DETENTS.length);
      return;
    }

    const height = readHeight();
    const delta = drag.current.startY - event.clientY; // positive = dragged up

    if (delta < -DISMISS_DISTANCE && height <= sheetDetentPx(0) + 24) {
      onDetentChange(DEFAULT_SHEET_DETENT);
      onClose();
      return;
    }

    let nearest = 0;
    let best = Infinity;
    SHEET_DETENTS.forEach((_, index) => {
      const distance = Math.abs(sheetDetentPx(index) - height);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    // Live drag wrote an inline px value — hand control back to the
    // detent attribute so the sheet keeps tracking the viewport.
    shellRef.current?.style.removeProperty("--sheet-h");
    onDetentChange(nearest);
  };

  return (
    <div
      className="panel-sheet-head"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <span className="sheet-grabber" aria-hidden="true" />
      <div className="sheet-head-row">
        <span className="sheet-title">{title}</span>
        <button
          type="button"
          className="sheet-close"
          aria-label={`Close ${title}`}
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
};

/** Dimmed backdrop behind bottom sheets — phone tier only (CSS decides). */
export const SheetBackdrop: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <button
    type="button"
    className="sheet-backdrop"
    aria-label="Close panel"
    tabIndex={-1}
    onClick={onClose}
  />
);

export default PanelSheetHead;
