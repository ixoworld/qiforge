import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type {
  RequestAdmissionContext,
  RequestAdmissionResult,
} from '../plugin-api/request-admission';

export function admissionMetadata(
  json: string | undefined,
): Record<string, unknown> | undefined {
  if (!json || json.length > 16_384) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return { ...parsed };
  } catch {
    return undefined;
  }
  return undefined;
}

export async function admitRequest(
  plugins: readonly OraclePlugin[],
  context: RequestAdmissionContext,
): Promise<RequestAdmissionResult> {
  for (const plugin of plugins) {
    context.signal.throwIfAborted();
    const result = await plugin.getRequestAdmission?.(context);
    context.signal.throwIfAborted();
    if (result?.kind === 'handled') {
      if (
        !result.text.trim() ||
        !result.title.trim() ||
        result.title.length > 200 ||
        result.text.length > 100_000
      ) {
        throw new Error('Invalid direct-read response');
      }
      return result;
    }
  }
  return { kind: 'pass' };
}
