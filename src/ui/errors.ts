export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate) return candidate;
      if (candidate && typeof candidate === "object") {
        const nested = errorMessage(candidate);
        if (nested) return nested;
      }
    }
    try { return JSON.stringify(error); } catch { /* fall through */ }
  }
  return String(error);
}
