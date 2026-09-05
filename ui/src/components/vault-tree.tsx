import { useMemo } from "react";
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

function TreeRow({
  node,
  depth,
  selectedPath,
  expandedPaths,
  onToggle,
  onOpen,
}: Omit<VaultTreeProps, "nodes"> & { node: ApiVaultTreeNode; depth: number }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const isExpanded = node.kind === "directory" && expandedPaths.has(node.path);
  const label = node.kind === "note" ? node.title : node.name;
  const title = node.kind === "note" ? `${node.title} · ${node.path}` : node.path;
  const activate = () => node.kind === "directory" ? onToggle(node.path) : onOpen(node);
  const icon = node.kind === "directory"
    ? (isExpanded ? <FolderOpenIcon className="size-4" /> : <FolderIcon className="size-4" />)
    : node.kind === "note"
      ? <FileTextIcon className="size-4" />
      : <FileIcon className="size-4" />;

  return (
    <div role="none">
      <div
        role="treeitem"
        data-testid={node.kind === "note" ? "note-row" : undefined}
        aria-level={depth + 1}
        aria-expanded={node.kind === "directory" ? isExpanded : undefined}
        aria-selected={node.kind !== "directory" && selectedPath === node.path}
        title={title}
        className={
          "group/tree-row flex h-7 min-w-0 items-center gap-2 rounded-[9px] px-2 text-[12px] leading-5 transition-colors " +
          (node.kind !== "directory" && selectedPath === node.path
            ? "bg-muted/90 font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted/65 hover:text-foreground") +
          (node.kind === "file" && !node.openable ? " opacity-55" : "")
        }
        style={{ paddingLeft: collapsed ? 6 : 8 + depth * 16 }}
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
            <span
              data-testid="tree-folder-icon"
              className="grid place-items-center transition-opacity duration-100 group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0"
            >
              {icon}
            </span>
            <span
              data-testid="tree-disclosure"
              className="absolute grid place-items-center opacity-0 transition-opacity duration-100 group-hover/tree-row:opacity-100 group-focus-within/tree-row:opacity-100"
            >
              {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            </span>
          </button>
        ) : (
          <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">{icon}</span>
        )}
        <span className={"min-w-0 truncate " + (collapsed ? "sr-only" : "")}>{label}</span>
        {node.kind === "file" && !node.openable && !collapsed && <span className="ml-auto text-[10px]">—</span>}
      </div>
      {node.kind === "directory" && isExpanded && !collapsed && (
        <div role="group">
          {node.children.map((child) => (
            <TreeRow key={child.path} {...{ node: child, depth: depth + 1, selectedPath, expandedPaths, onToggle, onOpen }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function VaultTree({ nodes, selectedPath, expandedPaths, onToggle, onOpen }: VaultTreeProps) {
  const visibleNodes = useMemo(() => nodes.slice().sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (left.kind !== "directory" && right.kind === "directory") return 1;
    return left.name.localeCompare(right.name);
  }), [nodes]);

  return (
    <div role="tree" aria-label="Vault files" className="grid gap-0.5">
      {visibleNodes.map((node) => (
        <TreeRow key={node.path} {...{ node, depth: 0, selectedPath, expandedPaths, onToggle, onOpen }} />
      ))}
    </div>
  );
}
