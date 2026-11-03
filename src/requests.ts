// Coalesce only in-flight read-only discovery, never plans or real actions.
const pending = new Map<string, Promise<unknown>>();
export function coalesce<T>(key: string, read: () => Promise<T>): Promise<T> {
  const previous = pending.get(key);
  if (previous) return previous as Promise<T>;
  const request = read().finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}
export class LatestRequest {
  private sequence = 0;
  begin() {
    const id = ++this.sequence;
    return () => id === this.sequence;
  }
  invalidate() {
    this.sequence++;
  }
}
