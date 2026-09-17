export type BottomPinStateInput = {
  bottomPinned: boolean;
  lastMaxScroll: number;
  lastScrollTop: number;
  maxScroll: number;
  scrollTop: number;
  tolerance: number;
};

/**
 * Keep a virtualized reading document at its end while its measured height
 * grows, but release that pin when the user scrolls away from the end.
 */
export function nextBottomPinnedState({
  bottomPinned,
  lastMaxScroll,
  lastScrollTop,
  maxScroll,
  scrollTop,
  tolerance,
}: BottomPinStateInput): boolean {
  const grewAfterPreviousBottom = maxScroll > lastMaxScroll + 1
    && lastMaxScroll > 0
    && lastScrollTop >= lastMaxScroll - tolerance;
  // An upward movement is an explicit user request to leave the end. Check
  // this before the near-end threshold below: otherwise a small upward wheel
  // movement still looks "close enough" to the end and immediately gets
  // clamped back to maxScroll by the caller.
  if (scrollTop < lastScrollTop) return false;
  if (maxScroll > 0 && (scrollTop >= maxScroll - tolerance || grewAfterPreviousBottom)) return true;
  if (maxScroll > 0 && scrollTop < maxScroll - tolerance * 2) return false;
  return bottomPinned;
}
