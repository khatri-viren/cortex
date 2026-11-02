/** View-only table widths. The editor owns the Markdown and may replace widgets. */
export function installTableResize(host: HTMLElement, requestMeasure: () => void): () => void {
  const widths = new Map<number, number[]>();
  let dragging: (() => void) | undefined;

  function apply(table: HTMLTableElement, values: number[]) {
    const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
    headers.forEach((cell, index) => { cell.style.width = `${values[index]}px`; });
    table.style.width = `${values.reduce((sum, width) => sum + width, 0)}px`;
    requestMeasure();
  }

  function refresh() {
    const tables = Array.from(host.querySelectorAll<HTMLTableElement>(".cm-atomic-table table"));
    tables.forEach((table, tableIndex) => {
      if (table.dataset.cortexResizeReady) return;
      const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
      if (!headers.length) return;
      table.dataset.cortexResizeReady = "true";
      let values = widths.get(tableIndex);
      if (!values || values.length !== headers.length) {
        values = headers.map((cell) => Math.max(64, Math.round(cell.getBoundingClientRect().width)));
        widths.set(tableIndex, values);
      }
      apply(table, values);
      headers.forEach((cell, index) => {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "cortex-column-resize";
        handle.setAttribute("aria-label", `Resize column ${index + 1}`);
        handle.setAttribute("title", "Drag or use arrow keys to resize column");
        handle.addEventListener("pointerdown", (event) => {
          event.preventDefault(); event.stopPropagation();
          dragging?.();
          const start = event.clientX, initial = values![index];
          const move = (next: PointerEvent) => { values![index] = Math.max(64, Math.round(initial + next.clientX - start)); apply(table, values!); };
          const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); dragging = undefined; };
          dragging = end;
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
        });
        handle.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation();
          values![index] = Math.max(64, values![index] + (event.key === "ArrowRight" ? 10 : -10));
          apply(table, values!);
        });
        cell.appendChild(handle);
      });
    });
  }
  const observer = new MutationObserver(refresh);
  observer.observe(host, { childList: true, subtree: true });
  refresh();
  return () => {
    dragging?.(); observer.disconnect();
    host.querySelectorAll<HTMLTableElement>("table[data-cortex-resize-ready]").forEach((table) => {
      delete table.dataset.cortexResizeReady;
      table.style.width = "";
      table.querySelectorAll<HTMLTableCellElement>("thead th").forEach((cell) => { cell.style.width = ""; });
    });
    host.querySelectorAll(".cortex-column-resize").forEach((node) => node.remove());
  };
}
