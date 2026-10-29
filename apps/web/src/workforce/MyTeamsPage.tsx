import { useQuery } from '@tanstack/react-query';
import { Alert, Card, List, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { workforceApi } from './api';

/** The supervisor's own teams and their members. There is no pay information anywhere here. */
export function MyTeamsPage() {
  const { t } = useTranslation();
  const mine = useQuery({ queryKey: ['workforce-mine'], queryFn: workforceApi.mine });
  const trades = useQuery({ queryKey: ['workforce-trades'], queryFn: workforceApi.trades });
  const tradeName = (code: string) =>
    trades.data?.find((trade) => trade.code === code)?.name ?? code;

  return (
    <div>
      <Typography.Title level={3}>{t('workforce.mine.title')}</Typography.Title>
      {mine.isError && <Alert type="error" message={t('common.loadError')} />}
      {mine.data?.length === 0 && (
        <Typography.Paragraph>{t('workforce.mine.empty')}</Typography.Paragraph>
      )}
      {(mine.data ?? []).map((team) => (
        <Card
          key={team.id}
          size="small"
          style={{ marginBottom: 12 }}
          title={`${team.code} ${team.name}`}
        >
          <List
            size="small"
            locale={{ emptyText: t('workforce.board.noMembers') }}
            dataSource={team.members}
            renderItem={(member) => (
              <List.Item>
                {member.code} {member.fullName} ({tradeName(member.tradeCode)})
              </List.Item>
            )}
          />
        </Card>
      ))}
    </div>
  );
}
