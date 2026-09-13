import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../data/loader.js';
import type { UsageRecord } from '../evidence/extractor.js';

export const USAGE_REPORT_PATH = join(REPO_ROOT, 'code', 'evaluation', 'usage_report.md');

export const PRICE_PER_MILLION_INPUT_USD = 1.25;
export const PRICE_PER_MILLION_OUTPUT_USD = 10;

interface ModelTotals {
  calls: number;
  cached: number;
  inputTokens: number;
  outputTokens: number;
  temperatureFallbacks: number;
}

export function billableRecords(usage: readonly UsageRecord[]): UsageRecord[] {
  const live = usage.filter((entry) => !entry.cached);
  const livePurposes = new Set(live.map((entry) => entry.purpose));
  const cachedOnly = new Map<string, UsageRecord>();
  for (const entry of usage) {
    if (entry.cached && !livePurposes.has(entry.purpose)) {
      cachedOnly.set(entry.purpose, entry);
    }
  }
  return [...live, ...cachedOnly.values()].sort((left, right) =>
    left.purpose.localeCompare(right.purpose),
  );
}

function group(usage: readonly UsageRecord[]): Map<string, ModelTotals> {
  const totals = new Map<string, ModelTotals>();
  for (const entry of usage) {
    const current = totals.get(entry.model) ?? {
      calls: 0,
      cached: 0,
      inputTokens: 0,
      outputTokens: 0,
      temperatureFallbacks: 0,
    };
    current.calls += 1;
    if (entry.cached) {
      current.cached += 1;
    }
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    if (!entry.temperatureHonoured) {
      current.temperatureFallbacks += 1;
    }
    totals.set(entry.model, current);
  }
  return totals;
}

function costOf(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_USD +
    (outputTokens / 1_000_000) * PRICE_PER_MILLION_OUTPUT_USD
  );
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function buildUsageReport(
  allRecords: readonly UsageRecord[],
  requestCount: number,
  runDescription: string,
): string {
  const usage = billableRecords(allRecords);
  const totals = group(usage);
  const lines: string[] = [];
  lines.push('# Token Usage and Cost Analysis');
  lines.push('');
  lines.push(`This report describes **${runDescription}**.`);
  lines.push('');
  lines.push('## Provider and models');
  lines.push('');
  lines.push('| Provider | Model | Calls | Cache hits | Live calls | Input tokens | Output tokens |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const [model, entry] of [...totals.entries()].sort()) {
    lines.push(
      `| OpenAI | \`${model}\` | ${entry.calls} | ${entry.cached} | ${entry.calls - entry.cached} | ${entry.inputTokens.toLocaleString()} | ${entry.outputTokens.toLocaleString()} |`,
    );
  }

  const allCalls = usage.length;
  const cached = usage.filter((entry) => entry.cached).length;
  const inputTokens = usage.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const outputTokens = usage.reduce((sum, entry) => sum + entry.outputTokens, 0);
  const totalTokens = inputTokens + outputTokens;
  const totalCost = costOf(inputTokens, outputTokens);
  const fallbacks = usage.filter((entry) => !entry.temperatureHonoured).length;

  lines.push('');
  lines.push('## Per-model cost');
  lines.push('');
  lines.push('| Model | Input cost | Output cost | Total cost |');
  lines.push('|---|---:|---:|---:|');
  for (const [model, entry] of [...totals.entries()].sort()) {
    lines.push(
      `| \`${model}\` | ${money((entry.inputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_USD)} | ${money((entry.outputTokens / 1_000_000) * PRICE_PER_MILLION_OUTPUT_USD)} | ${money(costOf(entry.inputTokens, entry.outputTokens))} |`,
    );
  }

  lines.push('');
  lines.push('## Overall totals');
  lines.push('');
  lines.push(`- Requests processed: **${requestCount}**`);
  lines.push(`- Distinct extractions: **${new Set(usage.map((entry) => entry.purpose)).size}**`);
  lines.push(
    `- Model calls: **${allCalls}** (${allCalls - cached} live, ${cached} replayed from cache)`,
  );
  lines.push(`- Input tokens: **${inputTokens.toLocaleString()}**`);
  lines.push(`- Output tokens: **${outputTokens.toLocaleString()}**`);
  lines.push(`- Total tokens: **${totalTokens.toLocaleString()}**`);
  lines.push(
    `- Average tokens per request: **${requestCount === 0 ? 0 : Math.round(totalTokens / requestCount).toLocaleString()}**`,
  );
  lines.push(`- Estimated total cost: **${money(totalCost)}**`);
  lines.push(
    `- Estimated cost per request: **${money(requestCount === 0 ? 0 : totalCost / requestCount)}**`,
  );
  lines.push('');
  lines.push('Pricing basis: ' + `$${PRICE_PER_MILLION_INPUT_USD} per million input tokens and $${PRICE_PER_MILLION_OUTPUT_USD} per million output tokens.`);
  lines.push('');
  lines.push('## Determinism');
  lines.push('');
  if (fallbacks > 0) {
    lines.push(
      `\`temperature: 0\` was requested on every call. **${fallbacks}** call(s) were rejected by the model for supplying \`temperature\` and were retried without it, so those ran at the provider default. Reproducibility for those calls rests on the populated on-disk cache in \`code/evidence/cache/\`, not on temperature.`,
    );
  } else {
    lines.push(
      '`temperature: 0` was accepted on every call. Results are additionally pinned by the on-disk cache in `code/evidence/cache/`.',
    );
  }
  lines.push('');
  lines.push(
    'Cache-replayed calls report the token counts and cost recorded when that extraction was first performed; they are not re-billed. A run served entirely from the shipped cache therefore shows the true cost of producing these results, at $0 incremental spend.',
  );
  lines.push('');
  lines.push('No API keys, credentials, or sensitive configuration values appear in this report.');
  lines.push('');
  return lines.join('\n');
}

export function writeUsageReport(
  usage: readonly UsageRecord[],
  requestCount: number,
  runDescription: string,
): string {
  mkdirSync(dirname(USAGE_REPORT_PATH), { recursive: true });
  writeFileSync(USAGE_REPORT_PATH, buildUsageReport(usage, requestCount, runDescription));
  return USAGE_REPORT_PATH;
}
