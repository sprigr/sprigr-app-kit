/**
 * OAuth bouncer host resolution.
 *
 * This is the shared replacement for eight hand-rolled copies of
 *
 *     reqUrl.includes('staging-apps.sprigr.com') ||
 *     reqUrl.includes('staging-team.sprigr.com')
 *
 * which was wrong in both directions: it missed the `staging-sites`
 * preview host (staging install -> PROD bouncer, which cannot resolve a
 * staging install id) and it could be flipped the other way by a
 * `return_to` query param (prod install -> STAGING bouncer).
 *
 * The tables below are the contract. Adding a staging host to the
 * platform without teaching `isStagingHost` should break a test here,
 * not a tenant's first connect.
 */

import { describe, expect, it } from 'vitest';
import {
  isStagingHost,
  resolveOAuthBouncerBase,
  resolveOAuthBouncerCallbackUrl,
} from '../src/platform-host';

const STAGING_BASE = 'https://staging-oauth-bouncer.sprigr.com';
const PROD_BASE = 'https://oauth-bouncer.sprigr.com';

describe('isStagingHost', () => {
  it.each([
    // Every host class either environment actually serves from.
    'https://sprigr-hq-myob-mqppc0p0.staging-sites.sprigr.com/oauth/start',
    'https://myob-abc123.staging-apps.sprigr.com/oauth/start',
    'https://staging-team.sprigr.com/oauth/start',
    'https://staging-webhooks.sprigr.com',
    // Bare hostnames, not just full URLs.
    'staging-team.sprigr.com',
    'sprigr-hq-simpro-x.staging-sites.sprigr.com',
  ])('staging: %s', (input) => {
    expect(isStagingHost(input)).toBe(true);
  });

  it.each([
    'https://myob-abc123.apps.sprigr.com/oauth/start',
    'https://sprigr-hq-myob-x.sites.sprigr.com/oauth/start',
    'https://team.sprigr.com/oauth/start',
    'https://webhooks.sprigr.com',
    'apps.sprigr.com',
    'team.sprigr.com',
  ])('prod: %s', (input) => {
    expect(isStagingHost(input)).toBe(false);
  });

  it('does not let a query param flip the environment', () => {
    // The whole point of parsing the hostname: a prod install hit with a
    // staging-looking return_to must stay prod.
    expect(
      isStagingHost('https://x.apps.sprigr.com/oauth/start?return_to=https://staging-team.sprigr.com/x'),
    ).toBe(false);
    expect(isStagingHost('https://x.apps.sprigr.com/staging-apps.sprigr.com')).toBe(false);
    expect(isStagingHost('https://x.apps.sprigr.com/#staging-team.sprigr.com')).toBe(false);
  });

  it('treats a userinfo-smuggled staging host as prod', () => {
    // https://staging-team.sprigr.com@evil.example/ has hostname evil.example.
    expect(isStagingHost('https://staging-team.sprigr.com@prod.example/')).toBe(false);
  });

  it.each([null, undefined, '', '   ', 'not a url', '///'])(
    'falls back to prod on unusable input: %s',
    (input) => {
      // Never point production traffic at staging on a parse failure.
      expect(isStagingHost(input as string)).toBe(false);
    },
  );

  it('requires the staging- prefix to start a label, not merely appear', () => {
    // `notstaging-x` must not match; `a.staging-x` must.
    expect(isStagingHost('https://notstaging-apps.sprigr.com/')).toBe(false);
    expect(isStagingHost('https://a.staging-apps.sprigr.com/')).toBe(true);
    expect(isStagingHost('https://staging-apps.sprigr.com/')).toBe(true);
  });
});

describe('resolveOAuthBouncerBase', () => {
  it('picks staging from the request URL', () => {
    expect(resolveOAuthBouncerBase({ reqUrl: 'https://x.staging-sites.sprigr.com/oauth/start' })).toBe(
      STAGING_BASE,
    );
  });

  it('picks staging from the platform base when there is no request URL', () => {
    // Tool handlers on /__sprigr/tool/* have no browser origin.
    expect(resolveOAuthBouncerBase({ platformBase: 'https://staging-webhooks.sprigr.com' })).toBe(
      STAGING_BASE,
    );
    expect(resolveOAuthBouncerBase({ platformBase: 'https://webhooks.sprigr.com' })).toBe(PROD_BASE);
  });

  it('is staging when ANY supplied signal says staging', () => {
    expect(
      resolveOAuthBouncerBase({
        reqUrl: 'https://x.apps.sprigr.com/oauth/start',
        platformBase: 'https://staging-webhooks.sprigr.com',
      }),
    ).toBe(STAGING_BASE);
  });

  it('defaults to prod with no signals at all', () => {
    expect(resolveOAuthBouncerBase()).toBe(PROD_BASE);
    expect(resolveOAuthBouncerBase({})).toBe(PROD_BASE);
  });

  it('lets an override win, without a trailing slash', () => {
    expect(
      resolveOAuthBouncerBase({
        reqUrl: 'https://x.staging-apps.sprigr.com/',
        override: 'http://localhost:8799/',
      }),
    ).toBe('http://localhost:8799');
  });

  it('ignores a blank override rather than returning empty string', () => {
    expect(
      resolveOAuthBouncerBase({ reqUrl: 'https://x.staging-apps.sprigr.com/', override: '  ' }),
    ).toBe(STAGING_BASE);
  });
});

describe('resolveOAuthBouncerCallbackUrl', () => {
  it('appends the provider callback path', () => {
    expect(
      resolveOAuthBouncerCallbackUrl('simpro', { reqUrl: 'https://x.staging-sites.sprigr.com/oauth/start' }),
    ).toBe('https://staging-oauth-bouncer.sprigr.com/simpro/oauth/callback');
    expect(
      resolveOAuthBouncerCallbackUrl('procore', { reqUrl: 'https://x.apps.sprigr.com/oauth/start' }),
    ).toBe('https://oauth-bouncer.sprigr.com/procore/oauth/callback');
  });

  it('returns an override verbatim, without appending the provider path', () => {
    // An app pointing at a local bouncer supplies the complete callback URL.
    expect(
      resolveOAuthBouncerCallbackUrl('simpro', {
        reqUrl: 'https://x.apps.sprigr.com/',
        override: 'http://localhost:8799/simpro/oauth/callback',
      }),
    ).toBe('http://localhost:8799/simpro/oauth/callback');
  });

  it('never returns a staging bouncer for a prod host (cross-wiring guard)', () => {
    // Both URLs are registered on each provider's dev app, so a cross-wired
    // environment surfaces late, as a redirect_uri mismatch at consent time.
    expect(resolveOAuthBouncerCallbackUrl('xero-accounting', { reqUrl: 'https://x.apps.sprigr.com/' })).not.toContain(
      'staging-',
    );
  });
});
