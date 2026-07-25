/**
 * An agent app has no handlers to unit-test, so the manifest IS the artefact.
 * These assertions mirror the platform's publish validator for kind: 'agent'
 * (workers/provisioning: agent templates require agent_config.persona and are
 * exempt from the runtime/scopes/tools requirements) plus the install-time
 * persona templating.
 */
import { describe, expect, it } from 'vitest';
import manifest from '../sprigr-app.json';

describe('agent-template manifest', () => {
  it('is an agent-kind app carrying the one field the validator demands', () => {
    expect(manifest.kind).toBe('agent');
    expect(manifest.agent_config.persona.length).toBeGreaterThan(0);
  });

  it('omits the tool-app requirements that agent apps are exempt from', () => {
    // The validator returns early for kind:'agent' BEFORE checking these, so
    // declaring them would be noise. If a future platform version starts
    // requiring them for agent apps, this test is the tripwire.
    const m = manifest as Record<string, unknown>;
    expect(m.runtime).toBeUndefined();
    expect(m.permissions).toBeUndefined();
    expect(m.tools).toBeUndefined();
  });

  it('uses both persona template variables the platform substitutes', () => {
    expect(manifest.agent_config.persona).toContain('{agent_name}');
    expect(manifest.agent_config.persona).toContain('{company_name}');
  });

  it('substitutes cleanly, leaving no unresolved placeholders', () => {
    const resolved = manifest.agent_config.persona
      .replace(/\{company_name\}/g, 'Acme Pty Ltd')
      .replace(/\{agent_name\}/g, 'support-lead');
    expect(resolved).toContain('Acme Pty Ltd');
    expect(resolved).toContain('support-lead');
    expect(resolved).not.toMatch(/\{[a-z_]+\}/);
  });

  it('declares a model tier the platform recognises', () => {
    // Anything outside this set is silently coerced to 'auto' at install.
    expect(['opus', 'sonnet', 'haiku', 'auto', 'fable']).toContain(
      manifest.agent_config.model_tier,
    );
  });

  it('declares a valid agent role', () => {
    expect(['owner', 'manager', 'member', 'employee']).toContain(manifest.agent_config.role);
  });

  it('marks companion apps as optional so the install never hard-blocks', () => {
    // required:true would refuse the install until that app is present.
    for (const app of manifest.agent_config.recommended_apps) {
      expect(app.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(app.required).toBe(false);
    }
  });

  it('declares a training index with facetable attributes', () => {
    expect(manifest.training_index.searchable_attributes.length).toBeGreaterThan(0);
    expect(manifest.training_index.attributes_for_faceting.length).toBeGreaterThan(0);
  });

  it('ships an agent schedule that sends a prompt', () => {
    const [schedule] = manifest.agent_schedules;
    expect(schedule?.taskType).toBe('message');
    expect(schedule?.prompt.length).toBeGreaterThan(0);
    expect(schedule?.cron.split(' ')).toHaveLength(5);
  });
});
