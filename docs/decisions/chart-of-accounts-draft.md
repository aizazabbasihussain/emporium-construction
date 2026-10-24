# Chart of accounts: DRAFT for the accountant to review

**Status: draft. Not approved. Do not load into the system.** Written by the build agent as a starting point for H-05. The accountant should add, remove, rename and renumber freely, and sign off in the last section. Nothing here contains a tax rate or a balance.

How to read it: codes are 4 digits, grouped by type (1 assets, 2 liabilities, 3 equity, 4 income, 5 direct project costs, 6 overhead). "Parent" shows the grouping. Project costs are also split by cost code (100 Materials, 200 Labour and so on, answered in H-25) inside the system, so this chart stays short.

| Code | Name | Type | Parent |
|---|---|---|---|
| 1000 | Assets | asset | |
| 1100 | Cash and bank | asset | 1000 |
| 1110 | Cash in hand | asset | 1100 |
| 1120 | Petty cash and site imprest | asset | 1100 |
| 1130 | Bank account (one line per bank) | asset | 1100 |
| 1140 | Post-dated cheques received | asset | 1100 |
| 1200 | Receivables | asset | 1000 |
| 1210 | Trade receivables (clients) | asset | 1200 |
| 1220 | Retention receivable | asset | 1200 |
| 1230 | Unbilled work in progress | asset | 1200 |
| 1300 | Advances and deposits | asset | 1000 |
| 1310 | Advances to vendors | asset | 1300 |
| 1320 | Advances to subcontractors | asset | 1300 |
| 1330 | Staff and worker advances | asset | 1300 |
| 1340 | Security deposits paid | asset | 1300 |
| 1400 | Tax receivable | asset | 1000 |
| 1410 | Input sales tax | asset | 1400 |
| 1420 | Income tax withheld by clients (adjustable) | asset | 1400 |
| 1500 | Inventory (company-owned stock) | asset | 1000 |
| 1600 | Fixed assets | asset | 1000 |
| 1610 | Equipment and tools | asset | 1600 |
| 1620 | Vehicles | asset | 1600 |
| 1690 | Accumulated depreciation | asset | 1600 |
| 2000 | Liabilities | liability | |
| 2100 | Payables | liability | 2000 |
| 2110 | Trade payables (vendors) | liability | 2100 |
| 2120 | Subcontractor payables | liability | 2100 |
| 2130 | Retention payable | liability | 2100 |
| 2140 | Accrued expenses | liability | 2100 |
| 2200 | Payroll liabilities | liability | 2000 |
| 2210 | Wages payable | liability | 2200 |
| 2220 | Advances recoverable from wages | liability | 2200 |
| 2300 | Taxes payable | liability | 2000 |
| 2310 | Output sales tax (FBR) | liability | 2300 |
| 2320 | Output sales tax (PRA, when registered) | liability | 2300 |
| 2330 | Tax withheld from vendors, payable | liability | 2300 |
| 2400 | Client advances and deposits received | liability | 2000 |
| 2500 | Loans and borrowings | liability | 2000 |
| 3000 | Equity | equity | |
| 3100 | Owner capital | equity | 3000 |
| 3200 | Owner drawings | equity | 3000 |
| 3300 | Retained earnings | equity | 3000 |
| 4000 | Income | income | |
| 4100 | Contract revenue, construction | income | 4000 |
| 4110 | Contract revenue, demolition and restructuring | income | 4000 |
| 4120 | Variation revenue | income | 4000 |
| 4200 | Maintenance and service revenue | income | 4000 |
| 4900 | Other income | income | 4000 |
| 5000 | Direct project costs | expense | |
| 5100 | Materials | expense | 5000 |
| 5200 | Direct labour | expense | 5000 |
| 5300 | Subcontractors | expense | 5000 |
| 5400 | Equipment and tools hire | expense | 5000 |
| 5500 | Site expenses | expense | 5000 |
| 5600 | Other direct costs | expense | 5000 |
| 5900 | Stock adjustments and wastage | expense | 5000 |
| 6000 | Overheads | expense | |
| 6100 | Office salaries | expense | 6000 |
| 6200 | Rent and utilities | expense | 6000 |
| 6300 | Vehicle and fuel | expense | 6000 |
| 6400 | Professional fees | expense | 6000 |
| 6500 | Bank charges | expense | 6000 |
| 6600 | Depreciation | expense | 6000 |
| 6900 | Other overheads | expense | 6000 |

## Questions for the accountant

1. Do you want one bank line per account, and if so, which banks?
2. Is the tax treatment right: output tax (2310, 2320), input tax (1410), tax withheld by clients (1420) and tax we withhold (2330)? Rates and rules are a separate decision (H-02, H-03) and are not in this file.
3. Should retention and unbilled work be tracked as separate accounts, as shown?
4. Should direct project costs map to cost codes one-to-one (5100 to 100 Materials, 5200 to 200 Labour, 5300 to 300 Subcontractors, 5400 to 400 Equipment, 5500 to 500 Site expenses, 5600 to 600 Other)?
5. Anything specific to your reporting or audit needs that is missing?

## Sign-off

| Approved by | Role | Date | Changes made |
|---|---|---|---|
| | accountant | | |

Once signed, send the final list to the build agent. It will be set as the answer to H-05 and loaded through P0-03.
