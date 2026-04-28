/**
 * Throws when a value is null/undefined.
 *
 * Used for narrowing in security-sensitive code where the alternative would
 * be silent fallthrough. Always provide a contract message describing what
 * was expected so failures surface meaningfully in audit logs.
 */
export function invariant<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`Invariant failed: ${message}`);
  }
}
