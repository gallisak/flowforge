import { WorkflowForm } from '@/components/workflow-form';
import { supportedTimezones } from '@/lib/timezones';

export default function NewWorkflowPage() {
  return <WorkflowForm timezones={supportedTimezones()} />;
}
