import type { Stage } from './stages.js';

export interface PrintCompany {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface PrintRegistration {
  authority: string;
  registrationType: string;
  number: string;
}

export interface PrintClient {
  name: string;
  address: string | null;
  city: string | null;
}

export interface PrintSource {
  number: string;
  revision: number;
  title: string;
  issuedOn: string | null;
  expiresOn: string | null;
  validityDays: number;
  scopeText: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  price: string;
}

export interface QuotationPrintModel {
  company: PrintCompany;
  registrations: PrintRegistration[];
  client: PrintClient;
  quotation: {
    number: string;
    revision: number;
    title: string;
    issuedOn: string | null;
    expiresOn: string | null;
    validityDays: number;
  };
  scope: string;
  inclusions: string;
  exclusions: string;
  stages: {
    stageNo: number;
    name: string;
    percent: string;
    amount: string;
    condition: string | null;
  }[];
  terms: string;
  price: string;
  priceNote: string;
}

/**
 * BR-8: the print model lists exactly these fields. Estimate cost, overhead and margin are never
 * copied in, so no print output can show them.
 */
export function buildPrintModel(input: {
  company: PrintCompany;
  registrations: readonly PrintRegistration[];
  client: PrintClient;
  quotation: PrintSource;
  stages: readonly Stage[];
}): QuotationPrintModel {
  const { company, client, quotation } = input;
  return {
    company: {
      name: company.name,
      address: company.address,
      phone: company.phone,
      email: company.email,
    },
    registrations: input.registrations.map((r) => ({
      authority: r.authority,
      registrationType: r.registrationType,
      number: r.number,
    })),
    client: { name: client.name, address: client.address, city: client.city },
    quotation: {
      number: quotation.number,
      revision: quotation.revision,
      title: quotation.title,
      issuedOn: quotation.issuedOn,
      expiresOn: quotation.expiresOn,
      validityDays: quotation.validityDays,
    },
    scope: quotation.scopeText,
    inclusions: quotation.inclusions,
    exclusions: quotation.exclusions,
    stages: input.stages.map((s) => ({
      stageNo: s.stageNo,
      name: s.name,
      percent: s.percent,
      amount: s.amount,
      condition: s.conditionText,
    })),
    terms: quotation.terms,
    price: quotation.price,
    // Until the tax engine (P2-01) supplies tax lines the price is shown without tax.
    priceNote: 'excluding_tax',
  };
}
