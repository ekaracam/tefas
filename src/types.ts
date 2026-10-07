export const FUND_TYPES = ['YAT', 'EMK', 'BYF'] as const;

export type FundType = (typeof FUND_TYPES)[number];

export const isFundType = (value: string): value is FundType =>
  (FUND_TYPES as readonly string[]).includes(value);

/** A half-open-free, inclusive range of ISO (yyyy-mm-dd) dates. */
export interface DateRange {
  readonly start: string;
  readonly end: string;
}

/** Raw shape returned by POST /api/funds/fonGnlBlgSiraliGetir. */
export interface TefasApiRow {
  readonly fonKodu: string | null;
  readonly fonUnvan: string | null;
  readonly tarih: string | null;
  readonly fiyat: number | null;
  readonly tedPaySayisi: number | null;
  readonly kisiSayisi: number | null;
  readonly portfoyBuyukluk: number | null;
  readonly borsaBultenFiyat: number | null;
  readonly rn: number | null;
}

export interface TefasApiResponse {
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultList: readonly TefasApiRow[] | null;
  readonly toplamSayi: number | null;
  readonly toplamSayfa: number | null;
  /** Present instead of the fields above when the API gateway rejects the call. */
  readonly faultCode?: string;
  readonly faultString?: string;
  readonly faultStatusCode?: string;
}

export interface FundDailyRecord {
  readonly fundType: FundType;
  readonly fundCode: string;
  readonly fundName: string;
  readonly date: string;
  readonly price: number | null;
  readonly shareCount: number | null;
  readonly investorCount: number | null;
  readonly totalValue: number | null;
  readonly exchangeBulletinPrice: number | null;
}

export type FetchStatus = 'success' | 'empty' | 'failed';

export interface FetchLogEntry {
  readonly fundType: FundType;
  readonly range: DateRange;
  readonly status: FetchStatus;
  readonly rowCount: number;
  readonly attempts: number;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}
