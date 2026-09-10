import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const BACKQUOTE = "`";

function isInsideFencedCodeBeforeLine(document: string, lineNumber: number): boolean {
  let marker: string | undefined;
  let markerLength = 0;

  for (const line of document.split("\n").slice(0, lineNumber - 1)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;

    const currentMarker = match[1][0];
    const currentLength = match[1].length;
    if (!marker) {
      marker = currentMarker;
      markerLength = currentLength;
    } else if (currentMarker === marker && currentLength >= markerLength) {
      marker = undefined;
      markerLength = 0;
    }
  }

  return marker !== undefined;
}

function insertBackquote(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;

  const selection = state.selection.main;
  if (selection.empty) {
    const line = state.doc.lineAt(selection.head);
    const before = state.doc.sliceString(line.from, selection.head);
    const after = state.doc.sliceString(selection.head, line.to);
    const fencePrefix = before.match(/^([ \t]{0,3})``$/);

    // Treat the third physical Backquote as a fence delimiter only when the
    // cursor is at the end of a line prefix. Backticks inside an existing
    // fenced block remain literal, including a manual closing fence.
    if (
      fencePrefix
      && (after === "" || after === BACKQUOTE)
      && !isInsideFencedCodeBeforeLine(state.doc.toString(), line.number)
    ) {
      const indent = fencePrefix[1];
      const replaceTo = after === BACKQUOTE ? selection.head + 1 : selection.head;
      view.dispatch({
        changes: {
          from: selection.head,
          to: replaceTo,
          insert: `${BACKQUOTE}\n${indent}${BACKQUOTE.repeat(3)}`,
        },
        selection: { anchor: selection.head + 1 },
        userEvent: "input.type",
      });
      return true;
    }
  }

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: BACKQUOTE },
    selection: { anchor: selection.from + BACKQUOTE.length },
    userEvent: "input.type",
  });
  return true;
}

function handleBackquoteKey(event: KeyboardEvent, view: EditorView): boolean {
  // `event.code` identifies the physical key independently of the active
  // keyboard layout. Some layouts report a currency symbol as event.key for
  // the key that is Backquote on a US keyboard, which otherwise makes both
  // editors silently miss the user's intended Markdown character.
  const isBackquote = event.code === "Backquote" || event.key === BACKQUOTE;
  if (
    !isBackquote
    || event.shiftKey
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || view.state.readOnly
  ) return false;

  event.preventDefault();
  return insertBackquote(view);
}

// Highest precedence keeps Atomic Editor's closeBrackets/auto-fence handlers
// from consuming the physical key before this layout-independent path sees it.
export const markdownBackquoteKey = Prec.highest(
  EditorView.domEventHandlers({ keydown: handleBackquoteKey }),
);
