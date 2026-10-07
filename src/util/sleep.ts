import { setTimeout as delay } from 'node:timers/promises';

export const sleep = (ms: number): Promise<void> =>
  ms > 0 ? delay(ms) : Promise.resolve();

/** Full jitter keeps parallel-ish retries from lining up on the same second. */
export const jitter = (ms: number): number => Math.round(ms * (0.5 + Math.random() * 0.5));
