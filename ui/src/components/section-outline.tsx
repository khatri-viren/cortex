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
// Hover reveals the heading text; click jumps the reading pane there.
export function SectionOutline({ sections, activeIndex, onJump }: SectionOutlineProps) {
  if (sections.length < 2) return null;

  return (
    <nav
      aria-label="Section outline"
      className="flex h-full w-10 shrink-0 flex-col items-end justify-center gap-1 overflow-y-auto py-4 pr-3 pl-1"
    >
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
    </nav>
  );
}
