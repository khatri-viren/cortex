import { useEffect, useRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ApiSection } from "../../../src/api/contracts";

const WIDTH_BY_LEVEL: Record<number, number> = { 1: 22, 2: 15 };

type SectionOutlineProps = {
  sections: ApiSection[];
  activeIndex: number;
  onJump: (section: ApiSection, index: number) => void;
};

// Minimal tick-mark outline: no labels shown by default, one dash per
// heading (width signals level, brightness signals current position).
// Hover reveals the heading text; click jumps the reading pane there. A
// zero-height sticky anchor keeps the overflowing tick stack centered in the
// visible workspace while the document itself scrolls underneath it.
export function SectionOutline({ sections, activeIndex, onJump }: SectionOutlineProps) {
  const anchorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const anchorElement = anchorRef.current;
    if (!anchorElement) return;
    const rootElement = anchorElement.parentElement;
    if (!rootElement) return;
    const viewportElement = rootElement.closest<HTMLElement>(".note-document-scroll");
    if (!viewportElement) return;
    const anchor: HTMLElement = anchorElement;
    const root: HTMLElement = rootElement;
    const viewport: HTMLElement = viewportElement;

    let frame = 0;
    function updatePosition() {
      frame = 0;
      const reader = root.querySelector<HTMLElement>(".cm-scroller");
      if (!reader) return;

      const readerRect = reader.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const visibleTop = Math.max(readerRect.top, viewportRect.top);
      const visibleBottom = Math.min(readerRect.bottom, viewportRect.bottom);
      const visible = visibleBottom > visibleTop;
      anchor.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;

      const rootRect = root.getBoundingClientRect();
      anchor.style.top = `${(visibleTop + visibleBottom) / 2 - rootRect.top}px`;
    }

    function schedulePosition() {
      if (frame) return;
      frame = requestAnimationFrame(updatePosition);
    }

    viewport.addEventListener("scroll", schedulePosition);
    window.addEventListener("resize", schedulePosition);
    // The editor's virtualized DOM changes frequently while scrolling. A
    // MutationObserver would schedule a layout read for every mounted line;
    // resize and viewport events are sufficient to keep the rail aligned and
    // avoid turning typing/scrolling into a mutation storm.
    const observer = new ResizeObserver(schedulePosition);
    observer.observe(root);
    observer.observe(viewport);
    schedulePosition();

    return () => {
      viewport.removeEventListener("scroll", schedulePosition);
      window.removeEventListener("resize", schedulePosition);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sections.length]);

  if (sections.length < 2) return null;

  return (
    <nav
      ref={anchorRef}
      aria-label="Section outline"
      className="absolute top-1/2 right-0 z-10 h-0 w-10"
    >
      <div data-testid="outline-stack" className="absolute inset-x-0 top-0 flex max-h-[80vh] -translate-y-1/2 flex-col items-end justify-center gap-1 overflow-y-auto py-4 pr-3 pl-1">
        {sections.map((section, index) => {
          const active = index === activeIndex;
          return (
            <Tooltip key={section.startLine + ":" + index}>
              <TooltipTrigger
                data-testid="outline-tick"
                aria-label={section.heading}
                aria-current={active}
                onClick={() => onJump(section, index)}
                className="group flex h-2.5 shrink-0 items-center justify-end px-0.5"
              >
                <span
                  className={cn(
                    "block h-[3px] shrink-0 origin-right rounded-full transition-all duration-150 ease-out group-hover:scale-x-125",
                    active
                      ? "bg-foreground"
                      : "bg-muted-foreground/40 group-hover:bg-foreground",
                  )}
                  style={{ width: (WIDTH_BY_LEVEL[section.level] ?? 9) + (active ? 4 : 0) }}
                />
              </TooltipTrigger>
              <TooltipContent side="left">{section.heading}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
}
