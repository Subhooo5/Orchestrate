export const CURRENCY_CODES = ['INR', 'ZAR', 'IDR', 'USD', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const MINOR_DIGITS = 2;
export const MINOR_FACTOR = 100n;
export const RATE_DIGITS = 6;
export const RATE_FACTOR = 1_000_000n;
export const ROUNDING_RULE = 'half_up_away_from_zero_to_minor_unit';

export type Minor = bigint & { readonly __minorUnits: unique symbol };

export interface Money {
  readonly minor: Minor;
  readonly currency: CurrencyCode;
}

export interface ConversionRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly scaled: bigint;
}

export class MoneyError extends Error {}

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

function asMinor(value: bigint): Minor {
  return value as Minor;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyError('division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = absolute(numerator);
  const absDenominator = absolute(denominator);
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function scaledFromDecimalString(text: string, digits: number): bigint {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new MoneyError(`invalid decimal literal: "${text}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = unsigned.indexOf('.');
  const wholeText = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fractionText = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);
  const factor = 10n ** BigInt(digits);
  const whole = BigInt(wholeText) * factor;
  let value: bigint;
  if (fractionText.length <= digits) {
    const padded = fractionText.padEnd(digits, '0');
    value = whole + (padded.length === 0 ? 0n : BigInt(padded));
  } else {
    const kept = fractionText.slice(0, digits);
    const dropped = fractionText.slice(digits);
    const truncated = whole + (kept.length === 0 ? 0n : BigInt(kept));
    const halfway = '5'.padEnd(dropped.length, '0');
    value = BigInt(dropped) >= BigInt(halfway) ? truncated + 1n : truncated;
  }
  return negative ? -value : value;
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return (CURRENCY_CODES as readonly string[]).includes(value);
}

export function money(minorUnits: bigint, currency: CurrencyCode): Money {
  return { minor: asMinor(minorUnits), currency };
}

export function zeroMoney(currency: CurrencyCode): Money {
  return money(0n, currency);
}

export function parseMoney(text: string, currency: CurrencyCode): Money {
  return money(scaledFromDecimalString(text, MINOR_DIGITS), currency);
}

export function parseOptionalMoney(text: string, currency: CurrencyCode): Money | null {
  return text.trim().length === 0 ? null : parseMoney(text, currency);
}

export function parseRate(text: string, from: CurrencyCode, to: CurrencyCode): ConversionRate {
  return { from, to, scaled: scaledFromDecimalString(text, RATE_DIGITS) };
}

function requireSameCurrency(left: Money, right: Money): CurrencyCode {
  if (left.currency !== right.currency) {
    throw new MoneyError(`currency mismatch: ${left.currency} and ${right.currency}`);
  }
  return left.currency;
}

export function addMoney(left: Money, right: Money): Money {
  return money(left.minor + right.minor, requireSameCurrency(left, right));
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  let total = 0n;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new MoneyError(`currency mismatch: ${value.currency} and ${currency}`);
    }
    total += value.minor;
  }
  return money(total, currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  return money(left.minor - right.minor, requireSameCurrency(left, right));
}

export function negateMoney(value: Money): Money {
  return money(-value.minor, value.currency);
}

export function absoluteMoney(value: Money): Money {
  return money(absolute(value.minor), value.currency);
}

export function multiplyMoneyByCount(value: Money, count: number | bigint): Money {
  const factor = typeof count === 'bigint' ? count : BigInt(count);
  if (typeof count === 'number' && !Number.isInteger(count)) {
    throw new MoneyError(`count must be an integer: ${count}`);
  }
  return money(value.minor * factor, value.currency);
}

export function multiplyMoneyByRatio(
  value: Money,
  numerator: bigint,
  denominator: bigint,
): Money {
  return money(divideRounded(value.minor * numerator, denominator), value.currency);
}

export function compareMoney(left: Money, right: Money): number {
  requireSameCurrency(left, right);
  if (left.minor < right.minor) {
    return -1;
  }
  return left.minor > right.minor ? 1 : 0;
}

export function minMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) <= 0 ? left : right;
}

export function maxMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) >= 0 ? left : right;
}

export function clampMoney(value: Money, lower: Money, upper: Money): Money {
  return minMoney(maxMoney(value, lower), upper);
}

export function isZeroMoney(value: Money): boolean {
  return value.minor === 0n;
}

export function isNegativeMoney(value: Money): boolean {
  return value.minor < 0n;
}

export function isPositiveMoney(value: Money): boolean {
  return value.minor > 0n;
}

export function convertMoney(value: Money, rate: ConversionRate): Money {
  if (value.currency !== rate.from) {
    throw new MoneyError(`rate ${rate.from}->${rate.to} cannot convert ${value.currency}`);
  }
  return money(divideRounded(value.minor * rate.scaled, RATE_FACTOR), rate.to);
}

export function conversionIsExact(value: Money, rate: ConversionRate): boolean {
  return (value.minor * rate.scaled) % RATE_FACTOR === 0n;
}

function splitMinor(value: Money): { sign: string; whole: bigint; fraction: bigint } {
  const sign = value.minor < 0n ? '-' : '';
  const magnitude = absolute(value.minor);
  return { sign, whole: magnitude / MINOR_FACTOR, fraction: magnitude % MINOR_FACTOR };
}

export function formatMinimalAmount(value: Money): string {
  const { sign, whole, fraction } = splitMinor(value);
  if (fraction === 0n) {
    return `${sign}${whole}`;
  }
  if (fraction % 10n === 0n) {
    return `${sign}${whole}.${fraction / 10n}`;
  }
  return `${sign}${whole}.${fraction.toString().padStart(MINOR_DIGITS, '0')}`;
}

export function formatPlanAmount(value: Money): string {
  const { sign, whole, fraction } = splitMinor(value);
  if (fraction === 0n) {
    return `${sign}${whole}`;
  }
  return `${sign}${whole}.${fraction.toString().padStart(MINOR_DIGITS, '0')}`;
}

export function formatRate(rate: ConversionRate): string {
  const sign = rate.scaled < 0n ? '-' : '';
  const magnitude = absolute(rate.scaled);
  const whole = magnitude / RATE_FACTOR;
  const fraction = magnitude % RATE_FACTOR;
  if (fraction === 0n) {
    return `${sign}${whole}`;
  }
  const digits = fraction.toString().padStart(RATE_DIGITS, '0').replace(/0+$/, '');
  return `${sign}${whole}.${digits}`;
}

export function describeMoney(value: Money): string {
  return `${value.currency} ${formatMinimalAmount(value)}`;
}
