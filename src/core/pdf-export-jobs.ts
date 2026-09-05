import { createHash } from "node:crypto";
import { ServiceError } from "./errors.js";
import { chromiumPdfRenderer, type MarkdownPdfInput, type PdfRenderOptions, type PdfRenderer } from "./pdf-export.js";

export const PDF_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const PDF_MAX_QUEUED_JOBS = 3;
export const PDF_DEFAULT_DEADLINE_MS = 30_000;

export type PdfExportTimings = {
  queueWaitMs: number;
  renderMs: number;
  encodeMs: number;
  deliveryMs: number;
  outputBytes: number;
  checksum: string;
  cancelled: boolean;
};

export type PdfExportArtifact = {
  pdf: Buffer;
  checksum: string;
  renderer: PdfRenderer["id"];
  timings: PdfExportTimings;
};

type Job = {
  input: MarkdownPdfInput;
  signal?: AbortSignal;
  deadlineMs: number;
  enqueuedAt: number;
  resolve: (artifact: PdfExportArtifact) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  controller?: AbortController;
  removeAbort?: () => void;
};

function now(): number {
  return performance.now();
}

function cancellationError(signal?: AbortSignal): ServiceError {
  return signal?.reason instanceof ServiceError ? signal.reason : new ServiceError("EXPORT_CANCELLED", "PDF export was cancelled.");
}

export class PdfExportJobManager {
  private readonly queue: Job[] = [];
  private active?: Job;
  private closing = false;

  constructor(private readonly renderer: PdfRenderer = chromiumPdfRenderer, private readonly maxQueuedJobs = PDF_MAX_QUEUED_JOBS) {}

  submit(input: MarkdownPdfInput, options: PdfRenderOptions = {}): Promise<PdfExportArtifact> {
    const inputBytes = Buffer.byteLength(input.body, "utf8");
    if (inputBytes > PDF_MAX_INPUT_BYTES) {
      return Promise.reject(new ServiceError("EXPORT_TOO_LARGE", `PDF export input is limited to ${PDF_MAX_INPUT_BYTES} bytes.`, { inputBytes, maxInputBytes: PDF_MAX_INPUT_BYTES }));
    }
    if (this.closing) return Promise.reject(new ServiceError("EXPORT_CANCELLED", "PDF export service is shutting down."));
    if (this.queue.length >= this.maxQueuedJobs) return Promise.reject(new ServiceError("EXPORT_QUEUE_FULL", "PDF export queue is full. Retry after the active export completes.", { maxQueuedJobs: this.maxQueuedJobs }));

    const deadlineMs = Math.max(1_000, options.deadlineMs ?? PDF_DEFAULT_DEADLINE_MS);
    return new Promise<PdfExportArtifact>((resolve, reject) => {
      const job: Job = { input, signal: options.signal, deadlineMs, enqueuedAt: now(), resolve, reject, settled: false };
      const cancelQueued = () => {
        if (job.settled) return;
        if (this.active === job) {
          job.controller?.abort(cancellationError(options.signal));
          return;
        }
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        job.settled = true;
        reject(cancellationError(options.signal));
      };
      if (options.signal?.aborted) {
        reject(cancellationError(options.signal));
        return;
      }
      options.signal?.addEventListener("abort", cancelQueued, { once: true });
      job.removeAbort = () => options.signal?.removeEventListener("abort", cancelQueued);
      this.queue.push(job);
      this.pump();
    });
  }

  close(): void {
    this.closing = true;
    const error = new ServiceError("EXPORT_CANCELLED", "PDF export service is shutting down.");
    for (const job of this.queue.splice(0)) {
      job.settled = true;
      job.removeAbort?.();
      job.reject(error);
    }
    this.active?.controller?.abort(error);
  }

  stats(): { active: boolean; queued: number; maxQueuedJobs: number; renderer: PdfRenderer["id"] } {
    return { active: Boolean(this.active), queued: this.queue.length, maxQueuedJobs: this.maxQueuedJobs, renderer: this.renderer.id };
  }

  private pump(): void {
    if (this.active || this.closing) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void this.run(job).finally(() => {
      if (this.active === job) this.active = undefined;
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    const queueWaitMs = now() - job.enqueuedAt;
    if (queueWaitMs >= job.deadlineMs) {
      job.settled = true;
      job.removeAbort?.();
      job.reject(new ServiceError("EXPORT_DEADLINE_EXCEEDED", "PDF export expired while waiting in the queue."));
      return;
    }
    const controller = new AbortController();
    job.controller = controller;
    const deadline = new ServiceError("EXPORT_DEADLINE_EXCEEDED", `PDF export exceeded its ${job.deadlineMs}ms deadline.`);
    const timer = setTimeout(() => controller.abort(deadline), Math.max(1, job.deadlineMs - queueWaitMs));
    const forwardAbort = () => controller.abort(cancellationError(job.signal));
    job.signal?.addEventListener("abort", forwardAbort, { once: true });
    const renderStarted = now();
    try {
      if (job.signal?.aborted) throw cancellationError(job.signal);
      const pdf = await this.renderer.render(job.input, { signal: controller.signal, deadlineMs: Math.max(1_000, job.deadlineMs - queueWaitMs) });
      if (pdf.length > PDF_MAX_OUTPUT_BYTES) throw new ServiceError("EXPORT_TOO_LARGE", `PDF export output is limited to ${PDF_MAX_OUTPUT_BYTES} bytes.`, { outputBytes: pdf.length, maxOutputBytes: PDF_MAX_OUTPUT_BYTES });
      const renderMs = now() - renderStarted;
      const encodeStarted = now();
      const checksum = createHash("sha256").update(pdf).digest("hex");
      const encodeMs = now() - encodeStarted;
      job.settled = true;
      job.removeAbort?.();
      job.resolve({ pdf, checksum, renderer: this.renderer.id, timings: { queueWaitMs, renderMs, encodeMs, deliveryMs: 0, outputBytes: pdf.length, checksum, cancelled: false } });
    } catch (error) {
      job.settled = true;
      job.removeAbort?.();
      job.reject(error);
    } finally {
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", forwardAbort);
      job.controller = undefined;
    }
  }
}
