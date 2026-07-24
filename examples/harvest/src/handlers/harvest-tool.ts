/**
 * Harvest - the agent-facing tool handler.
 *
 * Registered in sprigr-app.json as `harvest`. A single dispatcher tool:
 * `action` picks the operation, remaining fields are that action's
 * arguments (mirrors the manifest input_schema).
 */

import {
  listClients,
  listProjects,
  listTaskAssignments,
  listTimeEntries,
  createTimeEntry,
  HarvestApiError,
  ACCOUNT_ID_SETTING,
  ACCOUNT_NAME_SETTING,
} from '../lib/harvest';
import { getSetting } from '../lib/store';
import type { HarvestEnv } from '../lib/env';

export interface ToolArgs {
  action:
    | 'list_clients'
    | 'list_projects'
    | 'list_task_assignments'
    | 'list_time_entries'
    | 'create_time_entry'
    | 'connection_status';
  client_id?: number;
  project_id?: number;
  task_id?: number;
  user_id?: number;
  is_active?: boolean;
  from?: string;
  to?: string;
  spent_date?: string;
  hours?: number;
  notes?: string;
  page?: number;
  per_page?: number;
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; reason: string };

function requireNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Missing or invalid required argument: ${name} (number)`);
  }
  return v;
}

function requireDate(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Missing or invalid required argument: ${name} (YYYY-MM-DD)`);
  }
  return v;
}

export async function runTool(env: HarvestEnv, args: ToolArgs): Promise<ToolResult> {
  const page = { page: args.page, per_page: args.per_page };
  try {
    switch (args.action) {
      case 'connection_status': {
        const accountId = await getSetting(env.DB, ACCOUNT_ID_SETTING);
        const accountName = await getSetting(env.DB, ACCOUNT_NAME_SETTING);
        return {
          ok: true,
          result: accountId
            ? { connected: true, account_id: accountId, account_name: accountName }
            : { connected: false, hint: 'Open the app settings page and click "Connect Harvest".' },
        };
      }
      case 'list_clients':
        return { ok: true, result: await listClients(env, { ...page, is_active: args.is_active }) };
      case 'list_projects':
        return {
          ok: true,
          result: await listProjects(env, { ...page, client_id: args.client_id, is_active: args.is_active }),
        };
      case 'list_task_assignments':
        return {
          ok: true,
          result: await listTaskAssignments(env, requireNumber(args.project_id, 'project_id'), page),
        };
      case 'list_time_entries':
        return {
          ok: true,
          result: await listTimeEntries(env, {
            ...page,
            project_id: args.project_id,
            client_id: args.client_id,
            user_id: args.user_id,
            from: args.from,
            to: args.to,
          }),
        };
      case 'create_time_entry':
        return {
          ok: true,
          result: await createTimeEntry(env, {
            project_id: requireNumber(args.project_id, 'project_id'),
            task_id: requireNumber(args.task_id, 'task_id'),
            spent_date: requireDate(args.spent_date, 'spent_date'),
            ...(args.hours !== undefined ? { hours: args.hours } : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
          }),
        };
      default:
        return { ok: false, reason: `Unknown action: ${String((args as { action?: unknown }).action)}` };
    }
  } catch (err) {
    if (err instanceof HarvestApiError) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export default {
  harvest: async (args: ToolArgs, env: HarvestEnv) => runTool(env, args),
};
