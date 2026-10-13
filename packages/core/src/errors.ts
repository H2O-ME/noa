/**
 * Error → message string in one step. Node/fetch/JSON.parse rejections are not
 * always Error instances (strings, DOMException-like objects from some runtimes,
 * or anything a hostile await target throws), and every user-facing error line
 * used to re-inline the same `err instanceof Error ? err.message : String(err)`
 * dance 38 times across five packages.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
