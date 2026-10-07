/**
 * TEFAS never uses HTTP status codes for domain problems - it answers 200 with an
 * `errorMessage`, or with an API-gateway `fault*` envelope. These kinds are the
 * normalised view the rest of the app reacts to.
 */
export type TefasErrorKind =
  | 'throttled'
  | 'range-too-old'
  | 'range-too-long'
  | 'http'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'unknown';

export class TefasError extends Error {
  readonly kind: TefasErrorKind;
  readonly retryable: boolean;

  constructor(kind: TefasErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = 'TefasError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

const NO_DATA_MARKERS = ['index 0 out of bounds', 'out of bounds for length 0'];

/** Weekends and public holidays surface as an array-index error, not as an empty list. */
export const isNoDataMessage = (message: string): boolean => {
  const normalised = message.toLowerCase();
  return NO_DATA_MARKERS.some((marker) => normalised.includes(marker));
};

export const classifyErrorMessage = (message: string): TefasErrorKind => {
  const normalised = message.toLocaleLowerCase('tr-TR');
  if (normalised.includes('5 yıldan eski')) return 'range-too-old';
  if (normalised.includes('1 ayı aşamaz')) return 'range-too-long';
  if (normalised.includes('throttling')) return 'throttled';
  return 'unknown';
};
