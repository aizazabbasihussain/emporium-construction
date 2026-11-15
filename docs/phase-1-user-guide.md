# Phase 1 user guide: one project from start to finish

This guide follows one project through the app: from a lead to a closed project, with people, cost and progress. It is based on the Phase 1 specs (`specs/phase-1`) and the screens in `apps/web`. Menu names are the ones shown in the left menu.

## The big picture

```
Lead -> Estimate -> Quotation -> (client accepts) -> PROJECT (budget created automatically)
                                                         |
        Workers + Teams --> Attendance sheet --approve--> LABOUR COST on project
        Stock issue / Purchase orders / Site expenses --> MATERIAL and EXPENSE COST on project
        Daily progress report + Tasks ---------------------> PROGRESS % on project
                                                         |
                          Monthly wage sheet (pay per worker) + Reports
```

Three ideas explain most of the confusion:

1. **A project is normally created for you.** Accepting a quotation creates the project, its code (`PRJ-...`), its contract value and its budget lines. You only create a project by hand for work that has no quotation.
2. **Cost lands on the project through the cost ledger.** Nobody types cost onto a project. Attendance, stock issues, purchase orders and expense claims each post cost entries when they are _approved_. The project page only shows what was posted.
3. **Almost everything needs an approval.** Quotations, attendance sheets, purchase orders, expense claims and wage sheets go to the **Approvals** inbox. Until approved, they do not count as cost (or count only as "committed").

Cost statuses on the project page:

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| **Committed** | Promised but not spent (an open purchase order)                          |
| **Approved**  | Approved, e.g. approved attendance, issued stock                         |
| **Posted**    | Finalized (for example an expense claim posted by the accountant)        |
| **Reversed**  | Cancelled; it nets to zero and disappears from the totals                |
| **Variance**  | Budget minus (committed + approved + posted). Negative means overspent. |

## Who does what (roles)

| Role                | Does                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| Owner / admin       | Sets up users, approves, reads all cost                                      |
| Project manager     | Estimates, quotations, project, tasks, reviews reports, approves attendance  |
| Procurement officer | Requisitions, RFQs, purchase orders                                          |
| Store keeper        | Receives and issues stock                                                    |
| Accountant          | Posts expenses, calculates wages, valuation                                  |
| Site supervisor     | Daily progress report, attendance for their team, expense claims (phone use) |

Your admin account can open every page, which is the easiest way to test. To test the supervisor view (limited pages, no pay rates), sign in as a user with the `supervisor` role.

---

## Step 0. One-time set-up (do this before the first project)

1. **Company profile** (`Company profile`): company name, address, tax numbers.
2. **Cost codes** (`Cost codes`): the list project cost is grouped by (labour, materials, equipment and so on). The demo data already has 60.
3. **Clients and vendors** (`Clients and vendors`): the client must exist here before you can attach it to a lead, quotation or project.
4. **Settings** (`Settings`): check `labour_cost_code`. Attendance cost is posted to this code. Also check the overtime multiplier and working-days basis, which wages use.
5. **Users** (`Users`): create the project manager, accountant and supervisor accounts and give each a role. Each person also needs a Supabase sign-in with the same email.

## Step 1. Capture the lead

`Leads` -> new lead: client, site, scope, expected value. Move it through the stages with the stage dialog and log `Follow-ups`.

## Step 2. Estimate the job (templates and estimates)

This is the part to understand well, because every later number (quotation price, project budget, expected margin) starts here. A fuller explanation, a worked example and a demo script follow in [Templates and estimates in detail](#templates-and-estimates-in-detail) at the end of this guide. The short version:

1. `Job templates`: a template is a reusable recipe for one kind of job, for example a boundary wall. It holds **parameters** (the few measurements you take from the site, such as length and height) and **lines** (each cost item, with a **formula** that turns the measurements into a quantity).
2. `Estimates` -> **New estimate**: pick a template, give the estimate a title and sector, and type the measurements. The system works out every quantity and fills in the lines. You then edit freely: change a quantity, add or delete a line, enter the proposed price.
3. Check the **Cost and margin** card. When it is right, **Lock** the estimate. The budget of the project is later built from the estimate's company-cost lines, grouped by cost code.

## Step 3. Quote and win

1. `Quotations` -> new quotation from the locked estimate (lump sum, with stages). Review the margin panel and the print preview.
2. Submit it for approval. The owner approves it in `Approvals`.
3. Issue it to the client. When the client agrees, open the quotation and use **Accept**. Enter who accepted it. For a government quotation, attach the signed document first.

**Result: a project is created automatically** (see `Projects`). It has status **Planning**, the contract value equal to the quotation price (this never changes later), and budget lines per cost code.

### Alternative: create a project by hand

`Projects` -> **New project**. Enter name, client, sector (private or government) and contract value. A manual project has **no budget**, so go to the Budget tab and add the lines yourself.

Government sector projects are blocked unless `ALLOW_GOVERNMENT_DATA=true` (it is `false` on purpose outside the Pakistan-hosted production environment). Use **Private** for testing.

## Step 4. Set up the project

Open `Projects` -> the project.

- **Overview**: contract value, progress and the cost summary by cost code (budget, committed, approved, posted, variance).
- **Budget**: check or edit the budget lines (needs the project manager or management role).
- **Tasks**: add the work breakdown, for example "Excavation", "Foundation", "Brickwork". Progress is tracked per task (see Step 8).
- **Status**: change **Planning** to **Active**. Cost can only be posted while the project is Planning or Active.

## Step 5. Assign people to the project

There are three separate things to set up. This is the part that is not obvious.

### 5a. The workers and their pay

`Workers` -> add worker: name, CNIC (13 digits), trade, employment type, joined date. Then add the **pay rate** (daily rate or monthly salary, with an effective date). A worker without a rate blocks attendance submission.

### 5b. The team

`Team board` shows teams and their members. Each team has exactly one supervisor. Move a worker between teams with the "Move to" selector. A worker belongs to one team at a time.

### 5c. The supervisor's access to the project

A supervisor sees only the projects and teams in their **scopes**.

1. `Users` -> open the supervisor -> **Scopes**.
2. Choose type **Project** and enter the **project id**, then **Add scope**. Repeat with type **Team** and the team id.

The page asks for an id, not a name. Copy the project id from the address bar when you open the project (`/projects/<id>`). There is currently no "assign supervisor" button on the project page itself, although the API supports it (`PUT /projects/:id/supervisors`).

**Workers are not "assigned to a project" as a fixed list.** A worker is linked to a project **per day** when the supervisor fills the attendance sheet (Step 6). That is how one worker can split a day between two projects.

## Step 6. Record attendance (this creates employee cost on the project)

Done daily by the supervisor (or an office user).

1. `Attendance sheet`: choose the **team** and the **date** (not in the future; only a short backdating window is allowed).
2. For each worker choose the status: present, half day, absent, paid leave, unpaid leave, off. Add overtime hours (0 to 8) if any.
3. For present and half-day rows, **split the day across projects**. The fractions must add up to exactly 1 (for example 0.5 on project A and 0.5 on project B). Cost code defaults to the labour cost code.
4. **Submit** the sheet.
5. The project manager approves it in `Approvals`. `Attendance sheets` lists sheets and `Missing attendance` shows days with no sheet.

**What happens on approval:** the system posts one cost entry per worker per project, with status **Approved**:

- present: 1 x the worker's daily rate (monthly salary is divided by the working-days basis)
- half day: 0.5 x the daily rate
- overtime: hours x (daily rate / 8) x the overtime multiplier
- multiplied by the project's fraction and rounded to 2 decimals

An approved sheet is locked. To correct it, unlock it with a reason (this reverses its cost entries), edit, and approve again. You cannot unlock once that month's wage sheet is approved.

## Step 7. Other project cost

| Cost             | Where                                                                                         | Effect on the project                                         |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Materials bought | `Requisitions` -> RFQ -> `Purchase orders` -> approve                                         | Committed when approved; actual when received into stock      |
| Materials used   | `Stock on hand`, `Issue material`: issue to the project                                       | Approved cost at the stock valuation (FIFO or average)        |
| Client's own     | `Client material`                                                                             | Tracked, but no cost is posted                                |
| Site expenses    | `My expense claims` (supervisor files with receipt), approver approves, accountant posts      | Approved, then Posted                                         |
| Petty cash       | `Cash advances`, `Custodian balances`                                                         | Advance given to a custodian; claims settle it                |
| Scope changes    | Variations tab on the project                                                                 | Adds approved extra budget lines                              |

## Step 8. Record progress

1. The supervisor files a **daily progress report** (`Daily progress reports` -> new): date, weather, work done (at least 10 characters), **at least one photo**, material notes, and the percent complete of each task.
2. Submitting updates the task percentages automatically. A percent cannot go down without a note.
3. The project manager opens the report and marks it **Reviewed** or **Reopened** for correction. `Missing daily reports` lists projects with no report for a day.
4. **Project progress = the simple average of all task percents.** Every task counts the same. Add tasks of similar size, or the percent will mislead.

The supervisor's phone can save a report offline and send it when the connection returns (P1-20).

## Step 9. Monthly wages

Wages are separate from project cost. Attendance already put labour cost on projects. The wage sheet works out what each worker is actually paid for the month.

1. `Wage sheets` -> create the period for the month.
2. **Calculate**. It reads only **approved** attendance. Daily-rate workers get days worked x rate. Monthly-salary workers get salary / working-days basis x payable days. Overtime and rounding follow the settings.
3. Add **allowances or deductions** (each needs a reason). `Wage advances` holds advances given to workers. They are recovered monthly up to the stated monthly amount.
4. **Submit.** It is blocked while any attendance sheet of that month is unapproved. Days with no sheet are only warnings.
5. The owner approves it in `Approvals`. The sheet locks and advance balances update.
6. Open **Reconciliation**: attendance cost on projects against wage-sheet gross, per worker. Differences are listed.

Actual payment, payslips and the cash book are **Phase 2** and are not in the app yet. Phase 1 stops at an approved wage sheet.

Workers can sign in themselves to see `My attendance`, `My advances` and `My wages` (P1-22).

## Step 10. Read cost and progress on the project

- **Project page, Overview**: contract value, progress %, and the table by cost code with budget, committed, approved, posted and variance. A negative variance means that code is over budget. It is flagged but not blocked, and the warning threshold is 90% of budget by default.
- **Project page, Costs tab**: every cost entry with date, cost code, source (attendance, stock, expense, ...), status and amount. Use it to drill down on a total.
- **Employee expense on the project**: filter the Costs tab for the labour cost code. That total is the sum of approved attendance for that project. The `Reports` page has a labour report (worker-days and cost per project per month) and a project cost report that should match the project summary.
- `Reports`: project cost, procurement, stock, expenses, DPR, labour, leads. Pick the project and date range.

## Step 11. Finish and close the project

1. Complete all tasks (100%) and get the last progress reports reviewed.
2. Change status to **Completed**.
3. To **Close**, there must be **no Committed entries** and no Approved entries still waiting to be posted. The error lists them. Receive or cancel open purchase orders, and post the open expense claims.

   **Known limit found in testing:** only expense claims can be posted in Phase 1. Approved **attendance** cost and goods-**received** cost stay Approved (their posting step is Phase 2), so a project that has either of them is refused with "The project still has committed or unposted approved costs." Treat **Completed** as the end of a project until Phase 2. See `docs/user-manual.md` section 12.
4. Change status to **Closed**. History stays readable.

Billing the client, receipts and profit are **Phase 2**. In Phase 1 you can see cost against budget and contract value, not invoices or profit.

---

## Templates and estimates in detail

### The idea in one minute

A builder prices a boundary wall the same way every time: measure the wall, work out how many bricks, bags of cement and days of labour that length and height need, multiply by prices, add overhead and a safety margin. The app lets you write that recipe down **once** (a template) and reuse it for every wall.

```
TEMPLATE (the recipe)                     ESTIMATE (one real job)
  parameters: length, height      -->      length = 200, height = 6
  lines with formulas:                     lines with real quantities:
    bricks = ceil(length*height*13.5)        bricks = 16,200 nos
    cement = ceil(length*height*0.12)        cement = 144 bags
    ...                                      ...
                                           x rates, + overhead + contingency
                                           = total cost, margin against price
```

- **Template** = reusable, has formulas. Written once by the project manager or estimator.
- **Estimate** = one job, has plain numbers. Created from a template, then edited by hand.
- **Changing a template later never changes existing estimates.** The estimate keeps its own copy of the lines.

### Part A. Build a template (`Job templates`)

Think in this order. Each question maps to one part of the template screen.

| Question to ask yourself                                      | Where it goes                  | Example (boundary wall)                |
| ------------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| What kind of job is this, and what is it called?              | **Code**, **Name**, Work type  | `BW-01`, "Brick boundary wall"         |
| Which few measurements drive the whole price?                 | **Parameters**                 | `length` (ft), `height` (ft)           |
| What are all the things I pay for on this job?                | **Lines**, one per cost item   | bricks, cement, sand, mason, helper    |
| How does each item grow with the measurements?                | **Quantity formula** of a line | bricks = length x height x 13.5        |
| What do I normally pay for one unit?                          | **Default rate** of a line     | brick 25 per nos                       |
| Who buys it: us or the client?                                | **Supplied by**                | company (or client)                    |
| Which budget bucket should this cost land in on the project?  | **Cost code**                  | Materials, Labour                      |

**Parameters**

- A parameter has a **key** (the short name used in formulas), a **label** (what people see when creating an estimate) and a **unit** (shown next to the box).
- The key is lower case, starts with a letter, and may contain digits and underscores, for example `length`, `wall_height`, `rooms`. It must be unique in the template. It cannot be the name of a function (`ceil`, `floor`, `round`, `max`, `min`).
- Keep parameters few. Only add one if the person creating an estimate can actually measure it on site.

**Lines**

| Field           | Meaning                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Description     | Plain name shown on the estimate and quotation                                                                       |
| Kind            | material, labour, subcontract, equipment, disposal or salvage credit                                                 |
| Cost code       | Budget bucket. Its **kind** must fit the line kind (material -> a material code, labour -> a labour code, and so on) |
| Unit            | nos, kg, sqft, bag, day...                                                                                           |
| Quantity formula| How many units, from the parameters (see below)                                                                      |
| Default rate    | Price per unit used when an estimate is created. Leave it empty and the estimate flags the line "Rate missing"       |
| Supplied by     | **company** = our cost. **client** = client brings it: shown, but not counted as our cost and not in the budget      |

If you see "needs a cost code of kind labour", the cost code you picked is of another kind. Choose a cost code whose kind matches the line.

**Salvage credit** lines (money back from selling scrap) count as negative cost and are allowed only for the **demolition** and **restructure** work types.

**Writing quantity formulas**

| You can use                  | Examples                                          |
| ---------------------------- | ------------------------------------------------- |
| Numbers                      | `13.5`, `0.12`                                    |
| Your parameter keys          | `length`, `height`                                |
| `+  -  *  /` and `( )`       | `length * height * 13.5`, `(length + 4) / 2`      |
| `ceil(x)`: round up          | `ceil(length * height * 0.12)` whole bags         |
| `floor(x)`: round down       | `floor(length / 10)`                              |
| `round(x)` or `round(x, n)`  | `round(length * 0.5, 2)`                          |
| `max(a, b)` and `min(a, b)`  | `max(length / 12, 2)` at least 2                  |

Rules to remember:

- Multiplication and division are done before addition and subtraction. Use brackets when unsure.
- A formula may use **only the parameters of its own template**. A typo such as `lenght` is rejected when you save.
- Division by zero and negative results are rejected.
- The result is rounded to 4 decimal places. Use `ceil` for things bought whole (bags, bricks, sheets).
- There is no scripting. Formulas are parsed safely and nothing else can be typed in.

**Test before you save.** The template screen has a **Formula preview**: enter sample values for each parameter and press **Preview formulas**. Each line shows its quantity or the exact error. Do this every time you change a formula.

### Part B. Create an estimate from the template (`Estimates` -> New estimate)

1. Choose the **template**, give the estimate a **title**, choose the **sector** (government or private).
2. Fill in the parameter boxes (for example length 200 ft, height 6 ft). They must be plain non-negative numbers.
3. Press **Create**. The system evaluates every formula and builds the lines. The estimate is a **Draft**.

### Part C. Work in the estimate editor

The screen has three parts, top to bottom:

1. **Estimate details**: title, **Proposed price** (what you plan to quote), **Overhead %**, **Contingency %** and **Target margin %**.
2. **Cost lines**: one row per cost item. You can edit description, kind, cost code, unit, quantity, rate and supplied-by, **Add line**, or **Remove** a line. The right-hand column shows each line total. A red **Rate missing** under a rate means a company line has rate 0.
3. **Cost and margin**: the live totals (below).

Press **Save** to keep your edits. The totals card updates as you type; the figures are always calculated by the server, so what you see is what is saved.

**How the numbers are worked out**

| Figure                               | How                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Line total                           | quantity x rate, rounded to 2 decimals                                                         |
| **Company cost**                     | sum of line totals where supplied by = company (salvage credits count as negative)             |
| Supplied by the client (not in cost) | sum of line totals where supplied by = client, shown for information only                      |
| Overhead                             | company cost x overhead %                                                                      |
| Contingency                          | company cost x contingency %                                                                   |
| **Total estimated cost**             | company cost + overhead + contingency                                                          |
| **Expected margin**                  | proposed price - total estimated cost                                                          |
| **Margin %**                         | expected margin / proposed price. Shown as "-" while there is no price                         |
| Meets / below target                 | margin % compared with the target margin %                                                     |

Overhead is the company's running cost spread over the job. Contingency is a safety allowance for surprises. Neither is added to the project budget (see below).

### Part D. Lock, revise and carry on

- **Lock estimate** freezes the lines and totals. A draft **cannot be locked while any company line has no rate**. Fix the red lines first.
- A locked estimate is read-only. To change it press **Revise**: this makes a new draft copy (revision 2). When revision 2 is locked, revision 1 becomes **superseded**. Old versions stay on file.
- `Quotations` start from a locked estimate. When the client accepts the quotation, the **project budget** is built from the estimate's **company-cost lines, grouped by cost code**. Client-supplied lines, overhead and contingency do not become budget.

### Worked example: brick boundary wall (illustrative prices)

Template **BW-01 Brick boundary wall**, work type Boundary wall.

Parameters: `length` (Length, ft) and `height` (Height, ft).

| # | Description | Kind     | Cost code | Unit | Quantity formula              | Default rate | Supplied by |
| - | ----------- | -------- | --------- | ---- | ----------------------------- | ------------ | ----------- |
| 1 | Bricks      | material | Materials | nos  | `ceil(length * height * 13.5)`| 25           | company     |
| 2 | Cement      | material | Materials | bag  | `ceil(length * height * 0.12)`| 1,300        | company     |
| 3 | Mason       | labour   | Labour    | sqft | `length * height`             | 180          | company     |

The rates are for the demo only. Use your real prices.

**Estimate for a 200 ft wall, 6 ft high** (area 1,200 sqft), overhead 10%, contingency 5%, proposed price 1,100,000, target margin 15%:

| Line     | Quantity | Rate  | Line total |
| -------- | -------- | ----- | ---------- |
| Bricks   | 16,200   | 25    | 405,000.00 |
| Cement   | 144      | 1,300 | 187,200.00 |
| Mason    | 1,200    | 180   | 216,000.00 |

| Figure               | Amount       |
| -------------------- | ------------ |
| Company cost         | 808,200.00   |
| Overhead (10%)       | 80,820.00    |
| Contingency (5%)     | 40,410.00    |
| Total estimated cost | 929,430.00   |
| Proposed price       | 1,100,000.00 |
| Expected margin      | 170,570.00   |
| Margin %             | 15.5064% (meets the 15% target) |

**What if the client supplies the cement?** Change the Cement line to **Supplied by: client**. Company cost drops to 621,000.00, overhead to 62,100.00, contingency to 31,050.00 and total cost to 714,150.00. The 187,200.00 is shown as "Supplied by the client (not in cost)". Margin rises to 385,850.00 (35.0773%). The project budget will not include the cement either.

### Demo script for the owner and users (about 10 minutes)

1. **Open `Job templates`** and show the Boundary wall template: parameters, then lines with formulas. Say: "We write the recipe once."
2. Press **Preview formulas**, type length 200 and height 6. Show the quantities. Type a wrong parameter in a formula such as `lenght` to show the clear error, then undo.
3. **Create an estimate** from it: title "Demo wall", private, length 200, height 6. Show the lines appearing with real quantities.
4. In the editor type **Proposed price 1100000** and **Save**. Read out company cost, overhead, contingency, total cost, margin and the "meets target" tag.
5. Edit a quantity on one line (for example bricks 18,000) and watch the totals move. Remove the rate on one line to show the red **Rate missing** and try **Lock**: it refuses. Fix it.
6. Switch cement to **client supplied** and show company cost dropping while the client value is shown separately.
7. **Lock** the estimate. Show that every field is read-only and that **Revise** is offered.
8. Go on to `Quotations` -> new quotation from this estimate, and later `Projects` to show the budget by cost code created from the same lines.

### Tips for configuring templates well

- **One template per kind of job** (boundary wall, room, slab, demolition), not one per client.
- Choose parameters you really measure. If a quantity depends on something you do not measure, put a fixed number in the formula or add that line by hand in each estimate.
- Use the **same cost codes** you want to track on the project. The estimate's cost code becomes the project's budget bucket, so a wrong code here means a confusing budget later.
- Fill in **default rates** for every company line. Update them when prices change; old estimates keep their own rates.
- Give the **work type** correctly. It controls rules such as salvage credits (demolition and restructure only).
- Keep a short list of **standard overhead, contingency and target margin** values agreed with the owner, and apply them to every estimate.
- The template editor in this version has no item column, so rates come from the **Default rate** you type. They are not looked up from vendor prices automatically.

---

## Quick test script (about 30 minutes, one project)

1. Sign in as admin. Check `Clients and vendors`, `Cost codes`, and `Workers` have demo data.
2. Create a project by hand (private sector, any value). Add two budget lines (labour, materials). Set it **Active**. Add three tasks.
3. In `Workers`, confirm two workers have a rate. In `Team board`, confirm they are in the same team.
4. `Attendance sheet`: pick the team and today. Mark both present, split one 50/50 with another project if you have one, add 2 hours of overtime to one. Submit.
5. `Approvals`: approve the sheet. Open the project: the Costs tab shows the labour entries, and the Overview shows the labour code.
6. `Daily progress reports`: new report with a photo, set one task to 50%. Check the project progress becomes 17% (50 / 3).
7. `Issue material`: issue some stock to the project. Check the materials cost.
8. `Wage sheets`: create this month, calculate, review, submit, approve, then open Reconciliation.
9. Compare `Reports` project cost to the project Overview.

## Things that may surprise you

- If you approve your own submission as admin, the approval engine may refuse it (separation of duties). Use a second user if so.
- Cost shows only after approval. "I recorded it but the project shows nothing" almost always means a pending approval.
- Cost only posts to Planning or Active projects.
- The seeded users may not have a Supabase login. Create the login with the same email to test as them.
- There is no money going out of the app in Phase 1 (no payments, invoices or bank).

---

## Worked example: a 3-room renovation (walked through in the live app)

This section was written while running the app end to end on 14 Nov 2026. Every figure below was entered and checked on screen. Use it as a script for training.

**The job:** Hamid Raza, Rawalpindi, a 3-room renovation (new tiles, plaster and paint, electrical rewiring). Rooms are 12x14, 12x12 and 10x12 ft.

### Set-up that must exist first

| What | Where | Used for |
| --- | --- | --- |
| Company profile | `Company profile` | Print-outs and quotations |
| Cost codes `100 Materials`, `200 Labour` and so on | `Cost codes` | Every estimate line and project budget line needs one |
| The client | `Clients and vendors` -> Add. Choose role **Client** (the form starts as Vendor) | Leads, estimates, quotations, projects |
| A job template | `Job templates` | The recipe the estimate is built from (below) |

### Step A. Client -> `Clients and vendors` -> Add

Name `Hamid Raza`, role Client, phone, address, city. Saved as `CL-0017`. The code is assigned automatically.

### Step B. Lead -> `Leads` -> New lead

Contact name and phone, type of work **Renovation**, sector **Private**, source **Referral**, expected value, site address, notes. Saved as `LEAD-0002`, stage **New**.

Then on the lead page:

1. **Change stage** -> **Visited** (the timeline records "Moved from New to Visited").
2. **Add visit**: date and what you measured. This is where site measurements are kept.
3. **Add follow-up**: a due date and a note ("Call with the quotation"). Overdue follow-ups show in `Follow-ups`.

Stages from New: Visited, Quoted, Negotiation, Won, Lost. Move the lead to **Won** only when the client accepts.

### Step C. Template -> `Job templates` -> New template (`RN-01 Room renovation`)

**Parameters** (what you measure): `floor_area` (sqft) and `wall_area` (sqft).

**Lines** (what you pay for). The unit list is fixed: bag, cum, day, ft, hour, kg, ls, m, nos, sqft, sqm, ton. There is no litre, so price paint per sqft.

| Line | Kind / cost code | Unit | Quantity formula | Rate |
| --- | --- | --- | --- | --- |
| Floor tiles (incl. 5% wastage) | Material / 100 | sqft | `floor_area * 1.05` | 180 |
| Cement and tile adhesive | Material / 100 | bag | `ceil(floor_area * 0.02 + wall_area * 0.025)` | 1,450 |
| Putty, primer and paint (2 coats) | Material / 100 | sqft | `wall_area` | 42 |
| Mason (tiling, plaster) | Labour / 200 | day | `ceil(floor_area / 40 + wall_area / 120)` | 1,800 |
| Electrician (rewiring) | Labour / 200 | day | `ceil(floor_area / 60)` | 2,200 |

Tip: a labour line needs a cost code of kind **Labour**. Choose the **Kind** first, then the cost code.

### Step D. Estimate -> `Estimates` -> New estimate

Pick the template, give a title, choose the client, then type the measurements: floor area **432** sqft (12x14 + 12x12 + 10x12) and wall area **1,440** sqft (144 ft perimeter x 10 ft height).

The system fills the lines. Check them by hand once:

| Line | Quantity | Rate | Total (PKR) |
| --- | --- | --- | --- |
| Tiles | 453.6 | 180 | 81,648 |
| Cement | 45 | 1,450 | 65,250 |
| Paint | 1,440 | 42 | 60,480 |
| Mason | 23 | 1,800 | 41,400 |
| Electrician | 8 | 2,200 | 17,600 |
| **Company cost** | | | **266,378** |

Overhead 10% (26,637.80) and contingency 5% (13,318.90) are added: **total estimated cost 306,334.70**. Enter a proposed price (410,000) and a target margin (25%). The **Cost and margin** card shows margin **103,665.30 = 25.28%** and a message that it meets the target. **Save**, then **Lock estimate**. A locked estimate cannot change; use **Create revision** to change it.

### Step E. Quotation -> `Quotations` -> New quotation

Pick the locked estimate and the client. The price fills in from the estimate (410,000). Open the new quotation (`QUO-2026-0002`, status Draft):

1. The default is one stage, "Full payment 100%". Change it to the real payment plan: **Advance on signing 40%** (164,000), **On completion of tiling and plaster 40%** (164,000), **On handover 20%** (82,000). The stages must add up to 100%. **Save**.
2. **Submit for approval**. The page changes to "Waiting for approval" and the document locks ("Create a revision to change it"). The screen can take several seconds to update; wait before clicking again.

### Step F. Approval -> `Approvals` (signed in as the owner)

The quotation waits for the **management** role. Sign in as the owner (a user with the management role), open `Approvals`, open the request, optionally type a comment, and click **Approve**. (**Reject** ends it; **Return** sends it back for correction.) The inbox also shows other pending items, so check the amount and document before you click.

**You cannot approve your own submission.** The approval engine enforces separation of duties (spec P1-03, BR-3): the person who submitted a document can never approve it, even if they hold the approving role. An administrator who prepares and submits a quotation will find the `Approvals` inbox empty. Someone else with the management role must approve it. Do not work around this by giving the preparer the management role; it does not help and it weakens the control.

**It takes up to a minute to show.** After the owner approves, the quotation page first shows "Approval: Approved" while the status badge still says "Waiting for approval". A background job runs once a minute and moves it to **Approved**. Wait and reload; do not click again.

### Step G. Issue and accept -> the quotation page

1. **Issue to client** (status Issued, "Valid until" is set to 30 days from today). It only changes status inside the app; send the PDF to the client yourself (**Download PDF**).
2. When the client agrees: **Record acceptance**. Type who accepted and a note. For a private job a signed document is optional (it is required for government jobs). Wait for the spinner to finish; the status becomes **Accepted**.
3. **The project is created automatically** within about a minute (the same background job). Find it in `Projects`: here `PRJ-0007`, status **Planning**, contract value 410,000.

### Step H. Check the project budget -> `Projects` -> the project

The **Overview** tab shows **Budget against cost** by cost code. It is copied from the locked estimate's company-cost lines, grouped by cost code:

| Cost code | Budget (PKR) | From |
| --- | --- | --- |
| 100 Materials | 207,378 | tiles 81,648 + cement 65,250 + paint 60,480 |
| 200 Labour | 59,000 | mason 41,400 + electrician 17,600 |
| **Total** | **266,378** | company cost only |

The budget does **not** include overhead (26,637.80) or contingency (13,318.90), so it is smaller than the estimate's total cost (306,334.70). The difference is the project's cushion. Contract value stays at the quotation price (410,000) and never changes; scope changes are made as variations.

### Step I. Win the lead -> the lead page, **Change stage** -> Won

Moving a lead to **Won** closes it and **creates the client automatically** from the lead's contact name and phone. Open follow-ups on the lead are cancelled.

**Order matters.** If you have already created the same client by hand (same name and same phone), the move is refused with a "409 conflict", because master data does not allow two parties with the same name and phone. Either let the lead create the client (do not add the client first), or make the lead's contact name different. In the walkthrough, we had added the client first, so we renamed the lead's contact to "Hamid Raza (Satellite Town site)" and moved it to Won. That created a second client record, which should be deleted afterwards if it is not needed.

### Step J. Set up the project -> `Projects` -> the project

1. **Tasks tab**: type a task name and click **Add task**. We added four of similar size: Electrical rewiring, Plaster, Tiling, Painting. Progress is the simple average of the task percentages, so equal-sized tasks give honest progress. Adding is slow on a remote database; add one at a time and wait for it to appear (a fast second click can be lost).
2. **Change status** -> **Active**. Until the project is Active, supervisors cannot report progress or attendance against it, and cost cannot be posted to it.

### Step K. Pay rates -> `Workers` -> the worker -> **Pay rates**

Attendance cannot be submitted for a worker with no pay rate, so set it before the first sheet. On the worker page choose the pay basis (daily rate is the default), type the amount and the **From** date, then **Add rate**. The page says "The rate is saved". Rates used in the example (daily, from 1 Nov 2026): mason 1,800; helper 1,000; electrician 2,200; civil engineer 3,000.

For many workers, use `Data import` with the **Worker pay rates** importer instead of typing each one (it needs the importer permission, held by the administrator and the accountant). The owner (management role) can set rates one by one but cannot run imports.

### Step L. Link the supervisor to the project and team -> `Users` -> **Projects and teams**

A supervisor sees only the projects and teams in their **scopes**. The team scope is added automatically when a team is created with that person as supervisor (Saqlian already had one scope for Team Alpha). The **project** scope must be added by an administrator: open `Users`, the supervisor's **Projects and teams** button, choose type Project, paste the project id (the long code in the address bar of the project page) and **Add scope**. The owner (management role) can read the Users page but cannot change roles or scopes.

### Tips learned while testing

- Lists on a slow connection can briefly show "No data" before the rows arrive. Wait a few seconds before concluding a list is empty.
- If a button seems to spin forever, check the API terminal. A save can succeed on the server even when the screen does not update; reload the page and look at the timeline or history.
- Several actions finish through a background job that runs once a minute (approval outcome, project creation). If the screen has not changed, wait a minute and reload before repeating the action.
- Every user must have a Supabase sign-in with the same email before they can use the app. Creating the user under `Users` alone is not enough.
