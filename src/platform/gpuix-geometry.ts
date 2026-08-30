export interface ElementBoundsRenderer {
  getElementBounds(elementId: number): number[] | null;
}

export interface WindowSizeRenderer {
  getWindowSize(): { width: number; height: number };
}

export interface ScrollRenderer {
  getScrollOffset(elementId: number): number[] | null;
  scrollTo(elementId: number, x: number, y: number): void;
}

export type ElementBounds = readonly [x: number, y: number, width: number, height: number];

export function queryElementBounds(
  renderer: ElementBoundsRenderer,
  elementId: number,
): ElementBounds | null {
  const bounds = queryGpuix(() => renderer.getElementBounds(elementId));
  if (
    !bounds
    || bounds.length < 4
    || !bounds.slice(0, 4).every(Number.isFinite)
    || bounds[2] <= 1
    || bounds[3] <= 1
  ) {
    return null;
  }
  return [bounds[0], bounds[1], bounds[2], bounds[3]];
}

export function queryWindowSize(
  renderer: WindowSizeRenderer,
): { width: number; height: number } | null {
  const size = queryGpuix(() => renderer.getWindowSize());
  if (
    !size
    || !Number.isFinite(size.width)
    || !Number.isFinite(size.height)
    || size.width <= 0
    || size.height <= 0
  ) {
    return null;
  }
  return size;
}

export function queryScrollOffset(
  renderer: Pick<ScrollRenderer, "getScrollOffset">,
  elementId: number,
): readonly [x: number, y: number] | null {
  const offset = queryGpuix(() => renderer.getScrollOffset(elementId));
  if (!offset || offset.length < 2 || !offset.slice(0, 2).every(Number.isFinite)) {
    return null;
  }
  return [offset[0], offset[1]];
}

export function scrollToElement(
  renderer: Pick<ScrollRenderer, "scrollTo">,
  elementId: number,
  x: number,
  y: number,
): boolean {
  if (![x, y].every(Number.isFinite)) return false;
  return queryGpuix(() => {
    renderer.scrollTo(elementId, x, y);
    return true;
  }) ?? false;
}

function queryGpuix<T>(query: () => T): T | null {
  try {
    return query();
  } catch {
    // GPUIX geometry is temporarily unavailable while a native window is
    // minimized, closing, or between render frames. Callers treat that as a
    // skipped interaction frame rather than a process-level failure.
    return null;
  }
}
