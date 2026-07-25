# agent-template — a `kind: "agent"` app

Most kit examples are tool/integration apps: they deploy a Worker and expose
tools. An **agent template** is the other app shape. It ships no code and no
Worker — installing it provisions a configured agent inside the tenant.

That difference is enforced by the platform's own publish validator, which
short-circuits for agent apps:

```
if (kind === 'agent') {
  if (!manifest.agent_config?.persona) return 'Agent templates require agent_config.persona';
  return null;
}
```

So an agent app needs **no** `runtime`, `permissions.scopes`, or `tools[]` —
the three things every tool app must have. It needs exactly one thing:
`agent_config.persona`.

## What each field does at install time

| Field | Effect |
|---|---|
| `agent_config.persona` | Becomes the agent's system prompt. `{company_name}` and `{agent_name}` are substituted with the installing tenant's company name and the provisioned agent's slug. |
| `agent_config.model_tier` | Default model for the agent. Validated against the platform's tier list; anything unrecognised falls back to `auto`. |
| `agent_config.role` | Agent's role in the tenant (`owner`/`manager`/`member`/`employee`). |
| `agent_config.settings` | Free-form JSON merged into the agent's settings. |
| `agent_config.channels` | Which channels the installer is prompted to enable. |
| `agent_config.recommended_apps` | Companion apps. `required: true` blocks the install until that app is present; `false` is a suggestion. |
| `training_index` | Provisions a Sprigr Search index for the agent's training corpus, with these searchable/facetable attributes. |
| `agent_schedules[]` | Recurring prompts sent to the provisioned agent (here: a weekday escalation review). |

## Publishing

Same commands as any other app — there is just no build step:

```bash
sprigr app validate --dir examples/agent-template
sprigr app publish  --dir examples/agent-template
```

`sprigr app dev` has nothing to serve for an agent app (no handlers, no D1), so
the local loop here is `validate` plus a unit test over the manifest. Exercise
the persona itself by installing on staging and talking to the agent.

## Upgrades

Publishing a new version re-resolves the persona template and updates the
installed agent's persona, model tier and settings in place. A version whose
`agent_config.persona` is missing is rejected at upgrade time, so the agent
can never end up with an empty system prompt.
