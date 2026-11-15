# Emporium Construction Operations: User Manual

How to set up the app and take one project from a first phone call to a finished, costed job, written for each type of user.

**How this manual was made.** Every step below was done by hand in the running app on 14 November 2026, using one invented job (a 3-room renovation for a client called Hamid Raza). Figures in the examples are the real ones the app produced. Where a role's screens could not be exercised in that run, the text says "from the specs" so you know it is less certain.

**Scope.** This is Phase 1 of the product (operations: sales, projects, purchasing, stock, site work, labour and wages). Client invoices, receipts, tax, payroll payment and profit are Phase 2 and are not in the app yet.

---

## 1. The big picture

```
Lead -> Site visit -> Estimate -> Quotation -> Owner approves -> Client accepts
                                                                     |
                                       PROJECT is created automatically (budget copied from the estimate)
                                                                     |
   Requisition -> Owner approves -> RFQ (vendor quotes) -> Purchase order -> Owner approves -> Goods received
   Workers + Team -> Attendance sheet -> Project manager approves -> Labour cost on the project
   Daily progress report (photo) -> Reviewed -> Progress %
   Expense claim (receipt) -> Owner approves -> Accountant posts
                                                                     |
              Wage sheet -> submitted -> a second manager approves -> Reports -> Project Completed
```

Four ideas explain most of how the app behaves:

1. **Cost lands on the project by itself.** Nobody types cost onto a project. Approved attendance, received goods and posted expenses each create cost entries. The project page only shows them.
2. **The person who submits a document can never approve it** (separation of duties). Plan for two people on every approval.
3. **Almost everything is slow on a remote database.** Screens can take several seconds to update, and a few jobs run once a minute in the background. If nothing seems to happen, wait and reload before clicking again (section 12).
4. **Roles decide what each person sees.** The same menu shows different items to an owner, a project manager, a supervisor and so on.

---

## 2. Who does what (roles)

| Role | Main job in the app | Approves |
| --- | --- | --- |
| Administrator | Users, roles, settings, data import, expense categories, number series; sees everything | Nothing in the business flow |
| Management (owner) | Reads everything; approves money and plans | Quotations, requisitions, purchase orders, expense claims, wage sheets, variations, stock adjustments |
| Project manager | Runs projects: estimates, quotations, tasks, reviews reports | Attendance sheets |
| Estimator | Job templates, estimates, quotations (from the specs) | - |
| Procurement officer | Requisitions, RFQs, purchase orders, receiving (from the specs) | - |
| Store keeper | Stock in, issue, transfer, count (from the specs) | - |
| Site supervisor | Daily progress reports, attendance for their team, expense claims | - |
| Accountant | Posts expense claims, calculates and submits wages, valuation | - |
| Worker | Own attendance, advances and wages only | - |

A person can hold several roles (in the walkthrough, the project managers were also supervisors).

**Sign-in.** Every user needs two things: a user record under `Users` and a sign-in (email and password) in the sign-in service with the same email. The first sign-in links them. Creating the user record alone does not let anyone in.

---

## 3. One-time setup (Administrator)

Do these once, before the first project. The administrator's menu has all of them.

1. **Company profile** (`Company profile`): company name, address, phone, email.
2. **Users and roles** (`Users`): add each person, give a role. Add the matching sign-in for each. Give supervisors their **scopes** (below).
3. **Cost codes** (`Cost codes`): the buckets cost is grouped into. The standard set is `100 Materials`, `200 Labour`, `300 Subcontractors`, `400 Equipment and tools`, `500 Site expenses`, `600 Other`. Each has a kind, and a line's kind must match its cost code's kind.
4. **Units and item categories** (`Units`, `Items`): the unit list is fixed (bag, cum, day, ft, hour, kg, ls, m, nos, sqft, sqm, ton). There is no litre; price liquids per sqft or per nos.
5. **Items** (`Items`): everything you buy. Add one by one, or load many with **Data import** (section 11).
6. **Vendors and clients** (`Clients and vendors`): one list for clients, vendors, subcontractors and labour contractors. A new party defaults to the Vendor role, so tick the right role.
7. **Expense categories** (`Expense categories`): at least one, or nobody can file an expense claim. The code must be lower case letters, digits and underscores (for example `transport`). Set the default cost code, whether a receipt is required, and the amount allowed without one.
8. **Workers, pay rates and teams** (section 8).
9. **Approval rules** (`Approval rules`): check who approves each document. By default the management role approves requisitions, purchase orders, expense claims, quotations, wage sheets and variations, and the project manager approves attendance sheets.

### Supervisor scopes: what a supervisor can see
A supervisor sees only the projects and teams in their **scopes** (`Users` -> **Projects and teams**).
- A **team** scope is added automatically when a team is created with that person as its supervisor.
- A **project** scope must be added by an administrator: choose type Project and paste the project id (the long code in the address bar of the project page), then **Save**.

---

## 4. Sales: lead to accepted quotation

### 4.1 Lead (project manager, estimator or owner)
`Leads` -> **New lead**: contact name and phone, type of work, sector (use **Private** for ordinary work), source, expected value, site address, notes. The lead gets a number (`LEAD-0002`) and stage **New**.

On the lead page:
- **Change stage**: New to Visited, Quoted, Negotiation, Won or Lost.
- **Add visit**: date and what you measured. Keep measurements here.
- **Add follow-up**: a due date and a note. Overdue follow-ups appear under `Follow-ups`.

**Winning a lead creates the client automatically** from the lead's contact name and phone, and cancels any open follow-up. Two rules follow from that:
- Do not add the client by hand first. A client with the **same name and same phone** already on file makes the move to Won fail with a conflict. (In the walkthrough, we had added the client first, so we changed the lead's contact name slightly. That left an extra client record to delete.)
- Move the lead to Won only when the client has actually agreed.

### 4.2 Job template (project manager or estimator, once per kind of job)
`Job templates` -> **New template**. A template is a reusable recipe: **parameters** (measurements you take on site) and **lines** (cost items with a quantity formula). The example used for the renovation:

| Parameter | Unit |
| --- | --- |
| `floor_area` | sqft |
| `wall_area` | sqft |

| Line | Kind / cost code | Unit | Quantity formula | Rate |
| --- | --- | --- | --- | --- |
| Floor tiles (incl. 5% wastage) | Material / 100 | sqft | `floor_area * 1.05` | 180 |
| Cement and tile adhesive | Material / 100 | bag | `ceil(floor_area * 0.02 + wall_area * 0.025)` | 1,450 |
| Putty, primer and paint (2 coats) | Material / 100 | sqft | `wall_area` | 42 |
| Mason (tiling, plaster) | Labour / 200 | day | `ceil(floor_area / 40 + wall_area / 120)` | 1,800 |
| Electrician (rewiring) | Labour / 200 | day | `ceil(floor_area / 60)` | 2,200 |

Formula rules: use only your own parameter names, `+ - * /`, brackets, and `ceil`, `floor`, `round`, `max`, `min`. A typo is rejected on save. Choose the line's **Kind** first, then a cost code of that kind.

### 4.3 Estimate (project manager or estimator)
`Estimates` -> **New estimate**: pick the template, a title and the client, and type the site measurements. In the example, floor area **432 sqft** (rooms 12x14, 12x12, 10x12 ft) and wall area **1,440 sqft** (144 ft perimeter x 10 ft). The app fills the lines:

| Line | Quantity | Total (PKR) |
| --- | --- | --- |
| Tiles | 453.6 | 81,648 |
| Cement | 45 | 65,250 |
| Paint | 1,440 | 60,480 |
| Mason | 23 | 41,400 |
| Electrician | 8 | 17,600 |
| **Company cost** | | **266,378** |

Overhead (10%) and contingency (5%) are added by default, giving a **total estimated cost of 306,334.70**. Type the proposed price (410,000) and a target margin (25%). The **Cost and margin** card shows margin **103,665.30 = 25.28%** and whether it meets the target. **Save**, then **Lock estimate**. A locked estimate cannot change; use **Create revision** to change it.

### 4.4 Quotation (project manager or estimator)
`Quotations` -> **New quotation** from a locked estimate. The price fills in from the estimate. The default is one stage, "Full payment 100%"; replace it with the real payment plan. The example used three stages: **Advance on signing 40%** (164,000), **On completion of tiling and plaster 40%** (164,000), **On handover 20%** (82,000). Stages must add to 100%. **Save**, then **Submit for approval** (the page locks; use **Create revision** to change it later).

### 4.5 Approval, issue and acceptance
1. The **owner** opens `Approvals`, opens the request, adds a comment and clicks **Approve** (or **Reject**, or **Return** for correction). Allow up to a minute for the quotation to show **Approved**.
2. **Issue to client** (project manager): status Issued and a valid-until date 30 days ahead. This only changes status; send the PDF yourself (**Download PDF**).
3. **Record acceptance** when the client agrees: who accepted, and a note. A signed document is optional for private work and required for government work.
4. **The project is created automatically** within about a minute: `Projects`, status **Planning**, contract value equal to the quotation price (never changes), and a budget copied from the estimate.

---

## 5. Setting up the project (project manager)

Open `Projects` -> the project.

- **Overview**: contract value, progress and a table of budget against cost by cost code. The budget comes from the estimate's **company cost** lines only: the example gave Materials 207,378 and Labour 59,000, total **266,378**. Overhead and contingency are not budgeted, so they are the project's cushion.
- **Tasks**: type a task name and **Add task**. Add tasks of similar size, because **project progress is the simple average of the task percentages**. The example used Electrical rewiring, Plaster, Tiling and Painting. Add one at a time and wait for it to appear.
- **Change status** to **Active** before any site work. Cost can only be posted while a project is Planning or Active.
- **Variations** (scope changes) are added on the Variations tab and need owner approval.

---

## 6. Purchasing and stock

### 6.1 Requisition (project manager, procurement officer or supervisor)
`Requisitions` -> **New requisition**: choose **Project** (or Store), the project, a needed-by date, a note, then one line per item with quantity, estimated rate and cost code. The example: 454 sqft tiles at 180, 45 bags cement at 1,450, 1,440 sqft paint at 42, total **207,450**. **Create requisition**, then **Submit for approval**. The owner approves it.

### 6.2 Request for quotation (procurement officer)
On the approved requisition click **Ask for quotes** and choose the vendors. This creates an RFQ (`RFQ-2026-0001`).
- **Enter a vendor quote**: choose the vendor, type their rate for each line, **Save quote**. The page ranks the quotes by total and marks the **lowest rate** on each line.
- **Choose** a vendor per line. If you choose a vendor whose rate is **not the lowest**, the app asks for a **written reason**, which is kept on record.
- The page lags after each choice. Reload to see **Chosen** tags, then click **Order from <vendor>**.

In the example, vendor 004 totalled **202,312** against vendor 002's 207,610.

### 6.3 Purchase order (procurement officer)
The order opens as a **Draft** with the chosen rates (total 202,312). **Submit for approval**; the owner approves it. Only then can goods be received. **Amend (new version)** changes an approved order; **Close order** closes it short.

### 6.4 Receiving goods (store keeper or procurement officer)
On the approved order click **Receive goods**: for each line type the **accepted** and **rejected** quantity, the delivery challan number, and a challan photo, then **Post receipt** (`GRN-2026-0001`). The example accepted 450 tiles and rejected 4 broken ones.

What this does to cost depends on the order's destination:
- **Destination is a project** (the example): the accepted quantity is charged to the project straight away as **Approved** cost (450 x 178 + 45 x 1,420 + 1,440 x 40 = **201,600**). There is no store stock to issue, so `Stock on hand` stays empty.
- **Destination is a store**: the goods go into stock, and a store keeper later uses **Issue material** to charge them to a project at the stock valuation.

The unreceived part of an order stays **Committed** (the 4 rejected tiles = 712). When you will not receive the rest, **Close order**. That releases the commitment.

### 6.5 Stock screens (from the specs, not exercised in the walkthrough)
`Stock on hand`, `Issue material`, `Stock transfers`, `Stock counts`, `Client material` (stock the client supplied: tracked but no cost posted), `Stock ledger`. Stock counts and adjustments need owner approval.

---

## 7. Site work (supervisor and project manager)

### 7.1 Attendance (supervisor files, project manager approves)
`Attendance sheet`: choose the **team** and the **date** (not in the future; a short backdating window applies). Each worker defaults to **Present**, charged 100% to the project. Change the status for absences, add overtime hours (0 to 8), and use **Split to another project** when a worker splits the day. The shares must add to exactly 100%. **Save sheet**, then **Submit for approval**.

A different person from the submitter, holding the **project manager** role, approves it in `Approvals`. On approval the app posts one cost entry per worker as **Approved**:
- present = 1 x the daily rate; half day = 0.5 x; overtime = hours x (daily rate / 8) x the overtime multiplier (1.5 in the example).

Example: nine workers on rates 1,000 to 3,000 cost **16,600**, plus Bilal's 2 overtime hours (2 x 1,800 / 8 x 1.5 = 675), total **17,275**. This is the project's Labour cost. A worker with no pay rate blocks the sheet. An approved sheet is locked; unlock it with a reason to correct it (not once that month's wage sheet is approved).

### 7.2 Daily progress report (supervisor)
`Daily progress reports` -> **New report**: project, date, weather, work done, delays, safety notes, manpower (trade and count per row), **task progress** (choose a task and its percent complete, with a note), materials. Click **Save**, then attach **at least one photo** under Attachments, then **Submit**. The project manager opens it and clicks **Mark reviewed** (or **Reopen for correction**).

Submitting updates the task percentages. In the example, Electrical rewiring 30% and Plaster 10% gave project progress **10.00%** ((30+10+0+0)/4). A percent cannot go down without a note. `Missing daily reports` lists days with no report.

You can also set a task to **Done** on the project's Tasks tab, which sets it to 100%. Do this only when it is true.

### 7.3 Expense claims (supervisor files, owner approves, accountant posts)
`My expense claims` -> **New claim**: a note, then a line per expense: date, **category**, description, **Charged to** (a project or Overhead), cost code (it fills in from the category), amount. A category can require a **receipt** above a limit. **Save** the claim first, then upload the receipt under Attachments, pick it in the line's **Receipt** box, and **Save** again. **Submit for approval**.

The owner approves. The accountant (or administrator) then opens `Posting queue` and clicks **Post**. Only then does the cost become **Posted** on the project. Spending on a cost code with no budget is allowed and shows as a negative variance.

---

## 8. Workers, pay and teams (administrator or accountant)

- `Workers` -> **New worker**: name, father's name, CNIC (13 digits; unique among active workers), phone, trade, employment type, joined date. Permanent and daily workers need a CNIC.
- **Pay rate** (on the worker page): choose the pay basis (daily rate or monthly salary), type the amount and the **From** date, then **Add rate**. Rates are dated and cannot overlap. Attendance cannot be submitted without one. For many workers use `Data import` -> **Worker pay rates**.
- `Team board`: each team has exactly one supervisor and any number of workers; a worker is in one team at a time. Teams and members can also be loaded with **Data import** (Teams, Team memberships).
- **Contractor labour** is not loaded as workers.
- A worker can sign in to see their own attendance, advances and wages (`My attendance`, `My advances`, `My wages`).

---

## 9. Monthly wages (accountant or owner, then a second manager)

`Wage sheets`:
1. Choose the month and **Open the month**. It starts as **Draft**.
2. Open the sheet and click **Calculate**. It reads only **approved** attendance. This can take about 40 seconds; reload to see the result. Daily-rate workers get days x rate; overtime and rounding follow the settings.
3. Check the table and totals. The example gave gross = net = **17,275**, the same as the labour cost on the project. Add allowances, deductions or advance recoveries if needed (each needs a reason).
4. Read the **Check before submitting** warning (for example "60 team days have no attendance sheet"), tick **I have seen these warnings**, and click **Submit for approval**. Submitting is blocked while any attendance sheet of the month is unapproved.
5. A **different management user** approves it in `Approvals`. The submitter cannot.
6. `Reconciliation` compares attendance cost on projects with the wage sheet, per worker.

Payment of wages, payslips and the cash book are Phase 2.

---

## 10. Reports (owner, project manager, accountant)

`Reports` has seven reports. Every table can be filtered, sorted and exported to Excel or CSV.

| Report | What it shows |
| --- | --- |
| Project cost status | Budget, committed, approved, posted, used, variance and percent used, per project and cost code |
| Stock on hand | Quantity and value per store and item, items below reorder level |
| Pending purchasing | Open requisitions and order lines still to receive, with overdue lines |
| Labour | Worker-days, labour cost and headcount from approved attendance |
| Daily report compliance | Days with and without a submitted daily report |
| Lead pipeline | Leads and expected value per stage, conversion rate, overdue follow-ups |
| Client material | Client-supplied stock |

The example project read: budget **266,378**, used **222,375** (83.48%), variance **44,003**; Materials 97.21% used, Labour 29.28%, Site expenses -3,500 (no budget); Labour report 9 worker-days, 17,275. The project page warns when a cost code passes 90% of its budget.

---

## 11. Data import (administrator or accountant)

`Data import` loads many records from a spreadsheet instead of typing them. Available importers: cost codes, item categories, items, clients and vendors, tax registrations, units, vendor prices, workers, worker pay rates, teams and team memberships.

1. Choose **What to import**. Download the **CSV template** (or Excel) and fill it in. Keep the column names.
2. Upload the file and click **Run dry run**. Nothing is saved. Every problem is listed by row and column.
3. When the dry run passes ("3 rows are ready to import"), click **Commit import**. It is all or nothing.
4. A file that was already imported is refused unless you tick the box to import it again (administrator).

Load things in order: item categories before items; workers before pay rates; workers and teams before team memberships. The walkthrough loaded three items this way:

```
code,name,category_code,unit,item_kind,stockable,default_tax_kind,reorder_level,default_cost_code,active
TILE-01,Floor tile 2x2 ft,FIN,sqft,material,yes,goods,,100,yes
CEM-01,Portland cement 50 kg bag,FIN,bag,material,yes,goods,,100,yes
PAINT-01,Putty primer and paint (2 coats),FIN,sqft,material,yes,goods,,100,yes
```

---

## 12. Finishing a project, and known limits

### Completing
When all tasks are at 100%, change the project's status to **Completed**.

### Closing is blocked in Phase 1 when there is attendance or goods cost
To **Close**, a project must have no **Committed** cost and no **unposted Approved** cost. In Phase 1 only expense claims can be posted. Approved attendance and received goods stay **Approved** because their posting step belongs to Phase 2 (payroll finalization and payables). The app then refuses with *"The project still has committed or unposted approved costs."*

**What to do:** treat **Completed** as the end of a project in Phase 1. Close any open purchase orders so nothing stays Committed, post all expense claims, and leave the rest. Closing becomes possible once Phase 2 posts the remaining cost.

### Tips for slow screens
- Lists can briefly say "No data" before rows arrive. Wait a few seconds.
- A button can spin for a long time (wage calculation and submission took about 40 seconds). Check that the request finished (the page changes after a reload) before clicking again.
- Several results arrive through a background job that runs **once a minute**: an approval outcome on a quotation, and the project being created after acceptance. Wait a minute and reload.
- The RFQ page does not refresh after you choose a vendor. Reload to see it.
- If a click on a drop-down choice does nothing, reload and use the keyboard or try again slowly.

### Checks before you start work
- After switching accounts, read "Signed in as ..." at the top right before you file anything.
- Never work around the approval rules (for example by giving the preparer the approving role). It does not help and it weakens the control.

---

## 13. Chapters by role: quick checklists

### Administrator
Set up once (section 3). Add each new person with a role and a sign-in. Give new supervisors a project scope. Keep the expense categories, units, items and cost codes tidy. Run imports (section 11). Reset nothing in the business flow; the administrator is not an approver.

### Owner / Management
Read all pages. Each day: open `Approvals` and decide on quotations, requisitions, purchase orders, expense claims and wage sheets. Check the comment box, the amount and the document before you approve. At month end approve the wage sheet (a different manager must submit it). Use `Reports` and the project pages for status.

### Project manager
Leads, estimates, quotations, the project (tasks, status), approve attendance sheets, review daily reports, watch cost against budget on the project page. Move the project to Active at the start and Completed at the end.

### Estimator (from the specs)
Maintain job templates, make estimates and quotations, watch margin against the floor and target.

### Procurement officer and store keeper (from the specs, partly exercised)
Raise requisitions, ask for quotes, compare, raise purchase orders, receive goods with the challan, and for store-held stock issue material to projects. Close orders you will not complete.

### Site supervisor
Each working day: fill and submit the attendance sheet for your team, then the daily progress report with a photo. File expense claims with receipts. You only see the projects and teams in your scopes.

### Accountant
Maintain pay rates, post approved expense claims in `Posting queue`, calculate and submit the monthly wage sheet, check `Reconciliation`.

### Worker
Sign in to see your own attendance, advances and wages.

---

## 14. Appendix: what the walkthrough created

All of this is test data in the pilot database. Delete what you do not want to keep.

- Users: taimoor and zeeshan (management), saqlian and osama (project manager and supervisor); 17 workers (5 staff, 12 labourers) and Team Alpha (TM-007), Team Beta (TM-008).
- Client Hamid Raza (CL-0017) and a second client created when the lead was won; lead LEAD-0002.
- Template RN-01, estimate EST-0003, quotation QUO-2026-0002, project PRJ-0007 (Completed).
- Items TILE-01, CEM-01, PAINT-01 and category FIN; expense category `transport`.
- Requisition REQ-2026-0001, RFQ-2026-0001, purchase order PO-2026-0002 (Closed), goods receipt GRN-2026-0001, expense claim EXP-2026-0001 (posted).
- Attendance sheet for Team Alpha on 14/11/2026, a daily progress report with a photo, the November 2026 wage sheet (approved).
- The RFQ used two of the synthetic vendors.
