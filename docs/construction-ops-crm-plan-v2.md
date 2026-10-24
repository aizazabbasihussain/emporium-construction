# Construction Operations System: Revised Plan (v2)

**Company:** Building construction company (Islamabad and Punjab), with paid maintenance as a secondary service
**Replaces:** `construction-ops-crm-plan.md` (v1 is unchanged and kept for reference)
**Document date:** 23 October 2026
**Status:** Draft for review. Items marked **(confirm)** need a decision or sign-off from the accountant or the business.

---

## 1. Confirmed Facts About the Business

| Topic | Answer |
|---|---|
| Main business | New walls, small houses, small buildings, and demolition and restructuring |
| Secondary business | Maintenance work, charged to clients |
| Current system | Everything on paper; no accounting or management software |
| Books | Maintained by an **internal accountant** |
| Financial statements needed from the app (year one) | **No** balance sheet or cash-flow statement. Cash, receivables, payables and project profit are enough |
| Tax | Registered with FBR (NTN and STRN); works in **Islamabad and Punjab** (PRA position **(confirm)**) |
| Clients | Mixed: private and government/institutional |
| Contract pricing | **Lump sum**, for both private and government |
| Project size | Under PKR 5 crore each; 5-6 projects running at the same time |
| Materials | The company buys most materials; **some clients supply their own** |
| Labour | Own labour, about **50 workers** in teams under supervisors who go to site; paid **monthly**; some subcontracting |
| Data residency | **Government project data must stay inside Pakistan**; other data has no such rule |
| Hosting plan | Build and pilot in the cloud now to save cost; move to Pakistan-based hosting later through a **hosting provider** |
| Development approach | **Spec-driven development with a Claude agent; no human developer** |
| Not needed now | Retention, EOBI/social-security deductions, bank guarantees and bid security, government deadline |

---

## 2. Scope Decisions

**In scope (core)**
- Leads and clients, lump-sum quotations with internal cost estimates
- Projects with location, contract value, budget, variations
- Procurement and inventory (company-owned and client-owned material)
- Site expenses, daily progress reports (DPR) with photos
- Labour: teams, attendance, monthly wage calculation, cost posted to projects
- Subcontractor orders and payments
- Stage billing, advances, location-based tax, tax withheld by clients
- Receivables, payables, post-dated cheque (PDC) register, cash and bank book
- Project profitability, exports for the internal accountant
- Paid maintenance: tickets, work orders, parts and labour used, service invoicing

**Deferred (add when needed)**
- Retention, EOBI and social-security deductions
- Documents and permits, equipment and rentals, basic HSE and QA
- Native mobile app, client portal, dashboards and analytics

**Not planned**
- Balance sheet, cash-flow statement, period closing, full general ledger (revisit if the accountant later wants the app as the book of record)
- Bank guarantee and bid-security tracking
- AMC contracts, preventive maintenance, QR-coded asset registry, technician app (revisit only if recurring contracts appear)

---

## 3. Delivery Phases

Durations are not estimated, because development is done by an AI agent with business review at each gate and timing depends on review cycles. Plan in small releases and sign each one off before starting the next.

### Phase 0: Discovery and Specifications

- Collect the paper forms (quotation, site report, vouchers, labour register, attendance sheet, invoice) and mirror them in screens and printouts. *(Forms to be supplied later.)*
- Agree the **chart of accounts** with the accountant, and tag every transaction with an account from the start so a fuller ledger can be added later without re-entering history **(confirm)**
- Confirm tax setup by authority (FBR for Islamabad, PRA for Punjab) with rates configurable and effective-dated **(confirm)**
- Set the initial stock valuation policy. Valuation is **configurable**: a company default plus optional per-category overrides, with weighted average and FIFO available (initial default recommended: weighted average, **confirm with accountant**)
- Role and approval matrix: who requests, approves, pays; amount limits
- Prepare opening-data templates (see section 10)
- Write the specification set and acceptance criteria for Phases 1-2
- Record the data-residency rule and the test-data policy (section 7)

### Phase 1: Core Construction Operations

| Area | Features |
|---|---|
| **Foundation** | Login, roles, **approval workflow**, audit trail, notifications, file storage behind a wrapper, English UI with Urdu-ready layout |
| **Master data** | Clients, vendors, subcontractors, items, units, cost codes, workers, teams, tax setup |
| **Leads and clients** | Lead capture, follow-ups, site visits |
| **Quotation** | Lump-sum quotes, internal cost estimate (to see expected margin), reusable job templates (boundary wall, room, slab, demolition), versions, approval, PDF |
| **Projects** | Created from a won quote; **location (Islamabad or Punjab)**; contract value; budget by cost code; variations; basic task list |
| **Procurement** | Requisition, comparison of quotes, purchase order, goods receipt |
| **Inventory** | Stores and site stock; issue to project; transfers; **company-owned vs client-owned flag**; **configurable valuation (weighted average or FIFO, company default with per-category override, effective-dated)** for company-owned stock only |
| **Site expenses** | Petty cash and claims with approval; unapproved claims not counted as cost |
| **DPR** | Daily progress with photos; draft saved on the device and retried if the connection drops |
| **Labour** | Supervisor and team structure; **daily attendance per worker per project**; monthly wage calculation (overtime, advances, deductions); labour cost posted to projects |
| **Reports** | Budget vs committed vs approved vs posted cost per project; stock; pending POs; lead pipeline |
| **Mobile** | Responsive web, usable on phones by supervisors |

**Gate A (operational pilot):** one project (dummy or private-client data) runs from lead to quote, project, purchase, stock issue, attendance and DPR.

### Phase 2: Billing, Money and Control

- **Stage billing** against the lump-sum contract, with advances and approved variations
- **Tax by project location**, separate reports per authority; **tax withheld by clients** recorded against the invoice
- **Receivables:** customer balances, receipts, **PDC register** (pending, deposited, cleared, bounced)
- **Payables:** vendor bills, goods-receipt matching, payment vouchers
- **Subcontractors:** work orders, measured and certified progress, payments, withholding where applicable
- **Monthly payroll finalization** for the 50 workers: wage sheets and payslips (statutory deductions deferred)
- **Cash and bank book** (cash book, bank accounts, simple reconciliation)
- **Project profitability:** contract value vs cost to date vs billed vs collected
- **Exports** (CSV or Excel) for the internal accountant
- Document numbering continues your paper series; tax-invoice numbering rules confirmed by the accountant **(confirm)**

**Gate B (financial go-live, private data only):** verified opening balances loaded; a sample invoice, supplier bill, receipt, payment, stock movement and monthly wage run all post correctly; receivables and payables reconcile to their lists; accountant signs off.

### Phase 3: Paid Maintenance and Service Work

Built on the same customers, inventory, labour and billing already delivered.

- Service requests (phone, WhatsApp-assisted entry by office staff) with priority
- Work orders with assignment, scheduling, status, customer sign-off
- Parts used (issued from inventory) and labour hours charged to the job
- Warranty vs paid flag; service quotation and invoice through the billing engine
- Simple reports: open jobs, turnaround time, job profit, repeat visits
- Add recurring contracts only if the business starts selling them **(confirm)**

### Phase 4: Pakistan Hosting and Government Go-Live

- Select a hosting provider in Pakistan; get written quotes for server, backup and support
- Rebuild the database from the versioned migration files; migrate data
- Production security hardening, access review, monitoring
- **Backups stored inside Pakistan**, with a tested restore
- Re-run Gates A and B on the new environment

**Gate C:** no government project data is entered until this gate is passed. If a government contract arrives earlier, this phase moves ahead of Phase 3.

### Phase 5: Supporting Modules (as needed)

- Retention, EOBI and social-security deductions when the business needs them
- Documents and permits with revision control
- Equipment register and rentals, per-project cost allocation
- Basic safety and quality checklists, defect (snag) tracking

### Phase 6: Mobile App

- Supervisor app for attendance and DPR with full offline sync
- Technician features for maintenance if needed
- Built on the same backend (React Native with Expo)

### Phase 7: Analytics and Portals

- Management dashboards, client portal, WhatsApp notifications, scheduled reports

---

## 4. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | One language across web, backend functions and later mobile |
| Database | **PostgreSQL** (Supabase in the cloud for now) | Chosen for transactions, constraints and reports; not MongoDB |
| Auth and access | Supabase Auth with Row Level Security | Role-based, on every table |
| Logic | Postgres functions for transactional work (stock issue, approvals, posting); Edge Functions sparingly | Keep logic portable |
| Frontend | React (Vite SPA), TanStack Query and Table, Ant Design or shadcn/ui | |
| PDFs | Client-side PDF library | Quotes, invoices, payslips |
| Files | Supabase Storage behind a storage wrapper | Wrapper makes moving to local storage easy |
| Hosting (now) | Cloudflare Pages (frontend) + Supabase (backend) | Free tier of Cloudflare Pages allows commercial use |
| Mobile (later) | React Native (Expo) | Same API |

**Portability rules (so the move to Pakistan is cheap)**
1. Every schema change is a versioned SQL migration file in the repository.
2. Business logic lives in Postgres functions or a thin backend, not in Supabase-only features.
3. All file access goes through one storage wrapper.
4. Use UUID keys, `updated_at` timestamps and soft deletes (also ready for offline sync).
5. No dependence on cloud-only extras that cannot be self-hosted.

**Note:** Docker was left out for the cloud phase. Self-hosted Supabase (or plain Postgres with a backend) in Phase 4 typically uses containers; the hosting provider can handle that.

---

## 5. Hosting and Deployment Model

**Stage A: development and pilot (cloud)**
```
User's browser -> Cloudflare Pages (React app) -> Supabase cloud (database, login, logic, files)
```
- Use **dummy data or private-client data only**.
- Free plans for development; Supabase Pro before real private-client data.

**Stage B: production in Pakistan (before any government data)**
```
User's browser -> App hosted in Pakistan -> Postgres + backend + file storage on Pakistan-based servers
```
- Managed by the **hosting provider** (updates, security, monitoring, backups).
- If private and government data share one system, host the **whole system** in Pakistan. Splitting data by client across two locations is complex.
- Whether the React app files (no company data) may stay on a global CDN is a question for the client or a lawyer **(confirm)**.

---

## 6. Cost Estimate

Prices were found in public sources in October 2026. Confirm on each provider's site before committing.

| Stage | Setup | Monthly cost |
|---|---|---|
| Development | Supabase Free + Cloudflare Pages | $0 |
| Pilot with private-client data | Supabase Pro ($25, includes $10 compute credit) + Cloudflare Pages | about $25 (roughly PKR 7,000-8,000) |
| Government production | Pakistan hosting provider | **Get quotes** (no verified local pricing yet) |

Watch-points: the Free plan pauses after about a week of inactivity and has no reliable backups, so it is for development only. Extra database storage beyond 8 GB is $0.125 per GB. Compress site photos to save storage and data.

---

## 7. Data Residency Policy

- **No government project data enters the cloud system at any time.**
- During development and pilot, use dummy data or private-client projects only.
- Tag each project as `government` or `private`, so any later separation or audit is possible.
- Move to Pakistan hosting (Phase 4) before the first government project is entered.
- Check with each government client whether the rule is written in the contract and whether it covers backups **(confirm)**.

---

## 8. Tax and Accounting Scope

**Tax**
- Company settings hold more than one registration number (FBR now; PRA if applicable **(confirm)**).
- Each project's location decides the tax authority, rate and invoice format.
- Rates and rules are configurable and effective-dated; never hard-coded.
- Separate tax reports per authority.
- Tax withheld by clients is recorded against the invoice so balances still reconcile.
- The accountant signs off the tax setup before financial go-live.

**Accounting (year one, light)**
- Cash and bank book, receivables, payables, PDC register
- Tax tracking, project profitability
- Exports for the internal accountant
- Every transaction tagged with an account code from the chart of accounts agreed in Phase 0

**Stock valuation (configurable):** the valuation method is a setting, not a fixed rule.
- Methods: weighted average and FIFO. LIFO is excluded because IFRS prohibits it **(confirm with accountant)**.
- A company-wide default applies unless an item category has its own override.
- Every policy is effective-dated and changes apply going forward only; past issues keep the cost they were valued at.
- Changing the method while stock exists runs an approval-controlled transition that converts the current stock into the new method's starting state, and total stock value must be identical before and after.
- Valuation applies to company-owned stock only. Client-owned material is tracked by quantity and project, and is **not valued as company cost**.

**Cost status separation (used in all reports):** budget, committed (POs), approved (claims and certified bills), posted (final cost), paid (cash).

---

## 9. Key Modules in More Detail

**Labour (50 workers, monthly pay)**
- Structure: supervisor, team, worker
- Supervisor records daily attendance for their team, per project (workers can move between sites)
- Monthly wage = attendance, overtime, advances, deductions; payslips
- Labour cost allocated to projects by attendance days
- EOBI and social security are deferred; fields should allow adding them later

**Client-supplied material**
- Ownership flag on items and stock: company or client
- Quote and BOQ lines can be marked "client supplies"
- Received, used and balance tracked per project; return or reconciliation at project end
- Not included in company cost or profit

**Demolition and restructuring**
- Survey and inspection records with before/after photos
- Demolition scope, debris removal and disposal cost lines
- Salvaged material (reusable bricks, steel, doors) tracked in stock
- Variation requests for hidden conditions found during work, approved by the client and added to contract value

**Paid maintenance**
- Same customers, items, labour and billing as construction
- Work order costs: parts issued from stock plus labour hours
- Invoice type "service"; warranty jobs flagged as non-billable

---

## 10. Moving From Paper to Digital

1. **Opening balances** entered from templates: clients, vendors, subcontractors, workers, items, cash and bank balances, receivables, payables, advances, PDCs in hand, open projects with cost to date, physical stock count.
2. **Cutover at a clean boundary** (for example, the start of a month), with verified opening balances.
3. **Parallel run:** keep paper in parallel for one to two months and compare.
4. **Training:** short role-based sessions for the accountant, procurement, store, supervisors and management; consider a data-entry person for the first months.
5. **Document numbering** continues your existing series.
6. **Retention and backups:** define how long records are kept, with automated backups and a tested restore.

---

## 11. Spec-Driven Development With a Claude Agent (No Human Developer)

Because no human developer will read the code, the specifications and tests carry the quality.

1. **One spec per module**, each with: purpose, data model, business rules, screens, roles, acceptance criteria and test cases.
2. **Specs are written and approved before coding.** The agent does not invent business rules; undecided items are listed and flagged, not assumed.
3. **Automated tests are mandatory** for money, stock, tax, wage and approval logic (for example, stock issue reduces quantity and posts the right cost; wage calculation matches a hand-checked sheet).
4. **Row Level Security tests:** automated checks that each role sees only what it should.
5. **Version control and migrations** for every change, with a record of what changed and why.
6. **Business acceptance at every gate** by the accountant and operations staff using real scenarios.
7. **Independent review at key points** (recommended): before Gate B and before the Pakistan go-live, have a qualified engineer or security reviewer check access control, financial logic and backups. The cost is small compared with the risk of unreviewed financial software.
8. **Keep releases small** so mistakes are found early and are easy to fix.
9. **Secrets and keys** are never placed in the frontend code; the service key stays server-side only.

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| No human code review | Tests, acceptance gates, and an independent review before financial go-live and Pakistan hosting |
| Wrong tax treatment (FBR vs PRA) | Accountant sign-off; configurable rules |
| Government data placed in the cloud by mistake | Project tag, written policy, dummy data only during build |
| Wrong project profit from missing labour or client-material handling | Labour and ownership flags in Phase 1 |
| Staff reject the system (paper habit) | Mirror paper forms, train, parallel run, data-entry support |
| Supervisors with weak connectivity | Draft saving and retry in Phase 1; full offline in the mobile app (Phase 6) |
| Migration to Pakistan hosting is harder than expected | Portability rules from day one; versioned migrations; tested restore |
| Hosting provider quality or cost | Written quotes, backup and restore terms, support response times |

---

## 13. What Changed From v1 and From the Architect's Review

**Adopted from the architect**
- Light accounting is needed because there is no accounting system (reduced to the scope in section 8)
- A project cost ledger is not a general ledger; separate budget, committed, approved and posted costs
- Separate operational pilot and financial go-live gates
- Decide data residency before choosing production hosting
- Update dependencies together with scope and tests

**Not adopted (does not fit this business)**
- Full general ledger, balance sheet, cash flow, period closing (not needed in year one)
- Parallel maintenance track with AMC, PPM and technician app (maintenance is secondary)
- IPC and retention-heavy billing in Phase 1 (lump-sum contracts)
- Full offline sync in the first release

**New in v2**
- Government/private project tag and the Pakistan-hosting gate
- Client-supplied material handling
- Own-labour module in the first release (50 workers, monthly pay)
- Subcontractor basics
- Paid maintenance phase
- Paper-to-digital cutover and training
- Spec-driven development guardrails for a no-developer team

---

## 14. Open Items

1. **PRA registration:** does the Punjab work require PRA registration alongside FBR? **(accountant)**
2. **Tax invoice numbering rules:** confirm whether gapless numbering is required. **(accountant)**
3. **Stock valuation:** choose the initial company default method (weighted average or FIFO) and any category overrides. The method stays changeable later. **(accountant)**
4. **Chart of accounts and fiscal year.** **(accountant)**
5. **Tax withheld by clients:** which clients, and typical rates. **(accountant)**
6. **Paid maintenance billing:** per job, per visit, or time and materials? Any recurring contracts?
7. **Supervisor phones and site connectivity:** how many have Android phones, and how reliable is the internet?
8. **Number of supervisors and office users.**
9. **Paper forms:** to be supplied before Phase 0 specs are finalized.
10. **Government contract terms:** is Pakistan-only data storage written in contracts, and does it cover backups?
11. **Hosting provider:** shortlist and quotes (Phase 4).
12. **Independent reviewer:** who will review security and financial logic before go-live?
13. **Retention** on government bills and **EOBI/social security:** confirm when they become needed.

---

## 15. Next Steps

1. Review this plan and answer the open items.
2. Collect paper forms and agree the chart of accounts with the accountant.
3. Write the Phase 0 and Phase 1 specifications with acceptance criteria.
4. Set up the development environment (Supabase Free, Cloudflare Pages, repository, migrations, test setup).
5. Build Phase 1 in small releases and run Gate A with dummy data.
