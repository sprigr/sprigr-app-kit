import { describe, expect, it } from 'vitest';
import {
  resolvePlatformWebhookBase,
  buildMarketplaceWebhookUrl,
} from '../src/platform-host';

describe('resolvePlatformWebhookBase', () => {
  it('returns env.SPRIGR_PLATFORM_BASE when present (staging)', () => {
    expect(
      resolvePlatformWebhookBase({ SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' }),
    ).toBe('https://staging-webhooks.sprigr.com');
  });

  it('returns env.SPRIGR_PLATFORM_BASE when present (prod)', () => {
    expect(
      resolvePlatformWebhookBase({ SPRIGR_PLATFORM_BASE: 'https://webhooks.sprigr.com' }),
    ).toBe('https://webhooks.sprigr.com');
  });

  it('falls back to prod when no env var is set', () => {
    expect(resolvePlatformWebhookBase({})).toBe('https://webhooks.sprigr.com');
  });

  it('strips trailing slash so callers can concatenate', () => {
    expect(
      resolvePlatformWebhookBase({ SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com/' }),
    ).toBe('https://staging-webhooks.sprigr.com');
  });

  it('override wins over env', () => {
    expect(
      resolvePlatformWebhookBase(
        { SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' },
        'https://custom.example.com',
      ),
    ).toBe('https://custom.example.com');
  });

  it('override null/undefined falls through to env', () => {
    expect(
      resolvePlatformWebhookBase(
        { SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' },
        null,
      ),
    ).toBe('https://staging-webhooks.sprigr.com');
    expect(
      resolvePlatformWebhookBase(
        { SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' },
        undefined,
      ),
    ).toBe('https://staging-webhooks.sprigr.com');
  });
});

describe('buildMarketplaceWebhookUrl', () => {
  it('composes the canonical /webhook/marketplace/{installId}/{topicPath} shape', () => {
    expect(
      buildMarketplaceWebhookUrl(
        { SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' },
        'inst_abc',
        'orders-create',
      ),
    ).toBe('https://staging-webhooks.sprigr.com/webhook/marketplace/inst_abc/orders-create');
  });

  it('uses the prod fallback when env is bare', () => {
    expect(buildMarketplaceWebhookUrl({}, 'inst_xyz', 'app-uninstalled')).toBe(
      'https://webhooks.sprigr.com/webhook/marketplace/inst_xyz/app-uninstalled',
    );
  });
});
