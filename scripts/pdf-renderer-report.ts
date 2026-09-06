import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pdfRendererExecutablePath, pdfRendererInfo } from "../src/core/pdf-export.js";

function bytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce((total, entry) => total + bytes(join(path, entry)), 0);
}

const uiDist = resolve("ui/dist");
const executable = pdfRendererExecutablePath();
const rendererPackage = executable?.includes(".app/") ? executable.slice(0, executable.indexOf(".app/") + 4) : executable;
const report = {
  generatedAt: new Date().toISOString(),
  renderer: pdfRendererInfo(),
  baseApp: { path: uiDist, bytes: bytes(uiDist) },
  rendererBinary: { path: executable ?? null, bytes: executable ? bytes(executable) : 0 },
  rendererPackage: { path: rendererPackage ?? null, bytes: rendererPackage ? bytes(rendererPackage) : 0 },
  offline: true,
  decision: "Chromium adapter retained behind PdfRenderer seam; no network resources are required during rendering.",
};
console.log(JSON.stringify(report, null, 2));
