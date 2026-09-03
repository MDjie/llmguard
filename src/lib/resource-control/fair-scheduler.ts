export type GuardPriority = 'CRITICAL' | 'INTERACTIVE' | 'BATCH';

export interface ScheduledWork<T> {
  readonly id: string;
  readonly tenantId: string;
  readonly priority: GuardPriority;
  readonly payload: T;
}

export interface SchedulerLease<T> extends ScheduledWork<T> {
  complete(): void;
}

export interface FairSchedulerOptions {
  readonly maximumQueued: number;
  readonly maximumActive: number;
  readonly reservedCriticalCapacity: number;
  readonly maximumCriticalQueuedPerTenant: number;
  readonly priorityWeights?: Readonly<Record<GuardPriority, number>>;
}

const PRIORITIES: readonly GuardPriority[] = ['CRITICAL', 'INTERACTIVE', 'BATCH'];

export class BoundedFairScheduler<T> {
  private readonly queues = new Map<GuardPriority, Map<string, ScheduledWork<T>[]>>();
  private readonly tenantCursor = new Map<GuardPriority, number>();
  private readonly schedule: readonly GuardPriority[];
  private scheduleCursor = 0;
  private queued = 0;
  private active = 0;

  constructor(private readonly options: FairSchedulerOptions) {
    if (!Number.isSafeInteger(options.maximumQueued) || options.maximumQueued <= 0 ||
        !Number.isSafeInteger(options.maximumActive) || options.maximumActive <= 0 ||
        !Number.isSafeInteger(options.reservedCriticalCapacity) || options.reservedCriticalCapacity < 0 ||
        options.reservedCriticalCapacity > options.maximumActive ||
        !Number.isSafeInteger(options.maximumCriticalQueuedPerTenant) ||
        options.maximumCriticalQueuedPerTenant <= 0) {
      throw new Error('GUARD_SCHEDULER_OPTIONS_INVALID');
    }
    const weights = options.priorityWeights ?? { CRITICAL: 8, INTERACTIVE: 4, BATCH: 1 };
    this.schedule = PRIORITIES.flatMap((priority) => {
      const weight = weights[priority];
      if (!Number.isSafeInteger(weight) || weight <= 0 || weight > 100) {
        throw new Error('GUARD_SCHEDULER_PRIORITY_WEIGHT_INVALID');
      }
      return Array.from({ length: weight }, () => priority);
    });
    for (const priority of PRIORITIES) this.queues.set(priority, new Map());
  }

  enqueue(work: ScheduledWork<T>): void {
    if (!work.id || !work.tenantId) throw new Error('GUARD_SCHEDULER_WORK_IDENTITY_REQUIRED');
    if (this.queued >= this.options.maximumQueued) throw new Error('GUARD_SCHEDULER_BACKPRESSURE');
    const queueByTenant = this.queues.get(work.priority);
    if (!queueByTenant) throw new Error('GUARD_SCHEDULER_PRIORITY_INVALID');
    const tenantQueue = queueByTenant.get(work.tenantId) ?? [];
    if (work.priority === 'CRITICAL' &&
        tenantQueue.length >= this.options.maximumCriticalQueuedPerTenant) {
      throw new Error('GUARD_SCHEDULER_CRITICAL_TENANT_CAP_EXCEEDED');
    }
    tenantQueue.push(work);
    queueByTenant.set(work.tenantId, tenantQueue);
    this.queued += 1;
  }

  dequeue(): SchedulerLease<T> | undefined {
    if (this.active >= this.options.maximumActive) return undefined;
    for (let attempt = 0; attempt < this.schedule.length; attempt += 1) {
      const priority = this.schedule[this.scheduleCursor];
      this.scheduleCursor = (this.scheduleCursor + 1) % this.schedule.length;
      if (priority !== 'CRITICAL' &&
          this.active >= this.options.maximumActive - this.options.reservedCriticalCapacity) {
        continue;
      }
      const work = this.takeNextTenant(priority);
      if (!work) continue;
      this.queued -= 1;
      this.active += 1;
      let completed = false;
      return {
        ...work,
        complete: () => {
          if (completed) return;
          completed = true;
          this.active -= 1;
        },
      };
    }
    return undefined;
  }

  snapshot(): { readonly queued: number; readonly active: number } {
    return { queued: this.queued, active: this.active };
  }

  private takeNextTenant(priority: GuardPriority): ScheduledWork<T> | undefined {
    const queueByTenant = this.queues.get(priority);
    if (!queueByTenant || queueByTenant.size === 0) return undefined;
    const tenants = [...queueByTenant.keys()].sort();
    const cursor = (this.tenantCursor.get(priority) ?? 0) % tenants.length;
    const tenantId = tenants[cursor];
    this.tenantCursor.set(priority, (cursor + 1) % tenants.length);
    const queue = queueByTenant.get(tenantId);
    const work = queue?.shift();
    if (queue?.length === 0) queueByTenant.delete(tenantId);
    return work;
  }
}
