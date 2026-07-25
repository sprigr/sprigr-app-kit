/**
 * Showcase - platform-driven handlers: schedules + decision-point.
 *
 *   showcase_daily_digest   per_install schedule. Builds a digest, reports
 *                           usage, and (demo) creates a follow-up agent
 *                           schedule at runtime.
 *   showcase_tenant_rollup  per_tenant schedule. Rolls up across installs.
 *   showcase_route_decision decision-point: reads a tenant-configured
 *                           routing workflow id from install config and
 *                           calls env.SPRIGR.run_workflow; falls back to
 *                           round-robin when unconfigured or on error.
 *
 * Schedule dispatch lands ScheduleArgs { name, scheduled_at? } as args.
 */

import { getInstallConfig } from '../lib/store';
import { stagingOnly } from '../lib/env';
import type { ScheduleArgs } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

// ── per_install schedule ─────────────────────────────────────────────────────
export async function dailyDigest(env: ShowcaseEnv, args: ScheduleArgs): Promise<HandlerResult> {
  // STAGING-ONLY: report usage + create a same-day follow-up agent schedule.
  return stagingOnly(async () => {
    await env.SPRIGR.usage.report({ billedTokens: 5, kind: 'daily_digest' });
    const sched = await env.SPRIGR.schedules.create({
      name: `showcase_digest_followup_${args.scheduled_at ?? 'now'}`,
      fireAt: new Date(Date.now() + 3600_000).toISOString(),
      prompt: 'Summarize any Acme deals that closed today.',
      taskType: 'message',
    });
    return { digest: 'built', followup: sched };
  }, 'dailyDigest calls env.SPRIGR.usage.report + env.SPRIGR.schedules.create — publish to staging.');
}

// ── per_tenant schedule ──────────────────────────────────────────────────────
export async function tenantRollup(env: ShowcaseEnv, _args: ScheduleArgs): Promise<HandlerResult> {
  // STAGING-ONLY: query the per-company data index for a tenant-wide count.
  return stagingOnly(
    () => env.SPRIGR.data.search({ query: '', hitsPerPage: 0, facets: ['stage'] }),
    'tenantRollup rolls up counts via env.SPRIGR.data.search — publish to staging.',
  );
}

// ── decision-point ───────────────────────────────────────────────────────────
interface RouteInput {
  contact_id: string;
  stage?: string;
}
export async function routeDecision(env: ShowcaseEnv, input: RouteInput): Promise<HandlerResult> {
  // Read the tenant-configured workflow id from install config (local D1).
  // The portal writes app_installations.config.decision_route_decision_workflow_id;
  // the app mirrors it locally via setInstallConfig on connect/configure.
  const workflowId = await getInstallConfig(env.DB, 'decision_route_decision_workflow_id');

  if (!workflowId) {
    // Fallback: built-in round-robin (default_behavior in the manifest).
    return { ok: true, result: { owner: roundRobinOwner(input.contact_id), source: 'default' } };
  }

  // run_workflow NEVER throws — it returns { ok:false } on timeout/error, so
  // a misconfigured workflow is never a chain killer. On the dev stub the
  // property access throws, so we still wrap in stagingOnly.
  const outcome = await stagingOnly(async () => {
    const wf = await env.SPRIGR.run_workflow(workflowId, {
      input: { contact_id: input.contact_id, stage: input.stage },
      timeout_ms: 2000,
    });
    if (!wf.ok) {
      return { owner: roundRobinOwner(input.contact_id), source: 'fallback_after_workflow_error' };
    }
    const owner = (wf.output as { owner?: string } | undefined)?.owner;
    return { owner: owner ?? roundRobinOwner(input.contact_id), source: owner ? 'workflow' : 'fallback_no_owner' };
  }, 'routeDecision calls env.SPRIGR.run_workflow — publish to staging.');
  return outcome;
}

function roundRobinOwner(seed: string): string {
  const owners = ['alex', 'blake', 'casey'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return owners[h % owners.length]!;
}

export default {
  showcase_daily_digest: (args: ScheduleArgs, env: ShowcaseEnv) => dailyDigest(env, args),
  showcase_tenant_rollup: (args: ScheduleArgs, env: ShowcaseEnv) => tenantRollup(env, args),
  showcase_route_decision: (args: RouteInput, env: ShowcaseEnv) => routeDecision(env, args),
};
