/**
 * JSON request utility for API calls
 * @param url - The URL to fetch
 * @param options - Request options
 * @returns Promise resolving to parsed JSON data
 */
type RequestOptions = RequestInit & {
  timeout?: number;
  apiKey?: string;
};

export const request = async <T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  options: RequestOptions = {},
): Promise<T> => {
  const {
    timeout = 120000, // 2 minutes
    apiKey,
    ...fetchOptions
  } = options;

  // Set up timeout controller
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    });

    // Clear timeout since request completed
    clearTimeout(timeoutId);

    // Handle error responses
    if (!response.ok) {
      const errorData = (await response.json()) as {
        error: string;
        outstandingClaims?: string[];
        message: string;
        statusCode: number;
        code?: unknown;
        retryable?: unknown;
        details?: unknown;
        refused?: unknown;
        requestId?: unknown;
      };

      throw new RequestError(errorData.message, {
        // Not every refusal repeats its status in the body.
        status: errorData.statusCode ?? response.status,
        error: errorData.error,
        message: errorData.message,
        outstandingClaims: errorData.outstandingClaims,
        // Machine-readable reason and retry hint, when the runtime sends them
        // (e.g. anonymous feedback's `FEEDBACK_IN_FLIGHT`).
        ...(typeof errorData.code === 'string' && { code: errorData.code }),
        ...(typeof errorData.retryable === 'boolean' && {
          retryable: errorData.retryable,
        }),
        // A turn a plugin gate refused (`refused: true`): never a credential
        // refusal; its `details` (call to action, retry delay) and request
        // id ride along for the caller.
        ...(errorData.refused === true && { refused: true }),
        ...(isRecord(errorData.details) && { details: errorData.details }),
        ...(typeof errorData.requestId === 'string' && {
          requestId: errorData.requestId,
        }),
      });
    }

    // Parse and return JSON
    return (await response.json()) as T;
  } catch (error) {
    clearTimeout(timeoutId);
    // Re-throw AbortError with timeout message
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
};

export default request;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RequestError extends Error {
  status?: number;
  outstandingClaims?: string[];
  /** The runtime's machine-readable error code, when it sends one. */
  code?: string;
  /** Whether repeating the same request can succeed, when the runtime says. */
  retryable?: boolean;
  /**
   * `true` when one of the oracle's plugin gates refused the turn (e.g. out
   * of credits): never a credential problem, whatever `status` is; show
   * `message` (and `details`) instead of asking the user to sign in again.
   */
  refused?: boolean;
  /** The refusal's JSON details (`retryAfterSeconds`, `action`, …), when sent. */
  details?: Record<string, unknown>;
  [key: string]: unknown;

  constructor(message: string, errorProps?: Record<string, unknown>) {
    super(message);
    this.name = 'RequestError';

    // Add all properties from errorProps to the error instance
    if (errorProps) {
      Object.assign(this, errorProps);
    }
  }

  static isRequestError(error: unknown): error is RequestError {
    return error instanceof RequestError;
  }
}

export { RequestError };
