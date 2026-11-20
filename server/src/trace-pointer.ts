/** A post ID identifies exactly one local capture slice, even before an owner uploads it. */
export function tracePointer(id: string) {
  return `/trace-access?entry=${encodeURIComponent(id)}`;
}
