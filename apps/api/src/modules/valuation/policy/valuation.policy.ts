import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';

/** A missing record is reported as not found, whoever asks. */
export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** An item or category handed in by the caller must exist in master data. */
export function assertItemKnown<T>(item: T | undefined): T {
  if (item === undefined) throw new ValidationError('item_unknown', 'The item does not exist');
  return item;
}

/** BR-9: only an issue can be returned (not a receipt, a transfer or a transition). */
export function assertIssue(movement: { type: string }): void {
  if (movement.type !== 'issue') {
    throw new RuleViolationError('not_an_issue', 'Only an issue can be returned');
  }
}

/** BR-8: a transfer moves stock between two different stores. */
export function assertDifferentStores(fromStoreId: string, toStoreId: string): void {
  if (fromStoreId === toStoreId) {
    throw new ValidationError('transfer_same_store', 'A transfer needs two different stores');
  }
}

/** The person who decided an approval: the last one to act, if anyone did. */
export function deciderOf(state: {
  status: string;
  actions?: readonly { actorId: string }[];
}): string | null {
  return state.actions?.at(-1)?.actorId ?? null;
}
