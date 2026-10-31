import { dprReportEntityType, variationEntityType } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { createTestDb } from '@emporium/db';
import { dumpDatabase, fingerprint, restoreDatabase } from './backup.js';
import { expected } from './expected.js';
import { runIntegrityChecks } from './integrity.js';
import { client, PNG_BASE64, val, type Client } from './scenario-kit.js';

/** Gate A end-to-end scenario (P1-21 BR-2). Steps run in order and share `s`. */
describe('Gate A scenario', () => {
  let h: Harness;
  let c: Client;
  const s: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHarness();
    c = client(h);
  });
  afterAll(() => h.close());

  it('step 1: master data (client, vendor, items, store)', async () => {
    const clientParty = await c.send('admin', 'POST', '/master/parties', {
      name: 'Synthetic Client One',
      roles: ['client'],
      city: 'Lahore',
    });
    s.clientId = val(clientParty.body, 'id');
    const vendor = await c.send('admin', 'POST', '/master/parties', {
      name: 'Synthetic Vendor One',
      roles: ['vendor'],
      city: 'Lahore',
    });
    s.vendorId = val(vendor.body, 'id');
    const codes = await c.send<{ items: { id: string; code: string }[] }>(
      'admin',
      'GET',
      '/master/cost-codes',
    );
    expect(codes.body.items.length).toBeGreaterThan(3);
    for (const code of codes.body.items) s[`code${code.code}`] = code.id;
    s.cementId = val(
      (
        await c.send('admin', 'POST', '/master/items', {
          code: 'CEM-OPC',
          name: 'Cement OPC 50kg bag',
          unitCode: 'bag',
          itemKind: 'material',
          defaultTaxKind: 'goods',
          defaultCostCodeId: s.code100,
        })
      ).body,
      'id',
    );
    s.warehouseId = val(
      (
        await c.send('storekeeper', 'POST', '/inventory/stores', {
          code: 'WH-1',
          name: 'Main warehouse',
          kind: 'warehouse',
        })
      ).body,
      'id',
    );
    expect(Object.keys(s).length).toBeGreaterThan(5);
  });

  it('step 2: lead, site visit, estimate from a template', async () => {
    const lead = await c.send('pm', 'POST', '/crm/leads', {
      partyId: s.clientId,
      workType: 'boundary_wall',
      sector: 'private',
      siteAddress: 'Plot 12, Synthetic Town, Lahore',
      expectedValue: '600000',
      sourceCode: 'referral',
    });
    s.leadId = val(lead.body, 'id');
    await c.send('pm', 'POST', `/crm/leads/${s.leadId}/visits`, {
      visitDate: '2026-10-26',
      notes: 'Measured 100 m of boundary wall',
    });
    const template = await c.send('pm', 'POST', '/estimation/templates', {
      code: 'BW-100',
      name: 'Boundary wall per metre',
      workType: 'boundary_wall',
      parameters: [{ key: 'length', label: 'Length', unit: 'm' }],
      lines: [
        {
          description: 'Cement',
          lineKind: 'material',
          itemId: s.cementId,
          costCodeId: s.code100,
          unitCode: 'bag',
          qtyFormula: 'length * 2',
          defaultRate: '1250',
        },
        {
          description: 'Mason and helper labour',
          lineKind: 'labour',
          costCodeId: s.code200,
          unitCode: 'day',
          qtyFormula: 'length * 1.5',
          defaultRate: '1200',
        },
      ],
    });
    s.templateId = val(template.body, 'id');
    const estimate = await c.send('pm', 'POST', '/estimation/estimates/from-template', {
      templateId: s.templateId,
      title: 'Boundary wall, Plot 12',
      sector: 'private',
      leadId: s.leadId,
      partyId: s.clientId,
      overheadPercent: '10',
      contingencyPercent: '5',
      targetMarginPercent: '20',
      parameterValues: { length: '100' },
    });
    s.estimateId = val(estimate.body, 'id');
    // BR-3: cost 250,000.00 + 180,000.00 = 430,000.00; overhead 10% 43,000.00; contingency 5% 21,500.00.
    const summary = await c.send('pm', 'GET', `/estimation/estimates/${s.estimateId}/summary`);
    expect(val(summary.body, 'totals.companyCost')).toBe(expected('estimate.companyCost'));
    expect(val(summary.body, 'totals.overheadAmount')).toBe(expected('estimate.overhead'));
    expect(val(summary.body, 'totals.contingencyAmount')).toBe(expected('estimate.contingency'));
    expect(val(summary.body, 'totals.totalCost')).toBe(expected('estimate.totalCost'));
  });

  it('step 3: quotation with margin approval, acceptance and project creation', async () => {
    const current = await c.send('pm', 'GET', `/estimation/estimates/${s.estimateId}`);
    await c.send('pm', 'POST', `/estimation/estimates/${s.estimateId}/lock`, {
      version: Number(val(current.body, 'version')),
    });
    const quotation = await c.send('pm', 'POST', '/quotations', {
      estimateId: s.estimateId,
      title: 'Boundary wall, Plot 12',
      partyId: s.clientId,
      leadId: s.leadId,
      scopeText: 'Boundary wall, 100 m',
      price: '618125.00',
      stages: [
        { name: 'Advance', basis: 'percent', percent: '30' },
        { name: 'Wall complete', basis: 'percent', percent: '70' },
      ],
    });
    s.quotationId = val(quotation.body, 'id');
    const url = `/quotations/${s.quotationId}`;
    await c.send('pm', 'POST', `${url}/submit`, { version: await c.versionOf('pm', url) });
    await c.approveInbox('owner');
    await c.send('pm', 'POST', `${url}/issue`, { version: await c.versionOf('pm', url) });
    const accepted = await c.send('pm', 'POST', `${url}/accept`, {
      version: await c.versionOf('pm', url),
      acceptedByName: 'Synthetic Client One',
    });
    await c.deliver();
    expect(val(accepted.body, 'status')).toBe('accepted');
    expect(val(accepted.body, 'price')).toBe(expected('quotation.price'));
    // BR-3: 30% of 618,125.00 is 185,437.50 and the balance is 432,687.50.
    expect(val(accepted.body, 'stages.0.amount')).toBe(expected('quotation.stage1'));
    expect(val(accepted.body, 'stages.1.amount')).toBe(expected('quotation.stage2'));
    const projects = await c.send<{ items: { id: string; name: string }[] }>(
      'pm',
      'GET',
      '/projects',
    );
    expect(projects.body.items).toHaveLength(1);
    s.projectId = val(projects.body, 'items.0.id');
    const project = await c.send('pm', 'GET', `/projects/${s.projectId}`);
    expect(val(project.body, 'originalContractValue')).toBe(expected('project.contractValue'));
    expect(val(project.body, 'status')).toBe('planning');
    const purl = `/projects/${s.projectId}`;
    await c.send('pm', 'PATCH', purl, {
      projectManagerId: h.userId('pm'),
      startDate: '2026-10-26',
      version: await c.versionOf('pm', purl),
    });
    await c.send('pm', 'PUT', `${purl}/supervisors`, {
      supervisors: [{ userId: h.userId('supervisor'), fromDate: '2026-10-26' }],
    });
    await c.send('pm', 'POST', `${purl}/status`, {
      status: 'active',
      version: await c.versionOf('pm', purl),
    });
    await c.send('pm', 'PUT', `${purl}/budget`, {
      version: await c.versionOf('pm', purl),
      lines: [
        { costCodeId: s.code100, budgetAmount: '250000.00' },
        { costCodeId: s.code200, budgetAmount: '180000.00' },
      ],
    });
    const task = await c.send('pm', 'POST', `${purl}/tasks`, { name: 'Foundation and wall' });
    s.taskId = val(task.body, 'id');
  });

  it('step 4: requisition, RFQ, purchase order and partial receipt', async () => {
    const requisition = await c.send('pm', 'POST', '/procurement/requisitions', {
      storeId: s.warehouseId,
      requiredBy: '2026-10-30',
      lines: [
        { itemId: s.cementId, quantity: '200', costCodeId: s.code100, estimatedRate: '1250' },
      ],
    });
    s.requisitionId = val(requisition.body, 'id');
    s.reqLineId = val(requisition.body, 'lines.0.id');
    const rurl = `/procurement/requisitions/${s.requisitionId}`;
    await c.send('pm', 'POST', `${rurl}/submit`, { version: await c.versionOf('pm', rurl) });
    await c.approveInbox('owner');
    expect(val((await c.send('pm', 'GET', rurl)).body, 'status')).toBe('approved');
    const rfq = await c.send('procurement', 'POST', '/procurement/rfqs', {
      requisitionId: s.requisitionId,
      vendorIds: [s.vendorId],
    });
    s.rfqId = val(rfq.body, 'id');
    const quote = await c.send('procurement', 'POST', '/procurement/quotes', {
      rfqId: s.rfqId,
      vendorId: s.vendorId,
      lines: [{ requisitionLineId: s.reqLineId, rate: '1240' }],
    });
    s.quoteId = val(quote.body, 'id');
    await c.send('procurement', 'POST', `/procurement/rfqs/${s.rfqId}/select-vendor`, {
      requisitionLineId: s.reqLineId,
      quoteId: s.quoteId,
    });
    const po = await c.send('procurement', 'POST', '/procurement/purchase-orders/from-rfq', {
      rfqId: s.rfqId,
      vendorId: s.vendorId,
      orderDate: '2026-10-26',
    });
    s.poId = val(po.body, 'id');
    s.poLineId = val(po.body, 'lines.0.id');
    // BR-3: 200 bags at 1,240.00 is 248,000.00.
    expect(val(po.body, 'total')).toBe(expected('po1.total'));
    const purlPo = `/procurement/purchase-orders/${s.poId}`;
    await c.send('procurement', 'POST', `${purlPo}/submit`, {
      version: await c.versionOf('procurement', purlPo),
    });
    await c.approveInbox('owner');
    expect(val((await c.send('procurement', 'GET', purlPo)).body, 'status')).toBe('approved');
    const grn = await c.send('storekeeper', 'POST', '/procurement/grns', {
      poId: s.poId,
      receivedOn: '2026-10-26',
      deliveryNoteRef: 'DN-001',
      lines: [{ poLineId: s.poLineId, acceptedQty: '120' }],
      photos: [{ fileName: 'challan.png', contentBase64: PNG_BASE64 }],
    });
    await c.deliver();
    s.grnId = val(grn.body, 'id');
    const stock = await c.send('storekeeper', 'GET', '/inventory/stock');
    expect(val(stock.body, 'items.0.quantity')).toBe(expected('stock.afterGrn1'));
  });

  it('step 5: issue to project with weighted average, then FIFO after a policy switch', async () => {
    // BR-3: 50 bags at the weighted average of 1,240.00 cost 62,000.00.
    const issue = await c.send('storekeeper', 'POST', '/inventory/issues', {
      storeId: s.warehouseId,
      itemId: s.cementId,
      quantity: '50',
      costObject: { type: 'project', id: s.projectId },
      costCodeId: s.code100,
      businessDate: '2026-10-26',
    });
    expect(val(issue.body, 'value')).toBe(expected('issue1.value'));

    // The accountant switches the company to FIFO; the owner approves; the transition runs.
    await c.send('accountant', 'POST', '/valuation/policies', {
      scope: 'company',
      method: 'fifo',
      effectiveFrom: '2026-10-26',
    });
    await c.approveInbox('owner');
    const transition = await c.send('accountant', 'POST', '/valuation/transitions/run', {});
    // The 70 bags left (120 - 50) carry over at 70 x 1,240.00 = 86,800.00.
    expect(val(transition.body, 'items.0.quantity')).toBe(expected('transition.quantity'));
    expect(val(transition.body, 'items.0.valueBefore')).toBe(expected('transition.valueBefore'));
    expect(val(transition.body, 'items.0.valueAfter')).toBe(expected('transition.valueAfter'));

    // A second order at 1,300.00: 100 bags, 130,000.00.
    const po2 = await c.send('procurement', 'POST', '/procurement/purchase-orders', {
      vendorId: s.vendorId,
      storeId: s.warehouseId,
      orderDate: '2026-10-26',
      lines: [{ itemId: s.cementId, quantity: '100', rate: '1300', costCodeId: s.code100 }],
    });
    expect(val(po2.body, 'total')).toBe(expected('po2.total'));
    const po2url = `/procurement/purchase-orders/${val(po2.body, 'id')}`;
    await c.send('procurement', 'POST', `${po2url}/submit`, {
      version: await c.versionOf('procurement', po2url),
    });
    await c.approveInbox('owner');
    await c.send('storekeeper', 'POST', '/procurement/grns', {
      poId: val(po2.body, 'id'),
      receivedOn: '2026-10-26',
      lines: [{ poLineId: val(po2.body, 'lines.0.id'), acceptedQty: '100' }],
      photos: [{ fileName: 'challan2.png', contentBase64: PNG_BASE64 }],
    });
    await c.deliver();

    // BR-3 (FIFO): 90 bags take the 70 old bags (86,800.00) and 20 new bags (26,000.00) = 112,800.00.
    const fifo = await c.send('storekeeper', 'POST', '/inventory/issues', {
      storeId: s.warehouseId,
      itemId: s.cementId,
      quantity: '90',
      costObject: { type: 'project', id: s.projectId },
      costCodeId: s.code100,
      businessDate: '2026-10-26',
    });
    expect(val(fifo.body, 'value')).toBe(expected('issue2.value'));
    const stock = await c.send('storekeeper', 'GET', '/inventory/stock');
    expect(val(stock.body, 'items.0.quantity')).toBe(expected('stock.afterIssue2'));
  });

  it('step 6: client-supplied material is received and used without cost', async () => {
    const tiles = await c.send('admin', 'POST', '/master/items', {
      code: 'TILE-CL',
      name: 'Client supplied tiles',
      unitCode: 'sqm',
      itemKind: 'material',
      defaultTaxKind: 'goods',
      defaultCostCodeId: s.code100,
    });
    s.tilesId = val(tiles.body, 'id');
    await c.send('storekeeper', 'POST', '/inventory/client-receipts', {
      storeId: s.warehouseId,
      itemId: s.tilesId,
      quantity: '40',
      ownerPartyId: s.clientId,
      projectId: s.projectId,
      businessDate: '2026-10-26',
    });
    const used = await c.send('storekeeper', 'POST', '/inventory/issues', {
      storeId: s.warehouseId,
      itemId: s.tilesId,
      quantity: '25',
      ownership: 'client',
      ownerPartyId: s.clientId,
      costObject: { type: 'project', id: s.projectId },
      businessDate: '2026-10-26',
    });
    expect(used.body.value ?? null).toBeNull();
    const balance = await c.send('storekeeper', 'GET', `/inventory/client-material/${s.projectId}`);
    expect(val(balance.body, '0.received')).toBe(expected('client.received'));
    expect(val(balance.body, '0.used')).toBe(expected('client.used'));
    expect(val(balance.body, '0.balance')).toBe(expected('client.balance'));
  });

  it('step 7: variation approved by the client', async () => {
    // Extra work: cost 40,000.00, price 52,000.00.
    const variation = await c.send('pm', 'POST', `/projects/${s.projectId}/variations`, {
      title: 'Extra plaster on boundary wall',
      reason: 'Client asked for plaster on both faces',
      discoveredOn: '2026-10-26',
      lines: [
        {
          description: 'Plaster',
          costCodeId: s.code200,
          costAmount: '40000.00',
          priceAmount: '52000.00',
        },
      ],
    });
    const vurl = `/variations/${val(variation.body, 'id')}`;
    await c.send('pm', 'POST', `${vurl}/submit-internal`, {
      version: await c.versionOf('pm', vurl),
    });
    await c.approveInbox('owner');
    await c.send('pm', 'POST', `${vurl}/send-to-client`, {
      version: await c.versionOf('pm', vurl),
    });
    await c.upload('pm', variationEntityType, vurl.split('/').pop() as string, 'client-letter.png');
    await c.send('pm', 'POST', `${vurl}/client-approve`, {
      version: await c.versionOf('pm', vurl),
      reference: 'Client letter 14',
      approvedOn: '2026-10-26',
    });
    await c.deliver();
    // BR-3: 618,125.00 + 52,000.00 = 670,125.00.
    const contract = await c.send('pm', 'GET', `/projects/${s.projectId}/contract-value`);
    expect(val(contract.body, 'approvedPriceImpact')).toBe(expected('variation.priceImpact'));
    expect(val(contract.body, 'currentContractValue')).toBe(expected('contract.current'));
  });

  it('step 8: site expense claim approved and posted', async () => {
    await c.send('accountant', 'PUT', '/expenses/categories', {
      categories: [
        {
          code: 'transport',
          name: 'Transport',
          defaultCostCodeId: s.code500,
          receiptRequired: false,
          maxWithoutReceipt: '5000.00',
        },
      ],
    });
    const claim = await c.send('supervisor', 'POST', '/expenses/claims', {
      lines: [
        {
          expenseDate: '2026-10-26',
          category: 'transport',
          description: 'Rickshaw for sand',
          costObjectType: 'project',
          costObjectId: s.projectId,
          costCodeId: s.code500,
          amount: '2000.00',
        },
        {
          expenseDate: '2026-10-26',
          category: 'transport',
          description: 'Tea for labour',
          costObjectType: 'project',
          costObjectId: s.projectId,
          costCodeId: s.code500,
          amount: '1500.50',
        },
      ],
    });
    const curl = `/expenses/claims/${val(claim.body, 'id')}`;
    await c.send('supervisor', 'POST', `${curl}/submit`, {
      version: await c.versionOf('supervisor', curl),
    });
    await c.approveInbox('owner');
    await c.send('accountant', 'POST', `${curl}/post`, {
      version: await c.versionOf('accountant', curl),
    });
    await c.deliver();
    // BR-3: site expenses 2,000.00 + 1,500.50 = 3,500.50 posted.
    const summary = await c.send('pm', 'GET', `/projects/${s.projectId}/summary`);
    const lines = val<{ costCodeId: string; posted: string }[]>(summary.body, 'lines');
    expect(lines.find((line) => line.costCodeId === s.code500)?.posted).toBe(
      expected('expense.total'),
    );
  });

  it('step 9: supervisor daily progress report with photos', async () => {
    const report = await c.send('supervisor', 'POST', '/dpr/reports', {
      projectId: s.projectId,
      reportDate: '2026-10-26',
      weather: 'clear',
      workDone: 'Excavation for the wall foundation',
      manpowerManual: [{ trade: 'mason', count: 4 }],
      taskUpdates: [{ taskId: s.taskId, percentComplete: 20 }],
    });
    s.dprId = val(report.body, 'id');
    await c.upload('supervisor', dprReportEntityType, s.dprId, 'site-1.png');
    const durl = `/dpr/reports/${s.dprId}`;
    await c.send('supervisor', 'POST', `${durl}/submit`, {
      version: await c.versionOf('supervisor', durl),
    });
    await c.send('pm', 'POST', `${durl}/review`, { version: await c.versionOf('pm', durl) });
    const done = await c.send('pm', 'GET', durl);
    expect(val(done.body, 'status')).toBe('reviewed');
    expect(val<number>(done.body, 'photoCount')).toBe(1);
  });

  it('step 10: workers, a team and a week of approved attendance', async () => {
    // H-11 inputs of the pilot: a month is divided by 26 working days.
    for (const [key, value] of [
      ['workforce.working_days_basis', 26],
      ['attendance.overtime_multiplier', '1.5'],
    ] as const) {
      const current = await c.send('admin', 'GET', `/admin/settings/${key}`);
      await c.send('admin', 'PUT', `/admin/settings/${key}`, {
        value,
        version: Number(val(current.body, 'version')),
      });
    }
    const workers = [
      ['W-001', 'Synthetic Mason', 'daily', 'daily_rate', '1500'],
      ['W-002', 'Synthetic Helper', 'daily', 'daily_rate', '1000'],
      ['W-003', 'Synthetic Foreman', 'permanent', 'monthly_salary', '39000'],
    ] as const;
    s.workerIds = '';
    for (const [code, fullName, employmentType, payBasis, amount] of workers) {
      const worker = await c.send('owner', 'POST', '/workforce/workers', {
        code,
        fullName,
        // Synthetic CNIC: the 00000 area prefix is never issued.
        cnic: `00000-000000${code.slice(-1)}-0`,
        tradeCode: 'mason',
        employmentType,
        joinedOn: '2026-01-01',
      });
      const workerId = val(worker.body, 'id');
      await c.send('owner', 'POST', `/workforce/workers/${workerId}/rates`, {
        payBasis,
        amount,
        effectiveFrom: '2026-01-01',
      });
      s.workerIds += `${workerId},`;
    }
    const team = await c.send('pm', 'POST', '/workforce/teams', {
      name: 'Wall crew',
      supervisorUserId: h.userId('supervisor'),
    });
    s.teamId = val(team.body, 'id');
    await c.send('pm', 'PUT', `/workforce/teams/${s.teamId}/members`, {
      workerIds: s.workerIds.split(',').filter(Boolean),
      version: await c.versionOf('pm', `/workforce/teams/${s.teamId}`),
    });
    const [w1, w2, w3] = s.workerIds.split(',');
    const days = [
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ];
    for (const date of days) {
      h.now.current = new Date(`${date}T14:00:00Z`);
      const sheet = await c.send('supervisor', 'PUT', `/attendance/sheets/${s.teamId}/${date}`, {
        entries: [
          {
            workerId: w1,
            status: 'present',
            ...(date === '2026-10-27'
              ? { overtimeHours: '2', overtimeProjectId: s.projectId }
              : {}),
            allocations: [{ projectId: s.projectId, fraction: '1' }],
          },
          {
            workerId: w2,
            status: date === '2026-10-29' ? 'absent' : 'present',
            allocations: date === '2026-10-29' ? [] : [{ projectId: s.projectId, fraction: '1' }],
          },
          {
            workerId: w3,
            status: date === '2026-10-31' ? 'half_day' : 'present',
            allocations: [{ projectId: s.projectId, fraction: '1' }],
          },
        ],
      });
      const surl = `/attendance/sheets/${val(sheet.body, 'id')}`;
      await c.send('supervisor', 'POST', `${surl}/submit`, {
        version: await c.versionOf('supervisor', surl),
      });
    }
    // Attendance sheets are approved by the project manager role (P1-17 approval rule).
    expect(await c.approveInbox('pm')).toBe(6);
    const sheets = await c.send('pm', 'GET', '/attendance/sheets?limit=50');
    const statuses = val<{ status: string }[]>(sheets.body, 'items').map((sheet) => sheet.status);
    expect(statuses).toEqual(Array(6).fill('approved'));
  });

  it('step 11: monthly wage sheet approved', async () => {
    const period = await c.send('accountant', 'POST', '/wages/periods', { year: 2026, month: 10 });
    s.periodId = val(period.body, 'id');
    await c.send('accountant', 'POST', `/wages/periods/${s.periodId}/calculate`, {});
    const lines = await c.send('accountant', 'GET', `/wages/periods/${s.periodId}/lines`);
    // BR-3: mason 6 x 1,500.00 + 2 h overtime at 1,500 / 8 x 1.5 = 281.25 -> 9,562.50, net 9,563.00;
    // helper 5 x 1,000.00; foreman 39,000 / 26 = 1,500.00 x 5.5 days = 8,250.00.
    expect(val(lines.body, 'lines.0.basicPay')).toBe(expected('wage.mason.basic'));
    expect(val(lines.body, 'lines.0.overtimePay')).toBe(expected('wage.mason.overtime'));
    expect(val(lines.body, 'lines.0.netPay')).toBe(expected('wage.mason.net'));
    expect(val(lines.body, 'lines.1.netPay')).toBe(expected('wage.helper.net'));
    expect(val(lines.body, 'lines.2.netPay')).toBe(expected('wage.foreman.net'));
    expect(val(lines.body, 'totals.grossPay')).toBe(expected('wage.gross'));
    expect(val(lines.body, 'totals.netPay')).toBe(expected('wage.net'));
    const purl = `/wages/periods/${s.periodId}`;
    await c.send('accountant', 'POST', `${purl}/submit`, {
      version: await c.versionOf('accountant', purl),
      acknowledgeWarnings: true,
    });
    await c.approveInbox('owner');
    const approved = await c.send('accountant', 'GET', purl);
    expect(val(approved.body, 'status')).toBe('approved');
  });

  it('step 12: project cost report', async () => {
    const summary = await c.send('pm', 'GET', `/projects/${s.projectId}/summary`);
    const report = await c.send('pm', 'GET', `/reports/project-cost?projectId=${s.projectId}`);
    // BR-3: budget 250,000.00 + (180,000.00 + 40,000.00 variation cost) = 470,000.00; posted stock
    // 62,000.00 + 112,800.00 = 174,800.00 and expenses 3,500.50; approved labour 22,812.50.
    expect(val(summary.body, 'budget')).toBe(expected('cost.budget'));
    expect(val(summary.body, 'totals.posted')).toBe(expected('cost.posted'));
    expect(val(summary.body, 'totals.approved')).toBe(expected('cost.approved'));
    expect(val(report.body, 'totals.budget')).toBe(expected('cost.budget'));
    expect(val(report.body, 'totals.posted')).toBe(expected('cost.posted'));
    expect(val(report.body, 'totals.approved')).toBe(expected('cost.approved'));
    expect(val(report.body, 'totals.used')).toBe(expected('cost.used'));
    expect(val(report.body, 'totals.variance')).toBe(expected('cost.variance'));
    expect(val(report.body, 'totals.percentUsed')).toBe(expected('cost.percentUsed'));
  });

  it('step 12b: supervisors see only their own projects and no rates or costs (BR-4)', async () => {
    // The assigned supervisor reads the project but not its cost entries or any pay rate.
    expect((await h.call('supervisor', 'GET', `/projects/${s.projectId}`)).status).toBe(200);
    expect(
      (await h.call('supervisor', 'GET', `/projects/${s.projectId}/cost-entries`)).status,
    ).toBe(403);
    const [workerId] = (s.workerIds ?? '').split(',');
    expect((await h.call('supervisor', 'GET', `/workforce/workers/${workerId}/rate`)).status).toBe(
      403,
    );
    expect((await h.call('supervisor', 'GET', `/workforce/workers/${workerId}/rates`)).status).toBe(
      403,
    );
    // Another supervisor, not assigned to the project, is refused.
    const other = await h.call('supervisor2', 'GET', `/projects/${s.projectId}`);
    expect([403, 404]).toContain(other.status);
    const list = await c.send<{ items: unknown[] }>('supervisor2', 'GET', '/projects');
    expect(list.body.items).toEqual([]);
    expect((await h.call('supervisor2', 'GET', `/dpr/reports/${s.dprId}`)).status).not.toBe(200);
  });

  it('step 12c: a government project cannot be created while the flag is off (BR-4)', async () => {
    const res = await h.call('pm', 'POST', '/projects', {
      name: 'Synthetic government job',
      partyId: s.clientId,
      sector: 'government',
      originalContractValue: '1000000.00',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const rows = await h.db.query(`select 1 from prj_projects where sector = 'government'`);
    expect(rows).toEqual([]);
  });

  it('step 13: integrity checks hold after the whole scenario (BR-6)', async () => {
    await c.deliver();
    expect(await runIntegrityChecks(h.db)).toEqual([]);
    const stock = await c.send('storekeeper', 'GET', '/inventory/integrity');
    expect(stock.status).toBe(200);
  });

  it('step 14: backup and restore rehearsal passes the integrity checks (BR-7)', async () => {
    const dump = await dumpDatabase(h.db);
    const fresh = await createTestDb();
    await restoreDatabase(fresh, dump);
    expect(await fingerprint(fresh)).toEqual(await fingerprint(h.db));
    expect(await runIntegrityChecks(fresh)).toEqual([]);
    // The restored database keeps working: a new ledger row gets the next sequence number.
    const [before] = await fresh.query<{ top: string }>(
      'select max(seq)::text as top from inv_ledger',
    );
    await fresh.query(
      `insert into inv_ledger (id, store_id, item_id, ownership, movement_type, quantity, unit_cost, value,
                               source_doc_type, source_doc_id, business_date, idempotency_key)
       select gen_random_uuid(), store_id, item_id, 'company', 'adjustment_in', 1, 1, 1,
              'count', gen_random_uuid(), '2026-10-26', 'restore-check' from inv_balances limit 1`,
    );
    const [after] = await fresh.query<{ top: string }>(
      'select max(seq)::text as top from inv_ledger',
    );
    expect(Number(after?.top)).toBe(Number(before?.top) + 1);
  });
});
