import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { procurementApi, type GrnHeader, type PurchaseOrder } from './api';
import { useProcurementReferences } from './references';
import { readBase64, useErrorText } from './shared';

type Entry = { accepted: string; rejected: string };

/** What the receiving form sends: only the lines where something was counted. */
export function receiptLines(order: PurchaseOrder, entries: Record<string, Entry>) {
  return order.lines
    .map((line) => ({ line, entry: entries[line.id] ?? { accepted: '', rejected: '' } }))
    .filter(({ entry }) => entry.accepted.trim() !== '' || entry.rejected.trim() !== '')
    .map(({ line, entry }) => ({
      poLineId: line.id,
      acceptedQty: entry.accepted.trim() === '' ? '0' : entry.accepted.trim(),
      ...(entry.rejected.trim() === '' ? {} : { rejectedQty: entry.rejected.trim() }),
    }));
}

/** The receiving screen for the store keeper at the gate: count, photograph the challan, post (BR-6, BR-11). */
export function GrnPage() {
  const { poId = '' } = useParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<GrnHeader | null>(null);

  const order = useQuery({ queryKey: ['order', poId], queryFn: () => procurementApi.order(poId) });

  const post = useMutation({
    mutationFn: async (po: PurchaseOrder) =>
      procurementApi.receive({
        poId: po.id,
        receivedOn: new Date().toISOString().slice(0, 10),
        ...(note.trim() === '' ? {} : { deliveryNoteRef: note.trim() }),
        lines: receiptLines(po, entries),
        photos:
          photo === null ? [] : [{ fileName: photo.name, contentBase64: await readBase64(photo) }],
      }),
    onSuccess: (grn) => {
      setPosted(grn);
      void queryClient.invalidateQueries({ queryKey: ['order', poId] });
      void queryClient.invalidateQueries({ queryKey: ['open-lines'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const po = order.data;
  if (po === undefined) return null;
  if (posted !== null) {
    return (
      <div>
        <Alert
          type="success"
          showIcon
          message={t('procurement.receiving.posted', { number: posted.number })}
        />
        <Link to={`/procurement/purchase-orders/${po.id}`}>{po.number}</Link>
      </div>
    );
  }

  const set = (lineId: string, change: Partial<Entry>) =>
    setEntries({
      ...entries,
      [lineId]: { accepted: '', rejected: '', ...entries[lineId], ...change },
    });
  const submit = () => {
    if (receiptLines(po, entries).length === 0) {
      setError(t('procurement.receiving.nothingCounted'));
      return;
    }
    if (photo === null) {
      setError(t('procurement.receiving.photoRequired'));
      return;
    }
    setError(null);
    post.mutate(po);
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <h2>{t('procurement.receiving.title', { number: po.number })}</h2>
      {po.lines.map((line) => (
        <div key={line.id} style={{ borderBottom: '1px solid #eee', padding: '12px 0' }}>
          <strong>{refs.itemName(line.itemId)}</strong>
          <div>
            {t('procurement.receiving.ordered')} {line.quantity} ·{' '}
            {t('procurement.receiving.received')} {line.receivedQty}
          </div>
          <Input
            size="large"
            inputMode="decimal"
            aria-label={`${t('procurement.receiving.accepted')} ${line.lineNo}`}
            placeholder={t('procurement.receiving.accepted')}
            value={entries[line.id]?.accepted ?? ''}
            onChange={(event) => set(line.id, { accepted: event.target.value })}
          />
          <Input
            size="large"
            style={{ marginTop: 8 }}
            inputMode="decimal"
            aria-label={`${t('procurement.receiving.rejected')} ${line.lineNo}`}
            placeholder={t('procurement.receiving.rejected')}
            value={entries[line.id]?.rejected ?? ''}
            onChange={(event) => set(line.id, { rejected: event.target.value })}
          />
        </div>
      ))}
      <Input
        size="large"
        style={{ marginTop: 16 }}
        aria-label={t('procurement.receiving.challanRef')}
        placeholder={t('procurement.receiving.challanRef')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <label style={{ display: 'block', marginTop: 16 }}>
        {t('procurement.receiving.photo')}
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          aria-label={t('procurement.receiving.photo')}
          onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
        />
      </label>
      {error === null ? null : (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} />
      )}
      <Button
        type="primary"
        size="large"
        block
        style={{ marginTop: 16 }}
        loading={post.isPending}
        onClick={submit}
      >
        {t('procurement.receiving.post')}
      </Button>
    </div>
  );
}
