# Phase 2 inputs: owner answers and working defaults

Source: the owner's reply of 2026-10-30. Where a point was left to us or deferred, the default below is an assumption, marked **Assumed**. Nothing here is a secret or a real tax number.

**Principle (owner instruction):** every default must be configurable and easy to change or extend later. No rate, rule, bucket, tolerance or date is fixed in code; each is data (rules tables, import files) or a typed setting in `sys_settings`, effective-dated where it affects money, and a change affects new documents only.

## H-02 Sales tax
### Owner answered
- Authority: FBR only (consistent with H-01). The bill carries tax of 8%.
### Decisions and assumptions
1. **The 8% is data, not code.** P2-01 BR-9 and AC-2 forbid rates in source or seeds. The 8% is entered by an admin on the rules screen or loaded through an importer file. **Assumed:** one FBR rule for services at 8% (effective from the first go-live date), nothing for goods until supplied.
2. **Extensible by design:** a second authority (PRA, H-01 says it may come later), goods rates, nature-specific rates, and a rate change with a new effective date are all added as new rules without a code change.
3. Jobs where the client pays the tax directly stay as in H-04: invoice issued without tax and says so.

## H-03 Withholding tax
### Owner answered
- "8% in bill" for the client side. **To confirm:** whether this is the sales tax itself or a rate the client withholds. **Assumed:** it is the sales tax (H-02); no client-withholding rule is created until the accountant confirms.
- Vendor and subcontractor withholding (what we withhold): use a default and make it configurable; to be changed later.
### Decisions and assumptions
1. **Default:** no withholding rules exist until an admin enters them. The withholding rules screen and `tax_withholding_rules` (both directions, bases `on_invoice_total`, `on_tax_amount`, `on_base`, party type, effective dates) are built in full.
2. Because P2-01 BR-9 refuses taxable documents with a missing rule, a document that needs withholding without a rule gets a clear message, not a silent zero. **Proposal for review:** an explicit "no withholding" outcome is a valid rule (rate 0), so entering it is a deliberate act.

## Defaults confirmed for the rest (owner: "yes, make the default, will re-discuss")
| ID | Default |
|---|---|
| H-06 | Fiscal year starts July |
| H-08 | Tax rounding per document |
| H-13 | Opening data: synthetic data through the P0-04 import templates; real balances loaded later through the same importer |
| H-19 | Independent reviewer not named yet; the build proceeds, and a reviewer must be named before Gate A (P1-21) and Gate B (P2-10) sign-off |
| H-22 | Price variance to project cost if issued, else an overhead cost code |
| H-23 | Over-receipt 0%, match tolerance 0 |
| H-28 | Advance recovery proportional to invoice share of contract value |
| H-29 | Labour cost difference spread pro-rata to the projects in the payroll month |
| H-30 | Aging buckets 0-30, 31-60, 61-90, 90+ days |

Each is a typed setting or a rules row, editable from the UI.

## Still open
- Accountant review of the chart of accounts (H-05, accepted provisionally).
- The meaning of the "8% in bill" on the withholding question (H-03).
- Real opening balances (H-13) and the named reviewer (H-19) before the gates.
