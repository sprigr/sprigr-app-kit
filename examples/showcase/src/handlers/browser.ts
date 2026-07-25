/**
 * Showcase - env.SPRIGR.browser.* reference module.
 *
 *   browser.fetch      one-shot headless GET of a page that serves different
 *                      HTML to non-browser clients. Requires the
 *                      sprigr.browser:fetch scope.
 *   browser.screenshot one-shot PNG (base64).
 *   browser.session.*  STATEFUL, cookie-persistent sessions (open/act/
 *                      snapshot/cookies/close). PUBLISHER-OWNER ONLY: only the
 *                      single install where company_id === publisher_company_id
 *                      may open a publisher-scoped session; every other install
 *                      gets 403 not_publisher_owner. Requires
 *                      sprigr.browser:session + sprigr.jobs:publisher.
 *
 * All staging-only. The session example is included for completeness but note
 * it CANNOT be exercised from a normal tenant install — see the cookbook.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';

export async function fetchRenderedPage(env: ShowcaseEnv, url: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.browser.fetch(url, {
        waitForSelector: '#app-root',
        evaluate: 'document.title',
        humanize: true,
        timeoutMs: 30_000,
      }),
    'fetchRenderedPage calls env.SPRIGR.browser.fetch (scope sprigr.browser:fetch) — publish to staging.',
  );
}

export async function screenshotPage(env: ShowcaseEnv, url: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.browser.screenshot(url, { fullPage: true }),
    'screenshotPage calls env.SPRIGR.browser.screenshot — publish to staging.',
  );
}

/**
 * Publisher-owner-only stateful session walk. Shown end-to-end; on a normal
 * tenant install this fails with 403 not_publisher_owner (not swallowed by
 * stagingOnly — it's a real platform error). Only drive this from the
 * publisher's own install.
 */
export async function driveLoginPortal(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(async () => {
    const opened = await env.SPRIGR.browser.session.open({
      url: 'https://portal.acme.example/login',
      cookieKey: 'acme-portal',
      hydrateCookies: true,
      persistent: true,
    });
    const sessionId = opened.sessionId;
    await env.SPRIGR.browser.session.act({ sessionId, action: 'fill', selector: '#user', value: 'ops@acme.example' });
    await env.SPRIGR.browser.session.act({ sessionId, action: 'click', selector: '#submit' });
    const snap = await env.SPRIGR.browser.session.snapshot({ sessionId, kind: 'content' });
    await env.SPRIGR.browser.session.cookies({ op: 'save', cookieKey: 'acme-portal', sessionId });
    await env.SPRIGR.browser.session.close({ sessionId });
    return { snapshot: snap };
  }, 'driveLoginPortal uses env.SPRIGR.browser.session.* (publisher-owner only) — publish to staging and run from the publisher install.');
}
