import {
  JsonRpcProvider,
  type JsonRpcApiProviderOptions,
  type JsonRpcError,
  type JsonRpcPayload,
  type JsonRpcResult,
  type Networkish
} from 'ethers';

export interface RetryOptions {
  /** Retries per request after the first attempt. Default 8. */
  maxRetries?: number;
  /** First backoff in ms; doubles per retry, with jitter, up to maxDelayMs. Default 500. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 15000. */
  maxDelayMs?: number;
}

type Reply = JsonRpcResult | JsonRpcError;

/** Rate-limit codes: EIP-1474 "limit exceeded" (Infura's "Too Many Requests") and HTTP 429. */
const RATE_LIMIT_CODES = new Set([-32005, 429]);

const isRateLimited = (r: unknown): boolean => {
  if (r === null || typeof r !== 'object') return false;
  const o = r as { code?: unknown; error?: { code?: unknown } };
  return RATE_LIMIT_CODES.has(Number(o.error?.code ?? o.code));
};

/** A thrown send error that is a rate limit: ethers surfaces HTTP 429 (after its own retries) as SERVER_ERROR. */
const isRateLimitError = (e: unknown): boolean => {
  const o = e as { code?: unknown; response?: { statusCode?: unknown }; info?: { responseStatus?: unknown } };
  const status = o?.info?.responseStatus;
  return o?.response?.statusCode === 429 || (typeof status === 'string' && status.startsWith('429')) || isRateLimited(e);
};

/**
 * Failures before the request left the machine (DNS, connection refused): resending cannot
 * duplicate anything. A reset or timeout after connecting is not retried here, since the node may
 * already have accepted the request.
 */
const UNSENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const isUnsentError = (e: unknown): boolean => {
  for (let o = e as { code?: unknown; cause?: unknown; error?: unknown } | undefined, d = 0; o && d < 4; o = (o.cause ?? o.error) as typeof o, d++) {
    if (typeof o.code === 'string' && UNSENT_CODES.has(o.code)) return true;
  }
  return false;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A JsonRpcProvider that survives a rate-limited RPC (Infura, Alchemy free tiers). ethers already
 * retries an HTTP 429, but a provider may instead answer a batch with HTTP 200 and rate-limit
 * individual entries, sometimes as a bare error object with no id; ethers then reports "missing
 * response for request" and fails the call. This provider resends only the requests whose answer
 * was rate-limited or missing, backing off exponentially, and leaves every other answer, errors
 * included, to ethers. A request that never left the machine (a DNS failure, a refused connection)
 * is retried the same way, so a resolver blip does not fail a long-running caller. Batches are capped at 10 requests (ethers' default is 100) so one burst
 * does not trip a per-second limit.
 */
export class RetryingJsonRpcProvider extends JsonRpcProvider {
  private readonly retry: Required<RetryOptions>;

  constructor(url: string, network?: Networkish, options: JsonRpcApiProviderOptions & RetryOptions = {}) {
    const { maxRetries, baseDelayMs, maxDelayMs, ...rest } = options;
    super(url, network, { batchMaxCount: 10, ...rest });
    this.retry = { maxRetries: maxRetries ?? 8, baseDelayMs: baseDelayMs ?? 500, maxDelayMs: maxDelayMs ?? 15_000 };
  }

  // ethers declares JsonRpcResult[] but passes error entries through too; so does this override.
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const all = Array.isArray(payload) ? payload : [payload];
    const answered = new Map<number, Reply>();
    let pending = all;
    let limit: { code?: unknown; message?: unknown; data?: unknown } | undefined;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retry.maxRetries;
      let replies: unknown[];
      try {
        replies = await super._send(pending.length === 1 ? pending[0]! : pending);
      } catch (e) {
        if (last || !(isRateLimitError(e) || isUnsentError(e))) throw e;
        await sleep(this.backoff(attempt));
        continue;
      }
      for (const r of replies) {
        if (isRateLimited(r)) limit = ((r as { error?: object }).error ?? r) as typeof limit;
        const id = (r as { id?: unknown })?.id;
        if (typeof id !== 'number') continue; // a bare error with no id answers nothing
        if (isRateLimited(r) && !last) continue;
        answered.set(id, r as Reply);
      }
      pending = pending.filter((p) => !answered.has(p.id));
      // Unanswered requests are resent only when the reply showed a rate limit; out of retries, or
      // from a provider that drops entries for another reason, ethers reports them as it would have.
      if (pending.length === 0 || !replies.some(isRateLimited)) break;
      if (last) {
        // Still rate-limited after every retry: answer with the provider's own error, not ethers'
        // "missing response", so the caller sees why (a per-second burst or an exhausted quota).
        const reason = typeof limit?.message === 'string' ? limit.message : 'Too Many Requests';
        const error = { code: Number(limit?.code ?? -32005), message: `rate limited after ${this.retry.maxRetries} retries: ${reason}`, data: limit?.data };
        for (const p of pending) answered.set(p.id, { id: p.id, error });
        break;
      }
      await sleep(this.backoff(attempt));
    }
    return all.map((p) => answered.get(p.id)).filter((r): r is Reply => r !== undefined) as JsonRpcResult[];
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
    return exp / 2 + Math.random() * (exp / 2);
  }
}
