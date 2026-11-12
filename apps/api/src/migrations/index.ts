import { Baseline1794305090749 } from './1794305090749-baseline';
import { TenantRowLevelSecurity1794307003779 } from './1794307003779-tenant-row-level-security';
import { AtomicJobClaim1794308377302 } from './1794308377302-atomic-job-claim';
import { JobLeaseRecovery1794308604391 } from './1794308604391-job-lease-recovery';
import { AtomicLeaseReaper1794311016857 } from './1794311016857-atomic-lease-reaper';
import { WorkflowVersionSnapshots1794312361041 } from './1794312361041-workflow-version-snapshots';
import { StepCheckpoints1794312587199 } from './1794312587199-step-checkpoints';
import { DurableDelay1794312901450 } from './1794312901450-durable-delay';
import { StepIdempotencyKeys1794313078517 } from './1794313078517-step-idempotency-keys';
import { ExecutionTriggerKeys1794320000000 } from './1794320000000-execution-trigger-keys';
import { WebhookSecretRotation1794320100000 } from './1794320100000-webhook-secret-rotation';
import { FairJobClaim1794320200000 } from './1794320200000-fair-job-claim';
import { TenantLimits1794320300000 } from './1794320300000-tenant-limits';
import { ContentionAwareClaim1794320400000 } from './1794320400000-contention-aware-claim';
import { PurposeBuiltJobIndexes1794320500000 } from './1794320500000-purpose-built-job-indexes';
import { PersistentSchedules1794320600000 } from './1794320600000-persistent-schedules';
import { ClaimDueSchedules1794320700000 } from './1794320700000-claim-due-schedules';
import { ExecutionNotifications1794320800000 } from './1794320800000-execution-notifications';
import { ExecutionChangeNotifications1794320900000 } from './1794320900000-execution-change-notifications';
import { ExecutionListIndexes1794321000000 } from './1794321000000-execution-list-indexes';
import { ExecutionWorkflowStatistics1794321100000 } from './1794321100000-execution-workflow-statistics';
import { ReaperReleasesInterruptedSteps1794321200000 } from './1794321200000-reaper-releases-interrupted-steps';
import { LongerTriggerKeys1794321300000 } from './1794321300000-longer-trigger-keys';
import { PostponedSchedules1794321400000 } from './1794321400000-postponed-schedules';
import { TenantAwareClaims1794321500000 } from './1794321500000-tenant-aware-claims';
import { LeastPrivilegeGrants1794321600000 } from './1794321600000-least-privilege-grants';
import { StepOutputSizes1794321700000 } from './1794321700000-step-output-sizes';
import { PerStepAttempts1794321800000 } from './1794321800000-per-step-attempts';
import { WatchedExecutionNotifications1794321850000 } from './1794321850000-watched-execution-notifications';
import { DataRetention1794321900000 } from './1794321900000-data-retention';
import { TenantLimitChecks1794322000000 } from './1794322000000-tenant-limit-checks';

export const migrations = [
  Baseline1794305090749,
  TenantRowLevelSecurity1794307003779,
  AtomicJobClaim1794308377302,
  JobLeaseRecovery1794308604391,
  AtomicLeaseReaper1794311016857,
  WorkflowVersionSnapshots1794312361041,
  StepCheckpoints1794312587199,
  DurableDelay1794312901450,
  StepIdempotencyKeys1794313078517,
  ExecutionTriggerKeys1794320000000,
  WebhookSecretRotation1794320100000,
  FairJobClaim1794320200000,
  TenantLimits1794320300000,
  ContentionAwareClaim1794320400000,
  PurposeBuiltJobIndexes1794320500000,
  PersistentSchedules1794320600000,
  ClaimDueSchedules1794320700000,
  ExecutionNotifications1794320800000,
  ExecutionChangeNotifications1794320900000,
  ExecutionListIndexes1794321000000,
  ExecutionWorkflowStatistics1794321100000,
  ReaperReleasesInterruptedSteps1794321200000,
  LongerTriggerKeys1794321300000,
  PostponedSchedules1794321400000,
  TenantAwareClaims1794321500000,
  LeastPrivilegeGrants1794321600000,
  StepOutputSizes1794321700000,
  PerStepAttempts1794321800000,
  WatchedExecutionNotifications1794321850000,
  DataRetention1794321900000,
  TenantLimitChecks1794322000000,
];
