import { procurementPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { procurementApi } from './api';
import { ComparisonSheet } from './ComparisonSheet';
import { useProcurementReferences } from './references';
import { useErrorText } from './shared';

/** BR-2: quotes per vendor, the comparison sheet, the choice per line, and the orders. */
export function RfqPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [vendorId, setVendorId] = useState('');
  const [rates, setRates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const rfq = useQuery({ queryKey: ['rfq', id], queryFn: () => procurementApi.rfq(id) });
  const requisition = useQuery({
    queryKey: ['requisition', rfq.data?.requisitionId],
    queryFn: () => procurementApi.requisition(rfq.data?.requisitionId ?? ''),
    enabled: rfq.data !== undefined,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['rfq', id] });
  const onError = (cause: unknown) => setError(errorText(cause));

  const select = useMutation({
    mutationFn: (v: { lineId: string; quoteId: string; reason?: string }) =>
      procurementApi.selectVendor(id, v.lineId, v.quoteId, v.reason),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const addQuote = useMutation({
    mutationFn: () =>
      procurementApi.addQuote(
        id,
        vendorId,
        Object.entries(rates)
          .filter(([, rate]) => rate.trim() !== '')
          .map(([requisitionLineId, rate]) => ({ requisitionLineId, rate: rate.trim() })),
      ),
    onSuccess: () => {
      setRates({});
      setError(null);
      refresh();
    },
    onError,
  });
  const order = useMutation({
    mutationFn: (vendor: string) =>
      procurementApi.orderFromRfq(id, vendor, new Date().toISOString().slice(0, 10)),
    onSuccess: (created) => void navigate(`/procurement/purchase-orders/${created.id}`),
    onError,
  });

  const data = rfq.data;
  if (data === undefined) return null;
  const lines = requisition.data?.lines ?? [];
  const lineLabel = (lineId: string) => {
    const line = lines.find((l) => l.id === lineId);
    return line === undefined ? lineId : refs.itemName(line.itemId);
  };
  const chosenVendors = [...new Set(data.selections.map((s) => s.vendorId))];
  const manage = can(perm.rfqManage);

  return (
    <div>
      <h2>{data.number}</h2>
      <Link to={`/procurement/requisitions/${data.requisitionId}`}>
        {t('procurement.rfq.backToRequisition')}
      </Link>
      {manage && data.status === 'open' ? (
        <div style={{ margin: '16px 0' }}>
          <h3>{t('procurement.rfq.addQuote')}</h3>
          <Select
            aria-label={t('procurement.comparison.vendor')}
            style={{ minWidth: 240 }}
            options={refs.vendorOptions.filter((o) => data.vendorIds.includes(o.value))}
            value={vendorId === '' ? undefined : vendorId}
            onChange={setVendorId}
          />
          {lines.map((line) => (
            <div key={line.id} style={{ marginTop: 8 }}>
              <Space>
                <span>{refs.itemName(line.itemId)}</span>
                <Input
                  aria-label={`${t('procurement.rfq.rate')} ${line.lineNo}`}
                  inputMode="decimal"
                  value={rates[line.id] ?? ''}
                  onChange={(event) => setRates({ ...rates, [line.id]: event.target.value })}
                />
              </Space>
            </div>
          ))}
          <Button
            style={{ marginTop: 8 }}
            disabled={vendorId === '' || Object.values(rates).every((r) => r.trim() === '')}
            onClick={() => addQuote.mutate()}
          >
            {t('procurement.rfq.saveQuote')}
          </Button>
        </div>
      ) : null}
      <ComparisonSheet
        rfq={data}
        readOnly={!manage || data.status !== 'open'}
        vendorName={refs.vendorName}
        lineLabel={lineLabel}
        onSelect={(lineId, quoteId, reason) =>
          select.mutate(reason === undefined ? { lineId, quoteId } : { lineId, quoteId, reason })
        }
      />
      {can(perm.poCreate)
        ? chosenVendors.map((vendor) => (
            <Button
              key={vendor}
              style={{ marginTop: 16, marginRight: 8 }}
              onClick={() => order.mutate(vendor)}
            >
              {t('procurement.rfq.createOrder', { vendor: refs.vendorName(vendor) })}
            </Button>
          ))
        : null}
      {error === null ? null : (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} />
      )}
    </div>
  );
}
