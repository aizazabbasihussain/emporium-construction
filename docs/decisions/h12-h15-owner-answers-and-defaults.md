# H-12 and H-15: owner answers and working defaults

Source: the owner's filled questionnaire (`docs/discovery/owner-questionnaire-h12-h15.md`), 2026-10-25. Where the owner left a point blank or asked for our suggestion, the default below is an assumption, marked **Assumed**. Nothing here is a secret or a real client figure.

**Principle (owner instruction):** nothing about pay, rates, templates or percentages is fixed in code. Every value below is data that an admin edits from a screen or loads through an importer, or a typed setting in `sys_settings` (P1-01). Changing a value affects new records only; history is kept.

## H-12 Worker pay

### Owner answered
- About 50 workers paid directly: 30 permanent, 20 brought by a contractor. The daily-wage count was written as "1000 rupee"; read as a daily rate of PKR 1,000, with the headcount not given. **To confirm.**
- Trades: mason, helper, carpenter, steel fixer, painter, electrician, plumber, driver.
- Permanent workers and supervisors: monthly salary. Daily-wage workers and contractor workers: daily rate.
- Contractors: paid as a total; only the contractor bill is tracked, not individual workers.
- Rates: "make this configurable, it is not fixed."
- Worker list loading: leave for now; the admin enters workers from the screen.

### Decisions and assumptions
1. **Rates are per worker and effective-dated** (P1-16 `lab_pay_rates`), entered on the worker screen or imported. No amount is seeded in code or migrations. PKR 1,000 is not preloaded; it is entered as data.
2. **Pay basis is chosen per worker** (`daily_rate` or `monthly_salary`), not fixed per group. **Assumed:** the worker form pre-selects monthly for employment type permanent and daily for daily and contract, as a convenience the admin can change.
3. **Contractor labour is not entered as workers.** The owner tracks only the contractor bill, so contractor labour is paid through the subcontractor path (P2-06) and costed to the project from that bill. P1-16 BR-1's contractor exception stays in the spec but is not used. **To confirm:** the 20 contractor workers are not on the attendance sheet. If they must be, attendance by headcount per contractor per day would be a spec change (CHANGES).
4. **A default rate per trade is not in P1-16.** **Assumed:** not needed for now; the admin can import one rate row per worker. If the owner wants "set the trade rate once and apply it to everyone", propose it in CHANGES.
5. **Left to the admin to enter:** overtime, Friday and holiday pay, allowances, payment method (cash, bank, wallet) and whether account details are stored. The worker form already has an optional `bank_or_wallet_info` field. These belong to H-11.
6. **Who confirms rates in the owner's absence:** blank. The `workforce.rate.manage` permission (accountant, management) already restricts who can change rates.

### Suggested starting values for H-11 (not yet agreed; H-11 stays open)
Working-days basis 26, overtime multiplier 1.5, net pay rounded to the nearest PKR 1. Each is a typed setting, not a constant.

## H-15 Job templates

### Owner answered
- Most common jobs: demolition (about 10 a year) and restructuring (about 10 a year). Ranks 3 and 4 not given.
- Pricing: both lump sum and per unit.
- Material prices come from the market and are updated whenever needed.
- Template details (parameters, lines, rates), overhead, contingency and margin: left to us ("assume as best you suit").

### Decisions and assumptions
1. **Templates are data.** The P1-07 template editor creates and edits them; code contains the formula evaluator only. Template lines carry **no default rates** unless the admin enters them, because the owner prices from the market. Lines without a rate show `rate_missing` and block locking (P1-07 BR-3), which is the intended prompt to price them.
2. **Starter templates ship as an importable file, not as code.** **Assumed:** a file in `docs/templates/` with the work types `demolition`, `restructure`, `boundary_wall`, `room`, `slab`, loaded by an admin through the import screen (P0-04). All rates are empty. Only the structure (parameters, line kinds, formulas) is suggested, and the owner corrects it on screen. Boundary wall, room and slab are our guess for ranks 3 and 4 because the plan names them.
3. **Suggested parameters:**
   - Demolition: area (sqft), thickness or floors, structure type (brick, RCC), debris haul distance.
   - Restructuring: area (sqft), scope (wall removal, opening, extension), floors.
   - Boundary wall: length (ft), height (ft), thickness.
   - Room: length, width, height.
   - Slab: area, thickness.
4. **Suggested line kinds per template:**
   - All templates have `labour` and `material` lines (cement, sand, bricks, steel and similar).
   - Demolition and restructuring also get `disposal` (debris removal and transport) and `equipment` (breaker, compressor) lines.
   - Demolition and restructuring get an optional `salvage_credit` line (steel, bricks, scrap), as P1-07 BR-9 already allows. With H-21 at its default, salvaged stock is valued at zero, but the estimate credit is the estimator's own figure.
   - Nothing is client-supplied unless the estimator marks it.
5. **Percentages (Assumed, all editable):** overhead 10%, contingency 5%, target margin 15%. Stored as typed settings `estimation.overhead_percent`, `estimation.contingency_percent`, `estimation.target_margin_percent` and copied into each new estimate, where the estimator can change them. One value for all job types and client types for now. There is no margin floor (H-09). These numbers are placeholders chosen because the owner gave none, not market data.
6. **Per-unit pricing:** the estimate's proposed price is entered as a total; the unit price (per sqft or per ft) is shown as total divided by a chosen measure parameter. **Assumed:** this is display only. A rate-card pricing model (price per unit times quantity) is not in P1-07 and would be a CHANGES proposal if the owner needs it.

## What this changes in the register

H-12 and H-15 stay `open`, because real rates and rate-bearing templates still arrive later from the admin. "Default allowed" becomes `yes`, so P1-07 and P1-16 can be built now with synthetic test data. When the admin has loaded real data, mark them `answered`.

## Points for the owner to confirm later
1. Daily-wage headcount and the PKR 1,000 daily rate.
2. Whether contractor workers must appear on attendance.
3. Overhead, contingency and margin percentages.
4. The job types in ranks 3 and 4.
5. Overtime, Friday and holiday pay (H-11).
