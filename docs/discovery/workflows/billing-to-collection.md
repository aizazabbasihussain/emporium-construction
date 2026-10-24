# Workflow: billing to collection

Stage billing against a lump-sum contract, tax by project location, and collecting the money.

| Step | Actor | Document produced | Approval | Spec |
|---|---|---|---|---|
| 1. Bill a stage against the contract, recovering any advance and including approved variations | Accountant | Tax invoice | Approval per H-09 | P2-02 |
| 2. Apply tax by authority, location and nature of supply | System | Tax lines on the invoice | none | P2-01 |
| 3. Record a receipt (cash, cheque or transfer) and allocate it to invoices | Accountant | Receipt | none | P2-04 |
| 4. Track post-dated cheques from pending to cleared or bounced | Accountant | PDC register entry | none | P2-04 |
| 5. Record tax withheld by the client against the invoice | Accountant | Withholding entry | none | P2-04 |
| 6. Keep the cash and bank book and reconcile the bank | Accountant | Cash and bank book | none | P2-03 |
| 7. Chase overdue balances | Accountant | Receivables aging | none | P2-04 |
| 8. Correct an invoice with a credit note when needed | Accountant | Credit note | Approval per H-09 | P2-02 |
| 9. Review contract value against cost, billing and collection | Owner | Profitability report | none | P2-08 |
| 10. Hand registers and ledgers to the internal accountant | Accountant | Excel and CSV exports | none | P2-09 |
