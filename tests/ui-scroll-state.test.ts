import { describe, expect, test } from "bun:test";
import { nextBottomPinnedState } from "../ui/src/scroll-state.js";

describe("nextBottomPinnedState", () => {
  test("releases the bottom pin when the user scrolls up from the end", () => {
    expect(nextBottomPinnedState({
      bottomPinned: true,
      lastMaxScroll: 1_000,
      lastScrollTop: 1_000,
      maxScroll: 1_000,
      scrollTop: 999,
      tolerance: 160,
    })).toBe(false);
  });

  test("keeps the pin while virtualized content grows without user movement", () => {
    expect(nextBottomPinnedState({
      bottomPinned: true,
      lastMaxScroll: 1_000,
      lastScrollTop: 1_000,
      maxScroll: 1_200,
      scrollTop: 1_000,
      tolerance: 160,
    })).toBe(true);
  });

  test("re-pins after scrolling back down to the end", () => {
    expect(nextBottomPinnedState({
      bottomPinned: false,
      lastMaxScroll: 1_000,
      lastScrollTop: 800,
      maxScroll: 1_000,
      scrollTop: 1_000,
      tolerance: 160,
    })).toBe(true);
  });
});
