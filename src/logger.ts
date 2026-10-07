import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { todayIso } from './util/dates.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const formatContext = (context: Record<string, unknown> | undefined): string => {
  if (context === undefined) return '';
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length > 0 ? ` | ${parts.join(' ')}` : '';
};

export const createLogger = (logDir: string): Logger => {
  mkdirSync(logDir, { recursive: true });

  const write = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${formatContext(context)}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
    // One file per Turkish day, matching how the data itself is bucketed.
    const file = resolve(logDir, `tefas-${todayIso()}.log`);
    appendFileSync(file, `${line}\n`, 'utf8');
  };

  return {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
};
