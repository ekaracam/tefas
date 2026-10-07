import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { DateRange, FundType, TefasApiResponse, TefasApiRow } from '../types.js';
import { toApiDate } from '../util/dates.js';
import { jitter, sleep } from '../util/sleep.js';
import { classifyErrorMessage, isNoDataMessage, TefasError } from './errors.js';

export interface TefasClientOptions {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly pageSize: number;
  readonly timeoutMs: number;
  readonly requestDelayMs: number;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly throttleCooldownMs: number;
  readonly logger: Logger;
}

export interface FetchResult {
  readonly rows: readonly TefasApiRow[];
  readonly attempts: number;
  /** True when TEFAS confirmed the range holds no data (weekend, holiday, pre-launch). */
  readonly empty: boolean;
}

const buildPayload = (fundType: FundType, range: DateRange, pageSize: number): string =>
  JSON.stringify({
    fonTipi: fundType,
    fonKodu: null,
    aramaMetni: null,
    fonTurKod: null,
    fonGrubu: null,
    sfonTurKod: null,
    basTarih: toApiDate(range.start),
    bitTarih: toApiDate(range.end),
    basSira: 1,
    bitSira: pageSize,
    fonTurAciklama: null,
    dil: 'TR',
    kurucuKod: null,
  });

/** Ceiling for the adaptive inter-request delay. */
const MAX_ADAPTIVE_DELAY_MS = 60_000;

export class TefasClient {
  readonly #options: TefasClientOptions;
  #nextRequestAt = 0;
  #currentDelayMs: number;

  constructor(options: TefasClientOptions) {
    this.#options = options;
    this.#currentDelayMs = options.requestDelayMs;
  }

  /** Serialises requests so the current delay is honoured across all callers. */
  async #throttle(): Promise<void> {
    const waitMs = this.#nextRequestAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    this.#nextRequestAt = Date.now() + this.#currentDelayMs;
  }

  /**
   * TEFAS throttles on sustained volume, so retrying the failed call alone just
   * walks back into the limit. Back the whole run off on a 429 and ease down
   * again over the following successes.
   */
  #onThrottled(): void {
    const previous = this.#currentDelayMs;
    this.#currentDelayMs = Math.min(
      MAX_ADAPTIVE_DELAY_MS,
      Math.max(this.#options.requestDelayMs, previous * 2, 5_000),
    );
    if (this.#currentDelayMs !== previous) {
      this.#options.logger.warn('Hız sınırı sonrası yavaşlanıyor', {
        eskiMs: previous,
        yeniMs: this.#currentDelayMs,
      });
    }
  }

  #onSuccess(): void {
    if (this.#currentDelayMs > this.#options.requestDelayMs) {
      this.#currentDelayMs = Math.max(
        this.#options.requestDelayMs,
        Math.round(this.#currentDelayMs * 0.8),
      );
    }
  }

  async #requestOnce(fundType: FundType, range: DateRange): Promise<readonly TefasApiRow[] | null> {
    await this.#throttle();

    let response: Response;
    try {
      response = await fetch(this.#options.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.#options.apiToken ? { Authorization: `Bearer ${this.#options.apiToken}` } : {}),
          'x-request-id': randomUUID(),
          Accept: 'application/json',
          'User-Agent': 'tefas-crawler/1.0 (+local data archive)',
        },
        body: buildPayload(fundType, range, this.#options.pageSize),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (cause) {
      const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
      throw new TefasError(
        isTimeout ? 'timeout' : 'network',
        `${fundType} ${range.start}..${range.end} isteği başarısız: ${String(cause)}`,
        true,
      );
    }

    if (response.status === 429) {
      throw new TefasError('throttled', 'TEFAS hız sınırına takıldı (HTTP 429)', true);
    }
    if (!response.ok) {
      throw new TefasError('http', `TEFAS HTTP ${response.status} döndürdü`, response.status >= 500);
    }

    let body: TefasApiResponse;
    try {
      body = (await response.json()) as TefasApiResponse;
    } catch (cause) {
      // The fetch signal also aborts body streaming, so a stalled 10 MB download
      // surfaces here rather than at the fetch call.
      const aborted =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new TefasError(
        aborted ? 'timeout' : 'malformed',
        aborted
          ? `${fundType} ${range.start}..${range.end} indirilirken zaman aşımı`
          : `TEFAS cevabı çözümlenemedi: ${String(cause)}`,
        true,
      );
    }

    if (typeof body.faultString === 'string') {
      const kind = body.faultCode === 'ERR-224' ? 'throttled' : 'http';
      throw new TefasError(kind, `TEFAS ağ geçidi hatası ${body.faultCode ?? '?'}: ${body.faultString}`, true);
    }

    if (typeof body.errorMessage === 'string' && body.errorMessage !== '') {
      if (isNoDataMessage(body.errorMessage)) return null;
      const kind = classifyErrorMessage(body.errorMessage);
      const retryable = kind === 'throttled' || kind === 'unknown';
      throw new TefasError(kind, `TEFAS sorguyu reddetti: ${body.errorMessage}`, retryable);
    }

    if (body.resultList === null || body.resultList === undefined) return null;

    if (body.toplamSayi !== null && body.toplamSayi > body.resultList.length) {
      // Should not happen while pageSize covers a full month, but silently losing
      // rows would be worse than failing loudly.
      throw new TefasError(
        'malformed',
        `Eksik sayfa: ${body.toplamSayi} satırın ${body.resultList.length} tanesi geldi. TEFAS_PAGE_SIZE değerini artırın.`,
        false,
      );
    }

    return body.resultList;
  }

  async fetchRange(fundType: FundType, range: DateRange): Promise<FetchResult> {
    const { maxRetries, retryBaseMs, throttleCooldownMs, logger } = this.#options;
    let lastError: TefasError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        const rows = await this.#requestOnce(fundType, range);
        this.#onSuccess();
        return { rows: rows ?? [], attempts: attempt, empty: rows === null };
      } catch (cause) {
        const error =
          cause instanceof TefasError
            ? cause
            : new TefasError('unknown', String(cause), false);
        lastError = error;
        if (error.kind === 'throttled') this.#onThrottled();

        if (!error.retryable || attempt > maxRetries) break;

        const base = error.kind === 'throttled' ? throttleCooldownMs : retryBaseMs;
        const backoffMs = jitter(base * 2 ** (attempt - 1));
        logger.warn('TEFAS isteği yeniden deneniyor', {
          fonTuru: fundType,
          donem: `${range.start}..${range.end}`,
          deneme: attempt,
          tur: error.kind,
          beklemeMs: backoffMs,
          sebep: error.message,
        });
        await sleep(backoffMs);
      }
    }

    throw lastError ?? new TefasError('unknown', 'İstek hatasız şekilde başarısız oldu', false);
  }
}
