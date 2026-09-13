import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { REPO_ROOT } from '../data/loader.js';
import { OUTPUT_COLUMNS } from '../data/types.js';
import type { OutputRow } from './validate.js';

export const OUTPUT_PATH = join(REPO_ROOT, 'output.csv');

export function rowToRecord(row: OutputRow): Record<string, string> {
  return {
    request_id: row.requestId,
    amount_safe_to_pay: row.amountSafeToPay,
    affordability_status: row.affordabilityStatus,
    recommended_payment_method: row.recommendedPaymentMethod,
    payment_plan: row.paymentPlan,
    earliest_date_for_full_payment: row.earliestDateForFullPayment,
    spending_changes_needed: row.spendingChangesNeeded,
    decision_explanation: row.decisionExplanation,
  };
}

export function serializeRows(rows: readonly OutputRow[]): string {
  return stringify(rows.map(rowToRecord), {
    header: true,
    columns: [...OUTPUT_COLUMNS],
    quoted_string: false,
    quoted_empty: false,
  });
}

export function writeOutput(rows: readonly OutputRow[]): string {
  writeFileSync(OUTPUT_PATH, serializeRows(rows));
  return OUTPUT_PATH;
}
