import { parseUtcTimestampMillis } from '../date-safety';
import { isSafePositiveInteger } from './number-safety';

export type WorkItemWithUpdatedAt = {
  updatedAt: string;
};

const MAX_UPDATED_AT_LENGTH = 64;

type RankedRecentWorkItem<T extends WorkItemWithUpdatedAt> = {
  item: T;
  timestamp: number;
  ordinal: number;
};

export class RecentWorkItemCollector<T extends WorkItemWithUpdatedAt> {
  private readonly enabled: boolean;
  private readonly rankedItems: RankedRecentWorkItem<T>[] = [];
  private ordinal = 0;

  constructor(private readonly maxItems: number) {
    this.enabled = hasValidRecentWorkItemLimit(maxItems);
  }

  add(item: T): void {
    if (!this.enabled) {
      return;
    }

    insertRecentWorkItem(
      this.rankedItems,
      {
        item,
        timestamp: updatedAtTimestamp(item.updatedAt),
        ordinal: this.ordinal
      },
      this.maxItems
    );
    this.ordinal = nextOrdinal(this.ordinal);
  }

  items(): T[] {
    return this.rankedItems.map(({ item }) => item);
  }
}

export function collectRecentWorkItems<T extends WorkItemWithUpdatedAt>(
  values: Iterable<T>,
  maxItems: number
): T[] {
  if (!hasValidRecentWorkItemLimit(maxItems)) {
    return [];
  }

  const collector = new RecentWorkItemCollector<T>(maxItems);
  for (const value of values) {
    collector.add(value);
  }

  return collector.items();
}

export function hasValidRecentWorkItemLimit(maxItems: number): boolean {
  return isSafePositiveInteger(maxItems);
}

export function compareByUpdatedAtDesc(left: WorkItemWithUpdatedAt, right: WorkItemWithUpdatedAt): number {
  const leftTimestamp = updatedAtTimestamp(left.updatedAt);
  const rightTimestamp = updatedAtTimestamp(right.updatedAt);

  if (leftTimestamp > rightTimestamp) {
    return -1;
  }
  if (leftTimestamp < rightTimestamp) {
    return 1;
  }

  return 0;
}

function insertRecentWorkItem<T extends WorkItemWithUpdatedAt>(
  items: RankedRecentWorkItem<T>[],
  item: RankedRecentWorkItem<T>,
  maxItems: number
): void {
  if (items.length >= maxItems && compareRecentWorkItems(item, items[items.length - 1]) >= 0) {
    return;
  }

  let lower = 0;
  let upper = items.length;

  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (compareRecentWorkItems(item, items[middle]) < 0) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }

  items.splice(lower, 0, item);
  if (items.length > maxItems) {
    items.length = maxItems;
  }
}

function compareRecentWorkItems<T extends WorkItemWithUpdatedAt>(
  left: RankedRecentWorkItem<T>,
  right: RankedRecentWorkItem<T>
): number {
  if (left.timestamp > right.timestamp) {
    return -1;
  }
  if (left.timestamp < right.timestamp) {
    return 1;
  }

  return left.ordinal - right.ordinal;
}

function updatedAtTimestamp(value: string): number {
  return parseUtcTimestampMillis(value, { maxLength: MAX_UPDATED_AT_LENGTH }) ?? Number.NEGATIVE_INFINITY;
}

function nextOrdinal(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : Number.MAX_SAFE_INTEGER;
}
