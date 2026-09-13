export type EpochDay = number;

export class DateError extends Error {}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysFromCivil(year: number, month: number, day: number): EpochDay {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function civilFromDays(epochDay: EpochDay): { year: number; month: number; day: number } {
  const shifted = epochDay + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: month <= 2 ? year + 1 : year, month, day };
}

export function parseDate(text: string): EpochDay {
  const trimmed = text.trim();
  const match = DATE_PATTERN.exec(trimmed);
  if (match === null) {
    throw new DateError(`invalid date literal: "${text}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new DateError(`date out of range: "${text}"`);
  }
  const epochDay = daysFromCivil(year, month, day);
  const roundTrip = civilFromDays(epochDay);
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day) {
    throw new DateError(`date does not exist: "${text}"`);
  }
  return epochDay;
}

export function parseOptionalDate(text: string): EpochDay | null {
  return text.trim().length === 0 ? null : parseDate(text);
}

export function parseDateFromTimestamp(text: string): EpochDay {
  const trimmed = text.trim();
  if (trimmed.length < 10) {
    throw new DateError(`invalid timestamp literal: "${text}"`);
  }
  return parseDate(trimmed.slice(0, 10));
}

export function formatDate(epochDay: EpochDay): string {
  const { year, month, day } = civilFromDays(epochDay);
  const yearText = String(Math.abs(year)).padStart(4, '0');
  const sign = year < 0 ? '-' : '';
  return `${sign}${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatOptionalDate(epochDay: EpochDay | null): string {
  return epochDay === null ? '' : formatDate(epochDay);
}

export function addDays(epochDay: EpochDay, count: number): EpochDay {
  return epochDay + count;
}

export function daysBetween(from: EpochDay, to: EpochDay): number {
  return to - from;
}

export function compareDays(left: EpochDay, right: EpochDay): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function minDay(left: EpochDay, right: EpochDay): EpochDay {
  return left <= right ? left : right;
}

export function maxDay(left: EpochDay, right: EpochDay): EpochDay {
  return left >= right ? left : right;
}

export function isOnOrBefore(left: EpochDay, right: EpochDay): boolean {
  return left <= right;
}

export function isOnOrAfter(left: EpochDay, right: EpochDay): boolean {
  return left >= right;
}

export function isWithinInclusive(epochDay: EpochDay, start: EpochDay, end: EpochDay): boolean {
  return epochDay >= start && epochDay <= end;
}

export function dayOfMonth(epochDay: EpochDay): number {
  return civilFromDays(epochDay).day;
}

export function monthOfYear(epochDay: EpochDay): number {
  return civilFromDays(epochDay).month;
}

export function yearOf(epochDay: EpochDay): number {
  return civilFromDays(epochDay).year;
}

export function monthIndex(epochDay: EpochDay): number {
  const { year, month } = civilFromDays(epochDay);
  return year * 12 + (month - 1);
}

export function daysInMonth(year: number, month: number): number {
  const startOfMonth = daysFromCivil(year, month, 1);
  const startOfNextMonth =
    month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  return startOfNextMonth - startOfMonth;
}

export function addMonthsClamped(epochDay: EpochDay, count: number): EpochDay {
  const { year, month, day } = civilFromDays(epochDay);
  const total = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return daysFromCivil(targetYear, targetMonth, clampedDay);
}

export function enumerateDays(start: EpochDay, end: EpochDay): EpochDay[] {
  const days: EpochDay[] = [];
  for (let current = start; current <= end; current += 1) {
    days.push(current);
  }
  return days;
}
