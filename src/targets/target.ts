/**
 * Minimal object-store-like target contract.
 *
 * Batch renderers may use this contract to persist individual output files.
 * Implementations must reject path traversal and should make writes durable/atomic
 * where the backend supports it.
 */
export interface SyncTarget {
  write(path: string, content: Buffer | string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
