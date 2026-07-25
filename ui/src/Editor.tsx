import { useEffect, useRef } from "react";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";

type EditorProps = {
  value: string;
  mode: "source" | "reading";
  onChange: (value: string) => void;
  linkTargets?: string[];
};

export function Editor({ value, mode, onChange, linkTargets = [] }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const initialValue = useRef(value);
  const initialMode = useRef(mode);
  const linkTargetsRef = useRef(linkTargets);
  onChangeRef.current = onChange;
  linkTargetsRef.current = linkTargets;

  function wikilinkCompletions(context: CompletionContext): CompletionResult | null {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 80), context.pos);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return null;
    const query = match[1].toLocaleLowerCase();
    const from = context.pos - match[1].length;
    const options = linkTargetsRef.current
      .filter((title) => title.toLocaleLowerCase().includes(query))
      .slice(0, 20)
      .map((title) => ({ label: title, type: "text", apply: title + "]]" }));
    return { from, options };
  }

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: initialValue.current,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markdown(),
        autocompletion({ override: [wikilinkCompletions] }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        editable.current.of(EditorView.editable.of(initialMode.current === "source")),
        EditorView.theme({
          "&": { height: "100%", backgroundColor: "transparent" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)", lineHeight: "1.65" },
          ".cm-content": { padding: "24px 28px 120px" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted)", paddingLeft: "10px" },
          ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
          ".cm-activeLine": { backgroundColor: "rgba(28, 116, 101, 0.06)" },
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(mode === "source")) });
  }, [mode]);

  return <div className="editor-host" ref={host} aria-label="Markdown editor" />;
}
