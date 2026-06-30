/**
 * Value model for the CSE-link Java string resolver.
 *
 * Two states:
 *   - Known(value): the expression has a statically determined string value.
 *   - Unknown: the value cannot be determined statically (dynamic, divergent
 *     control flow, unsupported expression, cycle, etc.).
 *
 * The resolver uses a set-based lattice internally when merging reaching
 * definitions: multiple defs producing the same string collapse to one
 * Known; defs producing different strings become Unknown.
 */

export interface KnownValue {
  readonly kind: 'known';
  readonly value: string;
}

export interface UnknownValue {
  readonly kind: 'unknown';
}

export type ResolvedValue = KnownValue | UnknownValue;

export function known(value: string): KnownValue {
  return { kind: 'known', value };
}

export function unknown(): UnknownValue {
  return { kind: 'unknown' };
}

export function isKnown(v: ResolvedValue): v is KnownValue {
  return v.kind === 'known';
}

/**
 * Merge two resolved values:
 *   - Both known with same value → known (that value)
 *   - Both known with different values → unknown
 *   - Either unknown → unknown
 */
export function mergeValues(a: ResolvedValue, b: ResolvedValue): ResolvedValue {
  if (a.kind === 'unknown' || b.kind === 'unknown') return unknown();
  return a.value === b.value ? a : unknown();
}

/**
 * Merge a set of resolved values. Returns known only when all values are
 * known AND identical.
 */
export function mergeAllValues(values: readonly ResolvedValue[]): ResolvedValue {
  if (values.length === 0) return unknown();
  let result: ResolvedValue = values[0]!;
  for (let i = 1; i < values.length; i++) {
    result = mergeValues(result, values[i]!);
  }
  return result;
}
