/** Implemented by the user's SQLite working copy; never shared across users. */
export interface HarnessStore {
  recordDomainContext?(
    requestId: string,
    sessionId: string,
    report: unknown,
  ): Promise<void>;
  recordUsage?(
    requestId: string,
    sessionId: string,
    usage: unknown,
  ): Promise<void>;
  startOperation(
    sessionId: string,
    key: string,
    operationId: string,
  ): Promise<boolean>;
  completeOperation(operationId: string): Promise<void>;
  putResult(sessionId: string, content: string): Promise<string>;
  readResult(
    sessionId: string,
    id: string,
    offset: number,
  ): Promise<string | null>;
}

export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalArguments).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export async function operationKey(
  name: string,
  args: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${name}:${canonicalArguments(args)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
