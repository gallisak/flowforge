import { Baseline1794305090749 } from './1794305090749-baseline';
import { TenantRowLevelSecurity1794307003779 } from './1794307003779-tenant-row-level-security';
import { AtomicJobClaim1794308377302 } from './1794308377302-atomic-job-claim';
import { JobLeaseRecovery1794308604391 } from './1794308604391-job-lease-recovery';
import { AtomicLeaseReaper1794311016857 } from './1794311016857-atomic-lease-reaper';
import { WorkflowVersionSnapshots1794312361041 } from './1794312361041-workflow-version-snapshots';

export const migrations = [
  Baseline1794305090749,
  TenantRowLevelSecurity1794307003779,
  AtomicJobClaim1794308377302,
  JobLeaseRecovery1794308604391,
  AtomicLeaseReaper1794311016857,
  WorkflowVersionSnapshots1794312361041,
];
