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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A JsonRpcProvider that survives a rate-limited RPC (Infura, Alchemy free tiers). ethers already
 * retries an HTTP 429, but a provider may instead answer a batch with HTTP 200 and rate-limit
 * individual entries, sometimes as a bare error object with no id; ethers then reports "missing
 * response for request" and fails the call. This provider resends only the requests whose answer
 * was rate-limited or missing, backing off exponentially, and leaves every other answer, errors
 * included, to ethers. Batches are capped at 10 requests (ethers' default is 100) so one burst
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
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retry.maxRetries;
      let replies: unknown[];
      try {
        replies = await super._send(pending.length === 1 ? pending[0]! : pending);
      } catch (e) {
        if (last || !isRateLimitError(e)) throw e;
        await sleep(this.backoff(attempt));
        continue;
      }
      for (const r of replies) {
        const id = (r as { id?: unknown })?.id;
        if (typeof id !== 'number') continue; // a bare error with no id answers nothing
        if (isRateLimited(r) && !last) continue;
        answered.set(id, r as Reply);
      }
      pending = pending.filter((p) => !answered.has(p.id));
      // Unanswered requests are resent only when the reply showed a rate limit; out of retries, or
      // from a provider that drops entries for another reason, ethers reports them as it would have.
      if (pending.length === 0 || last || !replies.some(isRateLimited)) break;
      await sleep(this.backoff(attempt));
    }
    return all.map((p) => answered.get(p.id)).filter((r): r is Reply => r !== undefined) as JsonRpcResult[];
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
    return exp / 2 + Math.random() * (exp / 2);
  }
}
