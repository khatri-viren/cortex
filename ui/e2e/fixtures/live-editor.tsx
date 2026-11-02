import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { Editor } from "../../src/Editor";
import "../../src/index.css";

// Real Cortex editor and CSS, isolated from vault persistence. Test documents
// are synthetic; the recovered private note must never become a fixture.
const root = createRoot(document.getElementById("root")!);
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <div className="note-document-scroll" style={{ height: 700, overflow: "auto" }}>
    <Editor value={value} mode="live" notePath="regression.md" onChange={setValue} />
  </div>;
}
const getView = () => EditorView.findFromDOM(document.querySelector(".cm-editor")!)!;
Object.assign(window, {
  mountEditor: (initial: string) => root.render(<Harness initial={initial} />),
  editorDocument: () => getView().state.doc.toString(),
  revealPosition: (pos: number) => getView().dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) }),
});
