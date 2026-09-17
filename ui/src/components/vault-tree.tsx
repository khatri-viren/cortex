import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { ApiVaultTreeNode } from "../../../src/api/contracts";
import { useSidebar } from "@/components/ui/sidebar";

type VaultTreeProps = {
  nodes: ApiVaultTreeNode[];
  selectedPath?: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (node: Extract<ApiVaultTreeNode, { kind: "note" | "file" }>) => void;
};

type FlatTreeRow = { node: ApiVaultTreeNode; depth: number };
const ROW_HEIGHT = 36;
const OVERSCAN = 12;

function sortedNodes(nodes: ApiVaultTreeNode[]): ApiVaultTreeNode[] {
  return nodes.slice().sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (left.kind !== "directory" && right.kind === "directory") return 1;
    return left.name.localeCompare(right.name);
  });
}

function flattenVisible(nodes: ApiVaultTreeNode[], expandedPaths: Set<string>, collapsed: boolean): FlatTreeRow[] {
  const result: FlatTreeRow[] = [];
  const visit = (entries: ApiVaultTreeNode[], depth: number) => {
    for (const node of sortedNodes(entries)) {
      result.push({ node, depth });
      if (!collapsed && node.kind === "directory" && expandedPaths.has(node.path)) visit(node.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return result;
}

function TreeRow({ node, depth, selectedPath, expandedPaths, onToggle, onOpen }: Omit<VaultTreeProps, "nodes"> & { node: ApiVaultTreeNode; depth: number }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const isExpanded = node.kind === "directory" && expandedPaths.has(node.path);
  const label = node.kind === "note" ? node.title : node.name;
  const title = node.kind === "note" ? `${node.title} · ${node.path}` : node.path;
  const activate = () => node.kind === "directory" ? onToggle(node.path) : onOpen(node);
  const icon = node.kind === "directory"
    ? (isExpanded ? <FolderOpenIcon className="size-4" /> : <FolderIcon className="size-4" />)
    : node.kind === "note" ? <FileTextIcon className="size-4" /> : <FileIcon className="size-4" />;

  return (
    <div
      role="treeitem"
      data-testid={node.kind === "note" ? "note-row" : undefined}
      aria-level={depth + 1}
      aria-expanded={node.kind === "directory" ? isExpanded : undefined}
      aria-selected={node.kind !== "directory" && selectedPath === node.path}
      title={title}
      className={
        "group/tree-row flex h-8 min-w-0 items-center gap-2 rounded-[9px] px-2 text-[13px] leading-5 transition-colors " +
        (collapsed ? "justify-center gap-0 px-0 " : "") +
        (node.kind !== "directory" && selectedPath === node.path
          ? "bg-muted/90 font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/65 hover:text-foreground") +
        (node.kind === "file" && !node.openable ? " opacity-55" : "")
      }
      style={{ paddingLeft: collapsed ? 0 : 8 + depth * 16 }}
      tabIndex={node.kind === "directory" ? -1 : 0}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      {node.kind === "directory" ? (
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
          className="relative grid size-4 shrink-0 place-items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.path);
          }}
        >
          <span data-testid="tree-folder-icon" className="grid place-items-center transition-opacity duration-100 group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0">{icon}</span>
          <span data-testid="tree-disclosure" className="absolute grid place-items-center opacity-0 transition-opacity duration-100 group-hover/tree-row:opacity-100 group-focus-within/tree-row:opacity-100">
            {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </span>
        </button>
      ) : <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">{icon}</span>}
      <span className={"min-w-0 truncate " + (collapsed ? "sr-only" : "")}>{label}</span>
      {node.kind === "file" && !node.openable && !collapsed && <span className="ml-auto text-[10px]">—</span>}
    </div>
  );
}

export function VaultTree({ nodes, selectedPath, expandedPaths, onToggle, onOpen }: VaultTreeProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const rows = useMemo(() => flattenVisible(nodes, expandedPaths, collapsed), [nodes, expandedPaths, collapsed]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewport({ height: element.clientHeight, scrollTop: element.scrollTop });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil((viewport.height || 560) / ROW_HEIGHT) + OVERSCAN * 2;
  const visibleRows = rows.slice(first, first + visibleCount);

  return (
    <div ref={viewportRef} role="tree" aria-label="Vault files" className="min-h-0 h-full overflow-auto overscroll-contain">
      <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
        {visibleRows.map(({ node, depth }, index) => (
          <div key={node.path} className="absolute inset-x-0 h-8" style={{ top: (first + index) * ROW_HEIGHT }}>
            <TreeRow {...{ node, depth, selectedPath, expandedPaths, onToggle, onOpen }} />
          </div>
        ))}
      </div>
    </div>
  );
}
