# Discovery pack

Owned by spec P0-02. Captures the company's paper forms and workflows so later specs match real practice.

| File | What it holds |
|---|---|
| [forms-inventory.md](forms-inventory.md) | One row per paper form, with its status and linked spec |
| `forms/<slug>.md` | Paper field to system field mapping for each form |
| `workflows/<name>.md` | Seven workflow maps, each step linked to the spec that implements it |
| [glossary.md](glossary.md) | English and Urdu trade terms (Urdu is a draft for review) |
| [gaps.md](gaps.md) | Paper fields or steps with no system field |

## Current state

All eleven forms are `awaiting` samples (input H-14). Their mapping files hold only the header, and the practice columns in the inventory say `TBC`. No spec is blocked by this.

## Adding a sample

1. Put synthetic values only in the repository: no real names, CNIC numbers, phone numbers or amounts. The checker fails on likely CNIC and mobile numbers.
2. In the inventory, fill the form's row and set its status to `received`.
3. In `forms/<slug>.md`, add one row per paper field with its owning spec, or a `GAP-nn` that exists in `gaps.md`.
4. Run `pnpm docs:check`. If a gap needs a spec change, add a proposal to `specs/CHANGES.md`.
