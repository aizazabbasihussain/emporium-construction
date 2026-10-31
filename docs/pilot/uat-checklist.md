# Gate A user acceptance checklist (UAT)

Spec P1-21 BR-9. The owner and one representative of each role walk their list on **synthetic data** (`pnpm seed:synthetic`, or the data the Gate A scenario creates) and sign at the bottom of the list. An agent must not tick a box or sign for a person.

How to read a line: `[ ]` not yet checked, `[x]` checked and fine. If a step fails, write the problem under "Findings" at the end of the file and leave the box empty.

## Owner

- [ ] Sign in and see the home page with only the pages that belong to the owner role
- [ ] Approvals inbox: approve a quotation, a purchase order, a variation and a wage period
- [ ] Projects: open a project, read the cost summary by cost code (committed, approved, posted, budget, variance)
- [ ] Project cost report: figures match the project summary
- [ ] Wages: open the approved monthly wage sheet and its reconciliation
- [ ] Users and roles: a disabled user cannot sign in

## Project manager

- [ ] Lead to estimate from a template, lock the estimate, issue a quotation
- [ ] Accept the quotation and see the project created with its budget
- [ ] Raise a requisition for a store
- [ ] Review a daily progress report with photos
- [ ] Approve attendance sheets of a team

## Procurement officer

- [ ] Send an RFQ, enter a vendor quote, select the vendor and make the purchase order
- [ ] Submit the purchase order for approval and see it approved
- [ ] The open purchase order lines show what is still to be received

## Store keeper

- [ ] Receive a partial delivery with a challan photo; the stock rises by the accepted quantity
- [ ] Issue stock to a project; the cost appears on the project
- [ ] Receive and use client-supplied material; the client material balance is right and no cost is posted
- [ ] Transfer stock between two stores and count stock

## Accountant

- [ ] Post an approved site expense claim; it moves from approved to posted on the project
- [ ] Change the valuation method to FIFO, see the owner approval and the transition result
- [ ] Calculate a monthly wage sheet, check rounding of net pay, add an adjustment, submit it
- [ ] Open the stock valuation report and the labour report

## Site supervisor

- [ ] Sign in on a phone-size screen; see only the assigned project and own team
- [ ] Save a daily progress report offline, then send it when back online
- [ ] Mark attendance for the team for a day and submit it
- [ ] File an expense claim with a receipt
- [ ] Cannot see worker pay rates or project cost entries

## Findings

_None recorded yet._

## Sign-off

A sign-off line is complete only with a name, a role and a date written by that person.

| Role                | Name | Date | Signed |
| ------------------- | ---- | ---- | ------ |
| Owner               |      |      | [ ]    |
| Project manager     |      |      | [ ]    |
| Procurement officer |      |      | [ ]    |
| Store keeper        |      |      | [ ]    |
| Accountant          |      |      | [ ]    |
| Site supervisor     |      |      | [ ]    |
