import {
  lineKey,
  pickRule,
  planTags,
  tagAccountOf,
  type MappingRule,
} from '@emporium/domain/accounting';
import {
  assertAccountUsable,
  assertFound,
  assertMayManageRules,
  assertMayTag,
  assertMayView,
  assertPeriod,
  assertVersionMatched,
} from '../policy/accounting.policy.js';
import {
  findAccount,
  findRule,
  insertRule,
  insertTagIfAbsent,
  listAccounts,
  listRules,
  listTaggedKeys,
  setAccountActive,
  updateRule,
  upsertTag,
  type AccountRow,
  type RuleRow,
  type TagRow,
} from '../repo/accounting.repo.js';
import type {
  AccountDto,
  Actor,
  BackfillPlanDto,
  Db,
  DocType,
  RuleDto,
  RuleInput,
  TagDto,
  UntaggedPageDto,
} from '../types.js';
import type { AccountingDeps, TaggableDoc } from './context.js';
import { createRecorder } from './support.js';

export interface TagTarget {
  docType: DocType;
  docId: string;
  lineRef?: string | undefined;
}

export interface UntaggedQuery {
  from?: string | undefined;
  to?: string | undefined;
  docType?: DocType | undefined;
  limit: number;
  offset: number;
}

export interface TaggingService {
  listAccounts(db: Db, includeInactive: boolean, actor: Actor): Promise<AccountDto[]>;
  /** Spec section 3: the chart is read-only except for switching an account on or off. */
  setAccountActive(
    code: string,
    input: { active: boolean; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<AccountDto>;
  listRules(db: Db, actor: Actor): Promise<RuleDto[]>;
  createRule(input: RuleInput, actor: Actor, tx: Db): Promise<RuleDto>;
  updateRule(
    id: string,
    input: RuleInput & { version: number },
    actor: Actor,
    tx: Db,
  ): Promise<RuleDto>;
  /** Module interface: the accountant puts an account code on one document line (BR-1). */
  tagTransaction(target: TagTarget, accountCode: string, actor: Actor, tx: Db): Promise<TagDto>;
  /** AC-2: the same account on many lines at once. */
  tagMany(targets: TagTarget[], accountCode: string, actor: Actor, tx: Db): Promise<TagDto[]>;
  /** Module interface: the document lines of a period that have no tag, with the rule's suggestion. */
  listUntagged(db: Db, query: UntaggedQuery, actor: Actor): Promise<UntaggedPageDto>;
  /** BR-9: tags the untagged lines the rules fit; a dry run changes nothing. */
  backfill(
    input: { dryRun: boolean; from?: string | undefined; to?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<BackfillPlanDto>;
}

const accountDto = (row: AccountRow): AccountDto => ({
  code: row.code,
  name: row.name,
  type: row.type as AccountDto['type'],
  parentCode: row.parent_code,
  active: row.active,
  version: row.version,
});

const ruleDto = (row: RuleRow): RuleDto => ({
  id: row.id,
  sourceDocType: row.source_doc_type as DocType,
  condition: row.condition,
  debitAccountCode: row.debit_account_code,
  creditAccountCode: row.credit_account_code,
  effectiveFrom: row.effective_from,
  active: row.active,
  version: row.version,
});

const ruleOf = (row: RuleRow): MappingRule => ({
  id: row.id,
  sourceDocType: row.source_doc_type as DocType,
  condition: row.condition,
  debitAccountCode: row.debit_account_code,
  creditAccountCode: row.credit_account_code,
  effectiveFrom: row.effective_from,
  active: row.active,
});

export const tagDto = (row: TagRow): TagDto => ({
  sourceDocType: row.source_doc_type as DocType,
  sourceDocId: row.source_doc_id,
  lineRef: row.line_ref,
  accountCode: row.account_code,
  taggedBy: row.tagged_by,
  method: row.method as TagDto['method'],
  taggedAt: row.tagged_at.toISOString(),
});

const SAMPLE_SIZE = 20;

export function createTaggingService(deps: AccountingDeps): TaggingService {
  const { platform, clock, newId, sources } = deps;
  const record = createRecorder(platform);

  const usable = async (db: Db, code: string) =>
    assertAccountUsable(await findAccount(db, code), code);

  async function writeTag(
    tx: Db,
    target: TagTarget,
    accountCode: string,
    actor: Actor,
  ): Promise<TagDto> {
    const lineRef = target.lineRef ?? '';
    const row = await upsertTag(
      tx,
      {
        docType: target.docType,
        docId: target.docId,
        lineRef,
        accountCode,
        by: actor.userId,
        method: 'manual',
      },
      clock.now(),
    );
    await record(tx, actor, {
      action: 'accounting.tag.set',
      entityType: 'acc_tag',
      entityId: `${target.docType}:${target.docId}:${lineRef}`,
      after: { accountCode },
      event: {
        type: 'accounting.tag.changed',
        payload: { docType: target.docType, docId: target.docId, lineRef, accountCode },
      },
    });
    return tagDto(row);
  }

  async function ruleValues(tx: Db, input: RuleInput) {
    await usable(tx, input.debitAccountCode);
    await usable(tx, input.creditAccountCode);
    return {
      sourceDocType: input.sourceDocType,
      condition: input.condition ?? {},
      debitAccountCode: input.debitAccountCode,
      creditAccountCode: input.creditAccountCode,
      effectiveFrom: input.effectiveFrom,
      active: input.active ?? true,
    };
  }

  const service: TaggingService = {
    async listAccounts(db, includeInactive, actor) {
      assertMayView(actor);
      return (await listAccounts(db, includeInactive)).map(accountDto);
    },

    async setAccountActive(code, input, actor, tx) {
      assertMayManageRules(actor);
      const before = assertFound(await findAccount(tx, code), 'account');
      const row = assertVersionMatched(
        await setAccountActive(tx, code, input.version, input.active, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'accounting.account.set_active',
        entityType: 'acc_account',
        entityId: code,
        before: { active: before.active },
        after: { active: row.active },
        event: { type: 'accounting.account.changed', payload: { code, active: row.active } },
      });
      return accountDto(row);
    },

    async listRules(db, actor) {
      assertMayView(actor);
      return (await listRules(db)).map(ruleDto);
    },

    async createRule(input, actor, tx) {
      assertMayManageRules(actor);
      const row = await insertRule(
        tx,
        newId(),
        await ruleValues(tx, input),
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'accounting.rule.create',
        entityType: 'acc_mapping_rule',
        entityId: row.id,
        after: ruleDto(row),
        event: { type: 'accounting.rule.changed', payload: { id: row.id } },
      });
      return ruleDto(row);
    },

    async updateRule(id, input, actor, tx) {
      assertMayManageRules(actor);
      const before = assertFound(await findRule(tx, id), 'rule');
      const row = assertVersionMatched(
        await updateRule(
          tx,
          id,
          input.version,
          await ruleValues(tx, input),
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'accounting.rule.update',
        entityType: 'acc_mapping_rule',
        entityId: id,
        before: ruleDto(before),
        after: ruleDto(row),
        event: { type: 'accounting.rule.changed', payload: { id } },
      });
      return ruleDto(row);
    },

    async tagTransaction(target, accountCode, actor, tx) {
      assertMayTag(actor);
      await usable(tx, accountCode);
      return writeTag(tx, target, accountCode, actor);
    },

    async tagMany(targets, accountCode, actor, tx) {
      assertMayTag(actor);
      await usable(tx, accountCode);
      const tags: TagDto[] = [];
      for (const target of targets) tags.push(await writeTag(tx, target, accountCode, actor));
      return tags;
    },

    async listUntagged(db, query, actor) {
      assertMayView(actor);
      if (query.from !== undefined && query.to !== undefined) assertPeriod(query.from, query.to);
      const [docs, tagged, rules] = await Promise.all([
        sources.taggable(db, { from: query.from, to: query.to }, actor),
        listTaggedKeys(db),
        listRules(db),
      ]);
      const mapping = rules.map(ruleOf);
      const untagged = docs
        .filter((doc) => !tagged.has(lineKey(doc)))
        .sort((a, b) => a.date.localeCompare(b.date) || lineKey(a).localeCompare(lineKey(b)));
      const byType: Record<string, number> = {};
      for (const doc of untagged) byType[doc.docType] = (byType[doc.docType] ?? 0) + 1;
      const shown = untagged.filter(
        (doc) => query.docType === undefined || doc.docType === query.docType,
      );
      const suggest = (doc: TaggableDoc): string | null => {
        const rule = pickRule(mapping, doc);
        return rule === undefined ? null : tagAccountOf(rule, doc);
      };
      return {
        items: shown.slice(query.offset, query.offset + query.limit).map((doc) => ({
          sourceDocType: doc.docType,
          sourceDocId: doc.docId,
          lineRef: doc.lineRef,
          date: doc.date,
          number: doc.number,
          party: doc.party,
          amount: doc.amount,
          description: doc.description,
          suggestedAccountCode: suggest(doc),
        })),
        total: shown.length,
        limit: query.limit,
        offset: query.offset,
        byType,
      };
    },

    async backfill(input, actor, tx) {
      assertMayTag(actor);
      if (input.from !== undefined && input.to !== undefined) assertPeriod(input.from, input.to);
      const docs = await sources.taggable(tx, { from: input.from, to: input.to }, actor);
      const plan = planTags(docs, await listTaggedKeys(tx), (await listRules(tx)).map(ruleOf));
      let tagged = plan.proposals.length;
      if (!input.dryRun) {
        tagged = 0;
        for (const { line, accountCode } of plan.proposals) {
          const written = await insertTagIfAbsent(
            tx,
            {
              docType: line.docType,
              docId: line.docId,
              lineRef: line.lineRef,
              accountCode,
              by: actor.userId,
            },
            clock.now(),
          );
          if (written) tagged += 1;
        }
        await record(tx, actor, {
          action: 'accounting.backfill.commit',
          entityType: 'acc_tag',
          entityId: 'backfill',
          after: { tagged, unmatched: plan.unmatched.length },
          event: { type: 'accounting.backfill.committed', payload: { tagged } },
        });
      }
      return {
        dryRun: input.dryRun,
        considered: docs.length,
        alreadyTagged: plan.alreadyTagged,
        tagged,
        unmatched: plan.unmatched.length,
        sample: plan.proposals.slice(0, SAMPLE_SIZE).map(({ line, accountCode }) => ({
          sourceDocType: line.docType,
          sourceDocId: line.docId,
          lineRef: line.lineRef,
          accountCode,
        })),
      };
    },
  };
  return service;
}
