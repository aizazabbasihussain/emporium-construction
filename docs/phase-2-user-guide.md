# Phase 2 user guide: billing, tax, receipts and cash

This guide continues `phase-1-user-guide.md`. It follows the same pilot project (PRJ-0007, a three-room renovation for the client Hamid Raza) through **stage billing, tax, client receipts, post-dated cheques (PDC) and the cash book**.

**Status of this guide:** it is being written by walking the live app. Sections marked **DONE** were run end to end and the screens and amounts below were observed. Sections marked **PENDING** have not been walked yet; they are placeholders to be filled in when the walkthrough resumes. Do not treat a PENDING section as verified behaviour.

Menu names are the ones in the left menu. Paths in brackets are the app routes.

## The big picture

```
Project (contract + payment schedule)
   |  needs: project location -> region -> tax authority mapping -> tax rule -> company registration
   v
Stage invoice (draft) --send--> Approval (owner) --> Issue (accountant) --> INV-....
                                                          |
        Receipt: Cash / Bank transfer / PDC  -------------+--> Customer ledger (balance)
             |                     |
             |                     +--> PDC register: In hand -> Deposited -> Cleared / Bounced
             v
        Cash book (CASH-01, BANK-01)
```

Ideas that explain most of the behaviour:

1. **An invoice cannot be created until tax can be worked out.** The tax engine must find a tax authority for the project's location. If any link in the chain is missing, the invoice is blocked with a message naming what is missing (see Step 1).
2. **Separation of duties.** The person who submits a document cannot approve it. Each document below needs a second person.
3. **Approvals take effect on a 60-second job.** After the owner approves, reload the page and wait up to a minute before the status changes.
4. **Cash book entries appear when money actually moves**: at a cash or bank receipt, or when a PDC is _cleared_. Receiving or depositing a cheque does not create one.

## Who does what (Phase 2 roles)

| Role            | Does                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| Accountant      | Drafts and issues invoices, records receipts, handles PDCs, cash book        |
| Owner           | Approves invoices, tax rules, withholding rules, region maps; read-only view |
| Admin           | Company profile and tax registrations, plus everything the accountant does   |
| Project manager | **No billing access.** Opening billing shows "No access"                     |

Sign in with the right role for each step; the same person cannot submit and approve.

---

## Step 1. Tax set-up (DONE)

An invoice needs this chain, in order. Each link that is missing blocks the invoice.

| Link                       | Where                                  | Who proposes / approves     |
| -------------------------- | -------------------------------------- | --------------------------- |
| Project location           | Project (see note below)               | Set by migration in the pilot |
| Region to tax authority    | Tax > Region map (`/tax/region-map`)   | Accountant proposes, owner approves |
| Sales tax rule (rate)      | Tax > Rules (`/tax/rules`)             | Accountant proposes, owner approves |
| Company registration       | Company profile, tax registrations     | Admin adds, owner approves  |

Pilot values used (demo data, not real rates): Rawalpindi, Punjab -> authority **PRA**, sales rate **8%**, registration **PRA-DEMO-0001**.

**Known gaps found while walking this step**

- **The project screen cannot set a location.** PRJ-0007 pre-dated the tax engine, so the location was added by migration `0034_pilot_location_rawalpindi.sql`. Any new project needs a location set at creation (to be confirmed for new projects).
- The error shown when the chain is incomplete is "project has no location" or "No tax authority is mapped". Read it as "one of the links above is missing".
- Whether "8% in bill" means the PRA sales tax rate is still an **open question** (decision H-03). Demo rules were used.
- The FBR NTN on the company profile **expires 12/12/2026**; renew it before then.

## Step 2. Stage billing (DONE)

Project > **Billing** tab (`/billing/invoices`), signed in as accountant.

1. Choose **New invoice**, tick the payment-schedule stage(s) to bill, set the invoice date.
2. Optional **Nature of work** field (added during this walkthrough). Fill it when a withholding rule exists for that nature, for example `Construction services`. The text must match the rule's nature exactly.
3. The draft shows tax, any withholding and the total. Check it.
4. **Send for approval.** Sign in as owner, open Approvals, approve. Wait for the 60-second job.
5. Sign in as accountant again and **Issue**. The invoice number (INV-2026-000n) is assigned.

Observed result on PRJ-0007 (contract 410,000):

| Invoice       | Stage | Total (incl. 8% tax) |
| ------------- | ----- | -------------------- |
| INV-2026-0001 | 1     | 177,120.00           |
| INV-2026-0002 | 2     | 177,120.00           |
| INV-2026-0003 | 3     | 88,560.00            |
| **Total**     |       | **442,800.00** (= 410,000 + 32,800 tax) |

When all stages are billed the schedule has nothing left to pick; a further invoice needs an advance or another stage.

## Step 3. Client withholding (DONE)

Some clients withhold tax and pay the net amount. Set this up before billing the stage it applies to.

1. Tax > **Withholding** (`/tax/withholding`): add a rule with an **Nature of work** (required). Owner approves it.
2. Create the invoice with the **same nature of work** text. A mismatch gives withholding 0.00 on the draft (the match is exact).
3. On the receipt, the **Withheld** column carries the client-withheld tax; **Allocate** carries the cash received. Together they clear the invoice.

Observed: INV-2026-0003 withheld 7,084.80, received 81,475.20 in cash.

**Known gaps**

- The withholding rule dialog hides its validation error ("Enter the nature of work.") above the visible part of the dialog. If Save seems to do nothing, scroll up in the dialog.
- Before the Nature of work field existed, the UI had no way to supply a matching nature. That is fixed in the working tree (uncommitted).

## Step 4. Receipts (DONE)

`/receivables/receipts/new`. Pick the customer, the method, the amount, then allocate to open invoices. **Suggest allocation** fills only the cash part.

| Receipt       | Method         | Amount     | Invoice       |
| ------------- | -------------- | ---------- | ------------- |
| RV-2026-0001  | Cash           | 177,120.00 | INV-2026-0001 |
| RV-2026-0002  | Post-dated cheque | 177,120.00 | INV-2026-0002 |
| RV-2026-0003  | Bank transfer (+ withholding certificate) | 81,475.20 | INV-2026-0003 |

Cash goes to **CASH-01**; bank transfer goes to **BANK-01**.

## Step 5. Post-dated cheques (PDC) (PARTLY DONE)

`/receivables/pdcs`. Lifecycle: **In hand -> Deposit -> Deposited -> Clear** (or **Bounce**). While In hand you can also **Replace** or **Return**.

DONE:

- **Receive** the cheque through a PDC receipt (Step 4). It sits in the register as In hand. No cash book entry yet.
- **Deposit before the cheque date** is blocked unless you give a **reason**. Choose the target bank account (BANK-01) and the reason; it then moves to Deposited.
- **Clear.** The bank cash book entry (CB-2026-0002, 177,120.00) is created now. The receipt shows **Cleared** in the receipts list.

PENDING (not walked yet):

- **Bounce** a cheque and see what happens to the invoice and ledger.
- **Replace** a cheque while In hand.
- **Return** a cheque to the client while In hand.

Observation to confirm: **Bounce is still offered after a cheque has been Cleared.** Check whether the app should hide it.

## Step 6. Cash book and customer ledger (DONE)

- **Cash book** (`/cashbook/book`) shows one line per receipt movement. After the walkthrough: CASH-01 177,120.00; BANK-01 258,595.20 (177,120.00 cleared cheque + 81,475.20 transfer); total 435,715.20. Withheld tax is not cash and does not appear.
- **Accounts** (`/cashbook/accounts`) lists CASH-01 and BANK-01.
- **Customer ledger** (`/receivables/customers`): Hamid Raza shows Invoiced 442,800.00, Receipts 435,715.20, Tax withheld 7,084.80, **Balance 0.00**, no open invoices. The statement lists withholding as its own credit line.
- The cash book has a **Reverse** action that undoes an entry. It was not tested; restrict it to the accountant and admin until its effect is documented.

---

## Remaining Phase 2 steps (PENDING)

These are the areas still to walk and document. Each will get a Step section above when done.

### Billing cases not yet covered

| Case                                       | Status  |
| ------------------------------------------ | ------- |
| Advance request on a project               | PENDING |
| Recovering an advance on a later invoice   | PENDING |
| Credit note, partial                       | PENDING |
| Credit note, "Cancel by credit note"       | PENDING |
| Part payment on an invoice                 | PENDING |
| Unapplied receipt / customer credit        | PENDING |
| PDC bounce, replace, return (Step 5)       | PENDING |
| Receivables ageing screen                  | PENDING |

### Other Phase 2 areas

| Area (spec)                                               | Status  |
| --------------------------------------------------------- | ------- |
| Payables: vendor bills and payments (P2-05)               | PENDING |
| Subcontractor orders and payments (P2-06)                 | PENDING |
| Payroll finalization, payment and payslips (P2-07)       | PENDING |
| Project profitability and contract tracking (P2-08)       | PENDING |
| Accountant exports and account tags (P2-09)               | PENDING |
| Gate B, financial go-live acceptance (P2-10)              | PENDING |
| Re-check of project closing (see below)                   | PENDING |

**Project closing.** Phase 1 recorded that approved attendance and goods-received cost could not be posted until Phase 2. Posting now exists, so re-test closing PRJ-0007 (currently **Completed**).

## Open points to resolve before go-live

1. Confirm the meaning of "8% in bill" and replace the demo tax rules and PRA-DEMO-0001 with real ones (decision H-03).
2. Add a way to set a project's location in the UI, or document the required order for new projects.
3. Show the withholding rule dialog's validation error where it can be seen.
4. Decide whether Bounce should be offered after Clear.
5. Merge the duplicate Hamid Raza client created when the Phase 1 lead was won (the original, with the project, is the one to keep).
6. Renew the FBR NTN before 12/12/2026.
7. Commit the migration `0034` (pilot data only, a no-op where PRJ-0007 does not exist) and the Nature of work field changes. Nothing is committed yet.
