import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Col, Input, Row, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { workforceApi, type TeamDetail, type TeamMember } from './api';
import { karachiToday, membersAfterMove, useErrorText } from './form';

/**
 * The team board: one column per team, and a worker moves between teams by dragging the card or
 * by choosing a team on it. Both do the same call (BR-4); the API ends the old membership.
 */
export function TeamBoardPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [date, setDate] = useState(karachiToday());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);

  const teams = useQuery({ queryKey: ['workforce-teams'], queryFn: workforceApi.teams });
  const details = useQueries({
    queries: (teams.data ?? [])
      .filter((team) => team.active)
      .map((team) => ({
        queryKey: ['workforce-team', team.id],
        queryFn: () => workforceApi.team(team.id),
      })),
  });
  const columns = details.flatMap((query) => (query.data === undefined ? [] : [query.data]));

  const move = useMutation({
    mutationFn: ({ target, workerId }: { target: TeamDetail; workerId: string }) =>
      workforceApi.setMembers(target.id, target.version, membersAfterMove(target, workerId), date),
    onSuccess: async () => {
      setError(null);
      setMessage(t('workforce.board.moved'));
      await queryClient.invalidateQueries({ queryKey: ['workforce-team'] });
      await queryClient.invalidateQueries({ queryKey: ['workforce-teams'] });
    },
    onError: (cause) => {
      setMessage(null);
      setError(errorText(cause));
    },
  });

  const moveTo = (targetId: string, workerId: string) => {
    const target = columns.find((team) => team.id === targetId);
    if (target === undefined || !valid) return;
    if (target.members.some((member) => member.workerId === workerId)) return;
    move.mutate({ target, workerId });
  };

  return (
    <div>
      <Typography.Title level={3}>{t('workforce.board.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          type="date"
          aria-label={t('workforce.board.effective')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <Typography.Text type="secondary">{t('workforce.board.hint')}</Typography.Text>
      </Space>
      {(teams.isError || details.some((query) => query.isError)) && (
        <Alert type="error" message={t('common.loadError')} style={{ marginBottom: 12 }} />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      {columns.length === 0 && !teams.isLoading && (
        <Typography.Paragraph>{t('workforce.board.empty')}</Typography.Paragraph>
      )}
      <Row gutter={[12, 12]}>
        {columns.map((team) => (
          <Col key={team.id} xs={24} md={12} xl={8}>
            <Card
              size="small"
              title={`${team.code} ${team.name}`}
              data-testid={`team-${team.code}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const workerId = event.dataTransfer.getData('text/plain');
                if (workerId !== '') moveTo(team.id, workerId);
              }}
            >
              {team.members.length === 0 && (
                <Typography.Text type="secondary">{t('workforce.board.noMembers')}</Typography.Text>
              )}
              {team.members.map((member) => (
                <MemberCard
                  key={member.workerId}
                  member={member}
                  teamId={team.id}
                  teams={columns}
                  onMove={(targetId) => moveTo(targetId, member.workerId)}
                />
              ))}
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}

function MemberCard({
  member,
  teamId,
  teams,
  onMove,
}: {
  member: TeamMember;
  teamId: string;
  teams: TeamDetail[];
  onMove: (targetId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      draggable
      data-testid={`member-${member.code}`}
      onDragStart={(event) => event.dataTransfer.setData('text/plain', member.workerId)}
      style={{ border: '1px solid #d9d9d9', borderRadius: 4, padding: 8, marginBottom: 8 }}
    >
      <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <span>
          {member.code} {member.fullName}
        </span>
        <Select
          size="small"
          style={{ minWidth: 150 }}
          aria-label={t('workforce.board.moveTo', { name: member.fullName })}
          placeholder={t('workforce.board.move')}
          value={null}
          onChange={(targetId: string) => onMove(targetId)}
          options={teams
            .filter((team) => team.id !== teamId)
            .map((team) => ({ value: team.id, label: `${team.code} ${team.name}` }))}
        />
      </Space>
    </div>
  );
}
