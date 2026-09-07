# Build a Live Canvas of a Sprigr Company: Step-by-Step Guide

A self-contained walkthrough for a developer or AI agent building a Miro-style board of a Sprigr company: agents, workflows, runs, chats, knowledge and apps drawn as linked tiles, kept live over WebSockets, with chat, decision cards and workflow starts from the board. One backend process, one HTML page, no Sprigr code changes.

Written 5 September 2026 against Sprigr staging. Every endpoint, tool and frame named here was exercised from outside the portal that day, and on the same day an engineer with no Sprigr knowledge built a working board from this document alone (all six steps, nine of ten checklist items). The corrections that exercise produced are folded in.

The helpers this guide leans on ship as [`@sprigr/canvas-kit`](https://www.npmjs.com/package/@sprigr/canvas-kit) on npm (MIT, no dependencies, browsers and Node 20+). You can build without it; section 3 gives the rules the graph helper encodes.

---

## 0. What you are building

Three parts:

1. **A small server, "the relay".** Holds the Sprigr key and talks to MCP and the sockets.
2. **A page.** Draws tiles and connectors on a `<canvas>` and talks only to your relay.
3. **Optionally, two webhooks.** One so the canvas can push into Sprigr, one so Sprigr can push app events out to you.

| Surface | What it gives you |
|---|---|
| Read | MCP tools list agents, workflows, runs, knowledge, apps, integrations, schedules, teams, projects and conversations. Request and response, no streaming. |
| Live | One company-wide WebSocket pushes run status, definition changes, approvals and decision cards. One per-agent WebSocket streams a chat. |
| Act | Send a message, stop a turn, answer a decision card, start a workflow, rename or pin a conversation, post a signed event into an agent. |

> **The key never reaches a browser.** The sockets and MCP take the key as an `Authorization: Bearer` header. A browser cannot set that on a WebSocket, and a key in page source is a leak. Everything below assumes the relay is a server process (Node is what the reference uses) and the page speaks to the relay over plain HTTP plus a server-sent events stream.

---

## 1. Before you start

### You need from the Sprigr tenant admin

- **An MCP key.** Minted in the portal at `/dashboard/mcp`. Ask for scope `read_write`. A key is either bound to the user who minted it (it sees that user's conversations and acts as them) or a service key (it sees every conversation of an agent and cannot rename or pin any, because those actions need a user). For a canvas one person uses, a user-bound key is right; for a shared wallboard, a service key.
- **The company id** (`comp_…`). It is on the same portal page and in every MCP response.
- **Which environment.** Production or staging; the hostnames differ and nothing else does.

| | Production | Staging |
|---|---|---|
| MCP endpoint | `https://mcp.team.sprigr.com/mcp` | `https://staging-mcp-team.sprigr.com/mcp` |
| Gateway (HTTPS) | `https://api.team.sprigr.com` | `https://staging-api-team.sprigr.com` |
| Gateway (WebSocket base) | `wss://api.team.sprigr.com/ws` | `wss://staging-api-team.sprigr.com/ws` |

### The kit

```bash
npm install @sprigr/canvas-kit
```

It carries the graph builder, the company events client, the socket frame and event types, and the webhook and forwarder helpers named below.

### Tooling

Node 20 or later, the `@modelcontextprotocol/sdk` client, and the `ws` package. That is the whole dependency list of the reference relay.

---

## 2. Connect to MCP and read the company

MCP here is Streamable HTTP with the key as a Bearer header. A tool call returns text content: JSON for reads, a sentence starting with `Error` for failures. Parse accordingly.

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-canvas', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
}));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError || /^(Error|Sprigr platform error)\b/.test(text)) throw new Error(`${name}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
```

Take one snapshot of everything you will draw. Nine list calls plus one `get_workflow` per workflow, all read-scoped, run them in parallel. **Every list tool returns an envelope object, not an array**; the array is under the key shown here:

```js
const [agents, teams, workflowRows, executions, knowledge, schedules, projects, integrations, apps] = await Promise.all([
  call('list_agents').then(r => r.agents),
  call('list_teams').then(r => r.teams),
  call('list_workflows').then(r => r.workflows),
  call('list_executions', { limit: 50 }).then(r => r.executions),
  call('list_knowledge').then(r => r.objects),          // not r.knowledge; also carries totalHits, indexes, agents, editors
  call('list_schedules').then(r => r.schedules),
  call('list_projects').then(r => r.projects),
  call('list_integrations').then(r => r.integrations),  // also carries viewer
  call('list_apps').then(r => r.apps),
]);
// Steps are NOT on list_workflows rows. One get_workflow per workflow gives the DAG:
const workflows = await Promise.all(workflowRows.map(w => call('get_workflow', { workflowId: w.id }).then(r => r.workflow)));
```

Expect the snapshot to take 15 to 30 seconds warm on a real tenant. Eight of the nine list calls answer in under two seconds; `list_knowledge` alone was measured at 32 seconds, so do not read a slow first snapshot as a broken transport.

Verbatim shapes, captured 5 September 2026 (31 agents, 21 workflows, 50 runs, 20 knowledge, 35 installed apps):

- `list_workflows` rows: `id, companyId, name, slug, description, triggerType, triggerConfig, tags, enabled, mode, visibility, visibleToAgents, source, sourceId, sourceAppSlug, transient, expiresAt, projectId, projectName, projectSlug, createdAt, updatedAt`. No `steps`, no `startStepId`. `get_workflow({ workflowId })` returns `{ workflow, versionInfo }` and `workflow.steps[]` carries ids, names, transitions and `assignedAgentId`. Feed the detailed rows to the graph builder or you get no `has_step`, `transition` or `assigned_to` edges and no error.
- `list_executions` rows: `id, status, stepStates, workflowId, workflowName, blockedStepId, startedAt, completedAt, error, startedByAgentId`, camelCase with `stepStates` parsed, with or without `workflow_id`. (Builds before 6 September 2026 returned raw snake_case rows with `step_states` as a JSON string when `workflow_id` was set; the builder attached none of them.)
- `buildCompanyGraph` throws `` `agents` must be an array, got object with keys [agents] `` if you pass an envelope. If your board is only a hub node, this is why.
- `list_agents` rows include `last_active_at` (newest conversation activity on any channel) so a tile can say busy or idle.
- `list_apps` rows are trimmed: no manifest. Call `get_app({ appSlug })` when you need one (`slug` and `app_slug` are rejected with `Invalid arguments … path: ["appSlug"]`). Only rows with `installed: true` belong on a board.
- Conversations are not in the snapshot. Load them per agent with `list_conversations({ agentSlug })` when the agent is opened.

---

## 3. Turn the lists into a graph

With the kit:

```js
import { buildCompanyGraph } from '@sprigr/canvas-kit';
const graph = buildCompanyGraph({ agents, teams, workflows, executions, knowledge, schedules, projects, integrations, apps, companyName });
// -> { nodes, edges }
```

Without it, apply these rules. Node ids are namespaced so kinds never collide.

| Node | Id | Label and status | Edges it gets |
|---|---|---|---|
| company | `company:self` | the company name | hub for anything installed company-wide |
| agent | `agent:<id>` | name; status active/suspended; meta slug, role, type, last_active_at | `manages` to its manager, `member_of` to teams, `uses` to apps/integrations listed in its `agent_ids` |
| team | `team:<id>` | name | members via `member_of` |
| workflow | `workflow:<id>` | name; status enabled/disabled; meta slug, trigger, cron | `has_step` to each step, `in_project`, `runs` from a schedule |
| step | `step:<workflowId>:<stepId>` | step name | `transition` to next steps, `assigned_to` its agent |
| execution | `execution:<id>` | "<workflow> run"; status running/blocked/completed/failed | `execution_of` its workflow, `started_by`, `blocked_at` a step |
| conversation | `conversation:<id>` | title; meta channel, updatedAt | `chat_with` its agent |
| knowledge | `knowledge:<objectID>` | title | `authored_by` an agent, `about` subject tags |
| app, integration | `app:<slug>`, `integration:<slug>` | name; status installed/active/available | `uses` from agents (explicit `agent_ids`) or from the company hub (company-wide, `agent_ids` null) |
| schedule, project | `schedule:<id>`, `project:<id>` | name; meta cron | `schedules` an agent, `runs` a workflow, `in_project` |

"What can this agent use" is the union of the agent's own `uses` edges and the company hub's. Anything a list references that is not in the lists (a deleted agent still named on a knowledge row) becomes a placeholder node with `meta.placeholder = true`; draw it dimmed and never let a later patch overwrite a real node with a placeholder.

Two more kit helpers you will want: `conversationsToGraph(rows)` makes conversation nodes and `chat_with` edges from `list_conversations` (each row already carries the `agentId` the helper requires, no join needed), and `mergeGraphPatch(graph, patch)` folds them into a graph you are already drawing without moving anything.

---

## 4. Keep it live: the company events socket

One socket per company. Open `wss://api.team.sprigr.com/ws/events/<companyId>` with the Bearer header. On open you get `{ type: "connected", timestamp }` and you are subscribed to every kind. Send `{ type: "subscribe", kinds: [...] }` to narrow, `{ type: "ping" }` every 30 seconds to keep it warm. Events arrive as `{ type: "event", event }`.

| event.kind | Fields | What to do on the board |
|---|---|---|
| `workflow.execution` | `executionId, workflowId, status` | Create or recolour the execution tile; refetch with `get_execution` only when someone opens it. |
| `workflow.definition` | `workflowId, change` | Refetch that workflow with `get_workflow` and redraw its steps. |
| `mcp_write_approval` | `approvalId, status` | Count it under "needs a person"; list with `list_mcp_write_approvals`. |
| `decision` | `agentId, conversationId, decisionId, status` (pending or resolved) | Add to or remove from a "questions waiting" set; open that agent's chat to show the card. |

Events carry identity and status, never content. The kit's `createCompanyEventsClient({ baseUrl, companyId, auth, onEvent })` does connect, subscribe, ping and backoff reconnect; `applyCompanyEvent(graph, event)` folds an event into the graph and tells you which node ids to refetch.

> **The socket drops on every deploy.** Close code 1006 with no reason. That is the agent or gateway restarting, not your bug. Reconnect with backoff. Anything that changed while you were disconnected is not replayed; on reconnect, refetch executions with `list_executions` and carry on. The "questions waiting" count is exact only from the moment you subscribe.

---

## 5. Chat with an agent from a tile

This is the portal's own socket, so you get the same frames the portal renders. One socket per (agent, conversation); open it when a chat is opened and close it after idling.

```js
const url = `${WS_BASE}/${companyId}/${agentId}?conversationId=${encodeURIComponent(conversationId)}`;
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${KEY}` } });
// on open, the agent sends { type: 'history', payload: { messages: [...] } } for that conversation
ws.send(JSON.stringify({ type: 'message', payload: { text, channel: 'webchat', source: 'admin', userName: 'Canvas', clientTimestamp: Date.now() } }));
```

- **The URL takes the agent id (`agt_…`), not the slug.** Every MCP tool nearby takes `agentSlug`, so the slug is the natural mistake. With a slug the socket opens normally and then sends `{"type":"error","payload":{"message":"Failed to initialize agent"}}`; nothing names the identifier.
- **Any conversation id works.** A new one (`canvas:<random>`) starts a conversation; the agent answers `conversation_created` with a title. An id from `list_conversations` replays its history. This is how you read any chat: open the socket and take the `history` frame.
- **Do not send `userId`.** The platform stamps the sender from the key, which is what makes the conversation show up in `list_conversations` afterwards.
- **Frames during a turn**, in order: `typing`, `tool_use_started` / `tool_use_completed` (`toolName`, `success`, `durationMs`), `text_delta` (append `payload.text`), one `message` (`text`, `role`, `artifacts`, `attachments`), then `turn_complete`. A real first turn measured: `connected, history, typing, conversation_created, typing, context_snapshot, typing, thinking_delta x2, tool_use_started, tool_use_completed, text_delta x2, conversation_updated, message, conversation_reply, turn_complete`. Do not append every `*_delta`: `thinking_delta` is the model's reasoning, not the reply. Ignore `agent_log`, `liveness_probe`, `turn_metrics`, `context_snapshot`, `conversation_reply` unless you want them.
- **Rich content** rides on `message` and on each history entry as `artifacts[]`: `type: "html"` (`inlineContent`, or `url` = an R2 key), `type: "panel"` with `panelKind: "html"` (`panelData.html` or `panelData.source_key`) or `"app_card"` (`panelData` has title, fields, table, actions), plus image, markdown, code. Render HTML in a sandboxed iframe (`sandbox="allow-scripts"`); a full document passes through, a bare fragment wants a base stylesheet. `artifact_update` frames replace an artifact by id. A key is fetched from `GET /files/<companyId>/<agentId>/serve?key=…` on the gateway with the Bearer header, through your relay.
- **Assistant text is markdown.** Render at least lists, bold, inline code and fenced code, or replies read as a wall.
- **Controls**: `{ type: 'stop', payload: { conversationId } }` aborts the turn (a `message` "Processing stopped." then `turn_complete`); `plan_mode_toggle` with `{ planMode: true|false }` and `effort_change` with `{ effort: 'auto'|'low'|'medium'|'high' }` are echoed as `plan_mode_changed` / `effort_changed`.
- **Attachments**: `POST /files/<companyId>/<agentId>/upload` on the gateway, multipart field `file`, Bearer header, returns `{ key, mimeType, filename }`; put `attachments: [{ url: key, mimeType, filename }]` on the message.

---

## 6. Decision cards and conversation housekeeping

When an agent needs a person it sends `pending_decision`: `{ decisionId, conversationId, questions: [{ question, options: [{ id, label }] }] }`. Draw the buttons. Answer with the MCP tool, not by echoing the label:

```js
await call('resolve_decision', {
  agent_slug, decision_id: decisionId,
  conversation_id: conversationId,          // required for a chat card, see below
  answers: [{ question_index: 0, chosen_option_ids: [optionId] }],
});
// -> { status: 'resolved' }; the agent then continues the turn on the socket and sends decision_resolved
```

> **Always pass `conversation_id`.** A chat card lives on that conversation's own agent instance. A resolve without the conversation id is answered by a different instance, reports `resolved`, and the agent never continues. This cost a full afternoon; do not repeat it.

Housekeeping tools, all user-bound: `update_conversation({ conversation_id, title?, pinned?, status: 'active'|'archived' })` and `search_conversations({ agent_slug, query })`. Conversation ids contain colons; URL-encode them wherever they go in a path, the platform decodes. Two things to know: `read_conversation` also needs `agent_slug` (without it: `Could not resolve agent. Provide a valid agent_slug`), and `search_conversations` returns `{ conversations, messages }` with full message bodies, so one short query can come back at 80 KB or more; read the titles off `conversations` and drop `messages` unless you are showing hits.

---

## 7. Workflows and runs

- One workflow's runs: `list_executions({ workflow_id, status?, limit? })`. Rows carry `workflowId`, status, started and completed times, in the same shape as the company-wide call.
- Start one: `start_workflow({ workflowId, input })` returns `{ executionId, status }`. The run then appears on the company socket as `workflow.execution` events until it completes, so the tile can go running, then completed, without polling.
- A run blocked at an approval gate: `approve_execution({ executionId, action: 'approve'|'reject' })`.
- Detail for one run, including per-step state and output: `get_execution({ executionId })`. A step that died on a platform fault records a readable reason plus the raw text as `errorRaw`.

Do not draw every run. A busy tenant fires hundreds an hour. Fold completed runs into a count on the workflow tile and keep only running, blocked and failed on the board; stack more than three of one workflow into a single tile.

---

## 8. Canvas into Sprigr: the signed webhook

To let a tile action reach an agent (drag a customer onto an agent, "summarise this run"), create one inbound webhook for your tool and post to it with an HMAC signature. The kit's `buildInboundWebhookArgs` and `signInboundWebhookBody` do both; the shape is:

```js
await call('create_webhook', {
  name: 'my-canvas', destination: 'agent', agentSlug: 'ops',
  authType: 'hmac_sha256', auth_secret: SECRET, responseMode: 'sync',
  transform: { text: 'action.summary', 'metadata.canvasNodeId': 'node.id' },
});
// -> { id, token, url }   POST url with header X-Webhook-Signature: sha256=<hex hmac of the exact body>
// sync mode answers with the agent's reply text in the response body
```

The webhook's name doubles as its slug. If you delete and recreate under the same name, the platform frees the old slug; a live webhook with the same name is a 409 naming it. Keep the `token` and `url` from the create response; they are not shown again.

---

## 9. App and platform events into the canvas

A Xero invoice, a received mail, a changed file: these are app events, and they reach an outside URL through an event-triggered workflow whose single code step POSTs each event to you. The kit's `buildEventForwarderWorkflow({ targetUrl, secretHeader, excludeWorkflowId })` returns the `create_workflow` arguments. Two things must be true for it to work:

- **An outbound allowlist entry for your host.** A code step may only call approved hosts. Either ask the agent in chat to request outbound access to your host and answer "Allow always", or create an `http-request` integration with your host in `allowed_domains`. Until then every run fails with `403 Domain not allowed`.
- **Exclude the forwarder's own runs.** Its own completion is an event; without `excludeWorkflowId` (and the platform's self-event guard) it retriggers itself.

Knowledge and collection changes have a separate push: `sprigr_create_subscription` (`buildIndexSubscriptionArgs` in the kit) POSTs to your URL when index records change.

---

## 10. Drawing it so it stays usable

The reference page went through a real walkthrough; these are the things that turned an unusable hairball into a board:

- **Level of detail.** Below a zoom threshold, draw one card per frame (Agents, Workflows, Runs, and so on) with counts and status chips on a screen-space grid; click a card to zoom into that frame. Nobody can read 500 tiles at once.
- **Connectors only where they mean something.** Without a selection, draw structural links (steps, transitions, run to workflow, chat to agent). Light every link of the selected tile, with the edge kind labelled.
- **A "needs me" strip** in the header: blocked runs, questions waiting, running, failed, each a button that takes you there.
- **Search** that jumps to a tile.
- **Redraw only on change.** A full-rate animation loop plus a panel rebuilt per streamed token blocked the main thread for seconds. Patch streamed tokens into the bubble in place, coalesce re-renders per frame, debounce layout on live events (four times a second is plenty), and index the graph once instead of scanning edges per node.
- **An activity log** filtered to the selected object; the firehose of other people's runs is noise.

---

## 11. Things that will bite you

| Symptom | Cause | Do this |
|---|---|---|
| Socket closes 1006 mid-turn | Deploy or idle eviction restarted the agent | Reconnect with the same conversation id; history replays; resend a user message that has no reply |
| Card resolves but the agent never continues | `resolve_decision` without `conversation_id` | Pass the frame's `conversationId` |
| `list_conversations` is empty for your key | Service key: it lists every conversation of the agent; user key: only that user's | Pick the key type for the job; never send `userId` on the message |
| Rename or pin says "not found" | Id with a colon not URL-encoded, or a service key | Encode path segments; use a user-bound key for housekeeping |
| Forwarder runs fail 403 | No outbound allowlist entry for your host | Section 9 |
| Hundreds of run tiles | Event-triggered workflows on a busy tenant | Fold and stack, section 7 |
| `list_apps` is huge | Older builds included manifests | Current builds strip them; call `get_app` for one |
| Board is a hub and nothing else, or the builder throws "must be an array" | MCP envelopes passed to `buildCompanyGraph` | Unwrap: `r.agents`, `r.objects` for knowledge, and so on (section 2) |
| Workflows have no steps or transitions | `list_workflows` rows carry none | One `get_workflow({ workflowId })` per workflow, use `r.workflow` |
| Chat socket opens, then `error: Failed to initialize agent` | Agent slug in the URL | Use the agent id, `agt_…` |
| A filter is ignored and unrelated rows come back | Parameter spelled in the wrong case, dropped silently | Copy the casing per tool from the section 13 table |
| Your relay answers with someone else's data | Port already held by another canvas on the box | Check `EADDRINUSE` in your own log before trusting `curl` |
| Page freezes in Chrome during a reply | Panel rebuilt per token, layout per event | Section 10 |
| A rule the platform enforces differs from the docs | Docs drift | Try it on staging first; what the platform does is the ground truth |

---

## 12. Verification checklist

Each line was proven on staging from outside the portal. Re-run them against your build before calling it done.

- [ ] Snapshot: nine list calls succeed; the graph has a company hub, agents with `uses` edges to what they can reach, workflows with steps and transitions.
- [ ] Company socket: open, subscribe, receive a `workflow.execution` event within a minute on a live tenant; survive a 1006 and reconnect.
- [ ] Chat: open a new conversation id, send a message, render `text_delta` then `message`; the conversation then appears in `list_conversations`.
- [ ] Rich reply: ask for "a small dashboard I can look at here"; the agent's panel artifact renders in a sandboxed frame.
- [ ] Controls: plan mode and effort echo back; stop ends the turn with "Processing stopped."; an uploaded file is quoted back by the agent.
- [ ] Decision: a card raised by the agent, answered with `resolve_decision` plus `conversation_id`, followed by the agent's next turn; the `decision` events arrive on the company socket at pending and resolved.
- [ ] Runs: `start_workflow` from a tile; the run arrives as an event, completes, and `list_executions` with `workflow_id` lists it.
- [ ] Housekeeping: rename, pin, unpin, archive a conversation; title search finds the new title.
- [ ] Inbound: a signed POST to your webhook returns the agent's reply in sync mode; a bad signature is a 401.
- [ ] Outbound: a forwarded platform event reaches your URL with your secret header, and the forwarder does not retrigger itself.

---

## 13. Reference tables

### MCP tools a canvas uses

| Read | Act |
|---|---|
| `list_agents`, `get_agent_info`, `list_teams`, `list_workflows`, `get_workflow`, `list_executions`, `get_execution`, `list_knowledge`, `search_knowledge`, `list_schedules`, `list_projects`, `list_integrations`, `list_apps`, `get_app`, `list_conversations`, `search_conversations`, `read_conversation`, `list_mcp_write_approvals`, `list_webhooks` | `send_message`, `resolve_decision`, `update_conversation`, `start_workflow`, `approve_execution`, `update_workflow`, `create_workflow`, `create_webhook`, `update_webhook`, `delete_webhook`, `create_knowledge`, `write_knowledge`, `create_schedule`, `sprigr_create_subscription` |

### Parameter casing, per tool

New parameters are snake_case; older ones are camelCase; the casing is per tool and the two sit side by side. A parameter the tool does not know is either rejected loudly or **dropped silently**, so copy names exactly from this table:

| Tool | Parameter | Wrong spelling behaves as |
|---|---|---|
| `list_conversations` | `agentSlug` | loud: `-32602 … path: ["agentSlug"] Required` |
| `search_conversations`, `read_conversation` | `agent_slug`, `conversation_id` | loud: `Could not resolve agent` |
| `list_executions` | `workflow_id`, `status`, `limit` | **silent**: `workflowId` is dropped and unrelated runs come back |
| `start_workflow`, `get_workflow` | `workflowId` | loud |
| `get_app` | `appSlug` | loud: `path: ["appSlug"] Required` |
| `update_conversation`, `resolve_decision` | `conversation_id`, `decision_id` | loud |

### Agent socket frames you will handle

`connected`, `history`, `typing`, `text_delta`, `message`, `turn_complete`, `tool_use_started`, `tool_use_completed`, `pending_decision`, `decision_resolved`, `conversation_created`, `conversation_updated`, `artifact_update`, `plan_mode_changed`, `effort_changed`, `error`. The full list is `AGENT_WS_FRAME_TYPES`, exported by `@sprigr/canvas-kit`.

### Reference implementation

The Sprigr team keeps a reference relay and board (`apps/canvas-demo` in the private `sprigr-team` repository): a Node server for boot, snapshot, sockets, file proxies and SSE to the page; a route module every page call goes through, testable without a network; per-agent chat sockets; an in-memory graph plus log; the MCP client shown in section 2; and a single-page board. It runs from a `.env.local` holding `SPRIGR_MCP_KEY`, `SPRIGR_COMPANY_ID`, `SPRIGR_ENV` and `CANVAS_AGENT_SLUG`. Ask the Sprigr team if you want to read it.

### Agent-facing guides in the platform docs index

`guide-company-events-socket`, `guide-company-graph-for-visual-tools`, `guide-agent-chat-socket-from-external-tool`, `guide-agent-chat-socket-controls`, `guide-canvas-object-model`, `guide-inbound-webhook-from-external-tool`, `guide-event-forwarder-workflow`, `guide-index-change-subscription`. Any Sprigr agent can be asked about them by name.

Questions about the platform side go to platform@sprigr.com.
