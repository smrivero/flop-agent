/**
 * Shared HTTP helpers for the mentions pipeline: every outbound call (Tavily,
 * SearXNG, article fetches, OpenAI) goes through here so timeout and retry
 * behavior is defined once, per the HTTP_TIMEOUT_MS / MAX_RETRIES requirement.
 *
 * Never logs headers or bodies -- callers decide what's safe to log (e.g. never
 * an Authorization header, never an API key).
 */

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries only on network errors (fetch throwing, e.g. timeout/abort) or 5xx
 * responses -- a 4xx is the server telling us the request itself is wrong, and
 * retrying it would just repeat the same failure while burning quota.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxRetries: number },
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, options.timeoutMs);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < options.maxRetries) {
      await sleep(300 * 2 ** attempt); // 300ms, 600ms, 1200ms...
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
