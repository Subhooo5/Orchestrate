import { convertMoney } from '../util/money.js';
import type { ConversionRate, CurrencyCode, Money } from '../util/money.js';
import { formatDate } from '../util/dates.js';
import type { EpochDay } from '../util/dates.js';
import type { ExchangeRateRecord, FinancialEvent } from '../data/types.js';
import { ledgerDate } from './inclusion.js';

export class ExchangeRateError extends Error {}

export type ExchangeRateIndex = ReadonlyMap<string, ConversionRate>;

function rateKey(date: EpochDay, from: CurrencyCode, to: CurrencyCode): string {
  return `${date}|${from}|${to}`;
}

export function buildExchangeRateIndex(
  records: readonly ExchangeRateRecord[],
): ExchangeRateIndex {
  const index = new Map<string, ConversionRate>();
  for (const record of records) {
    const key = rateKey(record.rateDate, record.rate.from, record.rate.to);
    const existing = index.get(key);
    if (existing !== undefined && existing.scaled !== record.rate.scaled) {
      throw new ExchangeRateError(
        `conflicting exchange rates for ${formatDate(record.rateDate)} ${record.rate.from}->${record.rate.to}`,
      );
    }
    index.set(key, record.rate);
  }
  return index;
}

export function findRate(
  index: ExchangeRateIndex,
  date: EpochDay,
  from: CurrencyCode,
  to: CurrencyCode,
): ConversionRate | null {
  return index.get(rateKey(date, from, to)) ?? null;
}

export function requireRate(
  index: ExchangeRateIndex,
  date: EpochDay,
  from: CurrencyCode,
  to: CurrencyCode,
  context: string,
): ConversionRate {
  const rate = findRate(index, date, from, to);
  if (rate === null) {
    throw new ExchangeRateError(
      `${context}: no exchange rate for (${formatDate(date)}, ${from}, ${to}); ` +
        'chaining, inversion and nearest-date fallback are deliberately not implemented',
    );
  }
  return rate;
}

export function normalizeAmount(
  event: FinancialEvent,
  homeCurrency: CurrencyCode,
  index: ExchangeRateIndex,
): Money | null {
  if (event.amount === null) {
    return null;
  }
  if (event.currency === homeCurrency) {
    return event.amount;
  }
  const rate = requireRate(index, ledgerDate(event), event.currency, homeCurrency, event.eventId);
  return convertMoney(event.amount, rate);
}

export function normalizeMinimumAllowedAmount(
  event: FinancialEvent,
  homeCurrency: CurrencyCode,
  index: ExchangeRateIndex,
): Money | null {
  if (event.minimumAllowedAmount === null) {
    return null;
  }
  if (event.currency === homeCurrency) {
    return event.minimumAllowedAmount;
  }
  const rate = requireRate(index, ledgerDate(event), event.currency, homeCurrency, event.eventId);
  return convertMoney(event.minimumAllowedAmount, rate);
}
