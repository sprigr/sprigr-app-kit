/**
 * Declarative result card driven by CardConfig dot-paths. Consumers that need
 * a bespoke layout pass `renderCard` to <FacetBrowse> instead of this.
 *
 * Image handling: when `card.image` is NOT configured the image block is
 * omitted entirely (no placeholder glyph, no reserved 4:3 area) and the card
 * renders compact and text-first, with badges inline above the primary line.
 * When `card.image` IS configured but a given hit lacks the value, the 4:3
 * block stays with the placeholder glyph so the grid keeps a uniform rhythm.
 *
 * Action buttons: `card.actions` is opt-in. Without it the card renders exactly
 * as it always has, a single `.fb-card` element that IS the `<a>` when a href
 * resolves. With it the card splits into an outer `.fb-card.fb-card-actionable`
 * div wrapping an `.fb-card-main` link plus a sibling `.fb-actions` row, because
 * a `<button>` nested inside an `<a>` is invalid HTML and the click would
 * navigate instead of firing the handler.
 */
import { useState, type JSX } from 'react';
import type { CardConfig } from '../types';
import { formatPrimary } from '../utils/format';
import { resolveNumber, resolvePath, resolveString } from '../utils/path';
import { ImagePlaceholderIcon } from './icons';

export function ResultCard({
  hit,
  card,
  onCardAction,
}: {
  hit: Record<string, unknown>;
  card: CardConfig;
  onCardAction?: (hit: Record<string, unknown>, value: string) => void | Promise<void>;
}): JSX.Element {
  const [imgOk, setImgOk] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasImageBlock = card.image != null;
  const img = hasImageBlock ? resolveString(hit, card.image) : '';
  const title = resolveString(hit, card.title);
  const subtitle = card.subtitle ? resolveString(hit, card.subtitle) : '';
  const href = card.href ? resolveString(hit, card.href) : '';

  const primaryRaw = card.primary ? resolvePath(hit, card.primary.attr) : undefined;
  const primaryText = card.primary ? formatPrimary(primaryRaw, card.primary) : '';

  const badges = (card.badges ?? []).map((b) => {
    const val = resolveString(hit, b.attr);
    const mapped = b.map?.[val];
    return {
      label: mapped?.label ?? val,
      tone: mapped?.tone ?? 'neutral',
      show: val !== '',
    };
  });
  const visibleBadges = badges.filter((b) => b.show);

  const actions = card.actions ?? [];
  const hasActions = actions.length > 0;

  async function runAction(value: string): Promise<void> {
    if (!onCardAction || pending != null) return;
    setPending(value);
    setActionError(null);
    try {
      await onCardAction(hit, value);
      setPending(null);
    } catch (err) {
      // A rejected handler is a normal outcome, not a crash: surface it on the
      // card and leave the buttons usable so the operator can retry.
      setActionError(err instanceof Error ? err.message : String(err));
      setPending(null);
    }
  }

  const Wrapper = href ? 'a' : 'div';
  const wrapperProps = href
    ? { href, target: '_blank' as const, rel: 'noopener noreferrer' }
    : {};

  const badgePills = visibleBadges.map((b, i) => (
    <span key={i} className={`fb-pill fb-tone-${b.tone}`}>
      {b.label}
    </span>
  ));

  const inner = (
    <>
      {hasImageBlock && (
        <div className="fb-thumb">
          <span className="fb-ph">
            <ImagePlaceholderIcon />
          </span>
          {img && imgOk && (
            <img src={img} loading="lazy" alt="" onError={() => setImgOk(false)} />
          )}
          {visibleBadges.length > 0 && (
            <div className="fb-pill-row">{badgePills}</div>
          )}
        </div>
      )}
      <div className="fb-cbody">
        {!hasImageBlock && visibleBadges.length > 0 && (
          <div className="fb-pill-row">{badgePills}</div>
        )}
        {card.primary &&
          (primaryText ? (
            <div className="fb-primary">{primaryText}</div>
          ) : (
            <div className="fb-primary fb-na">-</div>
          ))}
        {title && <div className="fb-ctitle">{title}</div>}
        {subtitle && <div className="fb-csubtitle">{subtitle}</div>}
        {card.meta && card.meta.length > 0 && (
          <div className="fb-specs">
            {card.meta.map((m, i) => {
              const v = resolveNumber(hit, m.attr);
              const has = v != null && v !== 0;
              const shown = v != null ? v.toLocaleString() : '–';
              return (
                <span key={i} className={'fb-s' + (has ? '' : ' fb-muted')}>
                  {m.icon ? m.icon + ' ' : ''}
                  {shown}
                  {m.suffix ? ' ' + m.suffix : ''}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  const noimg = hasImageBlock ? '' : ' fb-card-noimg';

  // No actions configured: keep the historic single-element markup byte for
  // byte, so every existing consumer and stylesheet is untouched.
  if (!hasActions) {
    return (
      <Wrapper className={'fb-card' + noimg} {...wrapperProps}>
        {inner}
      </Wrapper>
    );
  }

  return (
    <div className={'fb-card fb-card-actionable' + noimg}>
      <Wrapper className="fb-card-main" {...wrapperProps}>
        {inner}
      </Wrapper>
      <div className="fb-actions">
        {actions.map((a, i) => (
          <button
            key={i}
            type="button"
            className={
              `fb-act fb-act-${a.tone ?? 'neutral'}` +
              (pending === a.value ? ' fb-act-pending' : '')
            }
            disabled={!onCardAction || pending != null}
            aria-busy={pending === a.value ? 'true' : undefined}
            onClick={() => void runAction(a.value)}
          >
            {a.label}
          </button>
        ))}
        {actionError != null && (
          <div className="fb-act-err" role="status">
            {actionError}
          </div>
        )}
      </div>
    </div>
  );
}
