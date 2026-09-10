export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "AMBIGUOUS_SECTION"
  | "AMBIGUOUS_NOTE"
  | "AMBIGUOUS_GRAPH_NODE"
  | "SECTION_NOT_WRITABLE"
  | "GIT_DIRTY"
  | "INDEX_SYNC_FAILED"
  | "VAULT_INVALID"
  | "EXPORT_RENDERER_UNAVAILABLE"
  | "EXPORT_TOO_LARGE"
  | "EXPORT_QUEUE_FULL"
  | "EXPORT_CANCELLED"
  | "EXPORT_DEADLINE_EXCEEDED";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ServiceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.details = details;
  }
}
