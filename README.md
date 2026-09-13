# Buy or Wait?

An AI-powered financial agent for the HackerRank Orchestrate challenge. For every request in
`dataset/requests.csv` it decides whether the user should pay in full, pay partially, use
installments, wait, or not proceed — and writes one row per request to `output.csv`.

**Core principle:** the LLM interprets messy evidence (messages and document images) into structured
facts; **deterministic code makes every financial decision.** The model never computes an amount,
never runs a forecast, never ranks plans, and never authors an output field.

## Setup

```bash
cd code
npm install
```

Create `.env` at the repository root:

```bash
OPENAI_API_KEY=sk-...      # required for the final run
OPENAI_MODEL=gpt-5         # optional, defaults to gpt-5
OPENAI_BASE_URL=           # optional
```

## Run

```bash
cd code
npm run start              # produces ../output.csv and evaluation/usage_report.md
```

The run prints the dataset summary and, on success, one line confirming `output.csv` was written.
`npm run output` is an alias for the same command.

```bash
npm run diagnostics        # full per-phase report and the 25-sample regression, no output.csv
npm run typecheck          # compiler only
```

`VERBOSE=1` adds the full diagnostic trail to any run; `DEV=1` runs engine-only and skips writing
`output.csv`. If validation fails, the run aborts with the offending `request_id` and rule and
`output.csv` is left untouched.

`code/evidence/cache/` holds every model-derived extraction keyed by a content hash, so a repeat run
reproduces the same `output.csv` with no API key and no API calls. Determinism caveat: `gpt-5`
rejects the `temperature` parameter, so those calls retry without it and run at the provider default
— reproducibility rests on that cache, not on `temperature: 0`.

## Repository Layout

```text
AGENTS.md                          # Rules for AI coding tools + transcript logging
ARCHITECTURE.md                    # Single source of truth: scope, rules, decisions
CLAUDE.md                          # Working rules for every session
problem_statement.md               # Full challenge statement
output.csv                         # Final generated predictions
dataset/                           # Input data and the blank output template
code/
├── main.ts                        # Entry point and the self-verifying report
├── data/                          # CSV loading, zod row schemas, typed joins
├── util/                          # Money in integer minor units, epoch-day dates
├── finance/                       # Recurrence, 90-day ledger, plans, ranking, decide()
├── evidence/                      # OpenAI extractor, strict schema, resolver, cache
├── output/                        # Explanations, validator, CSV writer, usage report
└── evaluation/                    # usage_report.md for the final run
```

## Output

`output.csv` carries these columns, in this order:

```text
request_id,amount_safe_to_pay,affordability_status,recommended_payment_method,payment_plan,earliest_date_for_full_payment,spending_changes_needed,decision_explanation
```

Every row is checked by a deterministic validator before serialization — bounds, plan chronology,
installment-option match, partial-payment shape, spending-change legality, and a re-run of the
90-day safety check. The run fails loudly rather than writing an invalid row.

## Architecture

<img width="1859" height="3536" alt="orchestrate" src="https://github.com/user-attachments/assets/06933ec9-d2b0-4637-b93c-4e4b937e141b" />

