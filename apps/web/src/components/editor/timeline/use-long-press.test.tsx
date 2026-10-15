import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./use-long-press";

type PointerEventInitLike = NonNullable<
  ConstructorParameters<typeof PointerEvent>[1]
>;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, options: PointerEventInitLike = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? "touch";
  }
}

const down = (overrides: PointerEventInitLike = {}) =>
  new TestPointerEvent("pointerdown", {
    pointerType: "touch",
    pointerId: 1,
    button: 0,
    clientX: 10,
    clientY: 10,
    ...overrides,
  });

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires once the touch is held for the duration", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { duration: 400 }),
    );

    act(() => result.current.onPointerDown(down() as never));
    act(() => vi.advanceTimersByTime(399));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores mouse pointers so desktop keeps modifier-click select", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown(down({ pointerType: "mouse" }) as never));
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("stays inert while disabled", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { enabled: false }),
    );

    act(() => result.current.onPointerDown(down() as never));
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the finger moves far enough to scroll", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { duration: 400, moveTolerance: 8 }),
    );

    act(() => result.current.onPointerDown(down() as never));
    act(() => {
      window.dispatchEvent(
        new TestPointerEvent("pointermove", {
          pointerId: 1,
          pointerType: "touch",
          clientX: 40,
          clientY: 10,
        }),
      );
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on lift or when the OS takes over the gesture", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { duration: 400 }),
    );

    act(() => result.current.onPointerDown(down() as never));
    act(() => {
      window.dispatchEvent(
        new TestPointerEvent("pointercancel", {
          pointerId: 1,
          pointerType: "touch",
        }),
      );
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();

    // A fresh press can still fire afterwards.
    act(() => result.current.onPointerDown(down({ pointerId: 2 }) as never));
    act(() => vi.advanceTimersByTime(400));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("reports the fired press exactly once for click suppression", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { duration: 400 }),
    );

    act(() => result.current.onPointerDown(down() as never));
    act(() => vi.advanceTimersByTime(400));

    expect(result.current.consumeLongPress()).toBe(true);
    expect(result.current.consumeLongPress()).toBe(false);
  });
});
