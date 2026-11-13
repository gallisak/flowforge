'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest } from '@/lib/api-client';
import { ApiError, failureMessage } from '@/lib/api-error';
import type { MissedRunPolicy, WorkflowDto } from '@/lib/types';
import {
  changesFrom,
  emptyValues,
  FieldErrors,
  serverErrors,
  validateWorkflow,
  valuesFrom,
  WorkflowFormValues,
} from '@/lib/workflow-form';

const EDIT_CONFLICT = 'The workflow was changed by someone else; reload it and try again';

const POLICY_LABELS: Record<MissedRunPolicy, string> = {
  skip: 'Skip runs missed during downtime',
  once: 'Run once for all missed runs',
  all: 'Run every missed run',
};

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function WorkflowForm({ workflow, timezones }: { workflow?: WorkflowDto; timezones: string[] }) {
  const router = useRouter();
  const [values, setValues] = useState<WorkflowFormValues>(() => (workflow ? valuesFrom(workflow) : emptyValues()));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const zones = useMemo(() => (timezones.includes('UTC') ? timezones : ['UTC', ...timezones]), [timezones]);

  const set = <K extends keyof WorkflowFormValues>(key: K, value: WorkflowFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
  };
  const described = (field: keyof WorkflowFormValues) =>
    errors[field] ? { 'aria-invalid': true, 'aria-describedby': `${field}-error` } : { 'aria-invalid': false };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { errors: found, payload } = validateWorkflow(values, workflow);
    setErrors(found);
    setConflict(false);
    if (!payload) return;
    setSubmitting(true);
    try {
      if (workflow) {
        const changes = changesFrom(payload, workflow);
        if (Object.keys(changes).length > 0) {
          await apiRequest(`/workflows/${workflow.id}`, { method: 'PATCH', body: changes, headers: { 'if-match': `"${workflow.revision}"` } });
        }
      } else {
        await apiRequest('/workflows', { method: 'POST', body: payload });
      }
      router.push('/workflows');
      router.refresh();
    } catch (err) {
      const edited = err instanceof ApiError && err.status === 412;
      setConflict(edited);
      if (edited) setErrors({ form: EDIT_CONFLICT });
      else setErrors(err instanceof ApiError && err.status === 400 ? serverErrors(err.messages) : { form: failureMessage(err) });
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{workflow ? `Edit ${workflow.name}` : 'New workflow'}</CardTitle>
          <CardDescription>
            {workflow ? `Changing the steps creates version ${workflow.version + 1}; running executions keep their version.` : 'Steps run in order.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {errors.form && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>{errors.form}</span>
                {conflict && (
                  <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
                    Reload the workflow
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={values.name} onChange={(e) => set('name', e.target.value)} {...described('name')} />
              <FieldError id="name-error" message={errors.name} />
            </div>
            <div className="flex items-center gap-3 pt-8">
              <Switch id="enabled" checked={values.enabled} onCheckedChange={(checked) => set('enabled', checked)} />
              <Label htmlFor="enabled">Enabled</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron">Schedule (cron)</Label>
              <Input
                id="cron"
                className="font-mono"
                placeholder="0 9 * * 1-5"
                value={values.cron}
                onChange={(e) => set('cron', e.target.value)}
                {...described('cron')}
              />
              <p className="text-xs text-muted-foreground">Leave empty to run only on demand or from webhooks.</p>
              <FieldError id="cron-error" message={errors.cron} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timezone">Time zone</Label>
              <Input
                id="timezone"
                list="timezones"
                value={values.timezone}
                onChange={(e) => set('timezone', e.target.value)}
                {...described('timezone')}
              />
              <datalist id="timezones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <FieldError id="timezone-error" message={errors.timezone} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="missedRunPolicy">Missed runs</Label>
              <Select value={values.missedRunPolicy} onValueChange={(value) => set('missedRunPolicy', value as MissedRunPolicy)}>
                <SelectTrigger id="missedRunPolicy" className="md:w-96" {...described('missedRunPolicy')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(POLICY_LABELS) as MissedRunPolicy[]).map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {POLICY_LABELS[policy]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id="missedRunPolicy-error" message={errors.missedRunPolicy} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="steps">Steps (JSON)</Label>
            <Textarea
              id="steps"
              className="min-h-72 font-mono text-xs"
              spellCheck={false}
              value={values.steps}
              onChange={(e) => set('steps', e.target.value)}
              {...described('steps')}
            />
            <p className="text-xs text-muted-foreground">
              Types: http (url, method, headers, body), transform (expr), log (message), delay (ms). Use {'{{ input.x }}'} and {'{{ steps.id.field }}'} in text.
            </p>
            <FieldError id="steps-error" message={errors.steps} />
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push('/workflows')} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : workflow ? 'Save changes' : 'Create workflow'}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
