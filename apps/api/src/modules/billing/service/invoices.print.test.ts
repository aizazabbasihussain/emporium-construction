import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBillingKit, type BillingKit } from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit({ company: false });
}, 120_000);
afterAll(() => kit.close());

describe('print model before the company profile exists (BR-11)', () => {
  it('prints empty company details instead of failing', async () => {
    const project = await kit.project();
    const invoice = await kit.draft(project.id, [1]);
    const model = await kit.billing.invoices.printModel(kit.db, invoice.id);
    expect(model.company).toEqual({ name: '', address: null, phone: null, email: null });
  });
});
