import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface UseLongPressOptions {
  /** Whether the gesture is armed at all (skip when no handler is wired). */
  enabled?: boolean;
  /** Hold duration in ms before the press fires. */
  duration?: number;
  /** Movement beyond this many px cancels the press so scrolling wins. */
  moveTolerance?: number;
  /** Only arm for touch/pen pointers — desktop keeps modifier-click select. */
  touchOnly?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  /** Returns true exactly once after a long press fired, then resets. */
  consumeLongPress: () => boolean;
}

/**
 * Fires `onLongPress` when a touch/pen pointer is held still for `duration`.
 *
 * Movement beyond `moveTolerance`, a lift, or an OS `pointercancel` (which
 * browsers emit when they take over the gesture to scroll) cancels the press,
 * so native timeline panning keeps working.
 */
export function useLongPress(
  onLongPress: () => void,
  options: UseLongPressOptions = {},
): LongPressHandlers {
  const {
    enabled = true,
    duration = 450,
    moveTolerance = 8,
    touchOnly = true,
  } = options;

  const timerRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const firedRef = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => reset, [reset]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      reset();
      if (!enabled) return;
      if (touchOnly && (!event.pointerType || event.pointerType === "mouse")) {
        return;
      }
      if (event.button !== 0) return;

      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;

      const onPointerMove = (native: PointerEvent) => {
        if (native.pointerId !== pointerId) return;
        const dx = native.clientX - startX;
        const dy = native.clientY - startY;
        if (Math.hypot(dx, dy) > moveTolerance) reset();
      };
      const onPointerEnd = (native: PointerEvent) => {
        if (native.pointerId !== pointerId) return;
        reset();
      };

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
      };

      firedRef.current = false;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        cleanupRef.current?.();
        cleanupRef.current = null;
        firedRef.current = true;
        callbackRef.current();
      }, duration);
    },
    [duration, enabled, moveTolerance, reset, touchOnly],
  );

  const consumeLongPress = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  return { onPointerDown, consumeLongPress };
}
