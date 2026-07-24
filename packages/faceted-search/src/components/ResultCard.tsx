/**
 * Declarative result card driven by CardConfig dot-paths. Consumers that need
 * a bespoke layout pass `renderCard` to <FacetBrowse> instead of this.
 *
 * Image handling: when `card.image` is NOT configured the image block is
 * omitted entirely (no placeholder glyph, no reserved 4:3 area) and the card
 * renders compact and text-first, with badges inline above the primary line.
 * When `card.image` IS configured but a given hit lacks the value, the 4:3
 * block stays with the placeholder glyph so the grid keeps a uniform rhythm.
 */
import { useState, type JSX } from 'react';
import type { CardConfig } from '../types';
import { formatPrimary } from '../utils/format';
import { resolveNumber, resolvePath, resolveString } from '../utils/path';
import { ImagePlaceholderIcon } from './icons';

export function ResultCard({
  hit,
  card,
}: {
  hit: Record<string, unknown>;
  card: CardConfig;
}): JSX.Element {
  const [imgOk, setImgOk] = useState(true);
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

  const Wrapper = href ? 'a' : 'div';
  const wrapperProps = href
    ? { href, target: '_blank' as const, rel: 'noopener noreferrer' }
    : {};

  const badgePills = visibleBadges.map((b, i) => (
    <span key={i} className={`fb-pill fb-tone-${b.tone}`}>
      {b.label}
    </span>
  ));

  return (
    <Wrapper className={'fb-card' + (hasImageBlock ? '' : ' fb-card-noimg')} {...wrapperProps}>
      {hasImageBlock && (
        <div className="fb-thumb">
          <span className="fb-ph">
            <ImagePlaceholderIcon />
          </span>
          {img && imgOk && (
            <img src={img} loading="lazy" alt="" onError={() => setImgOk(false)} />
          )}
          {badgePills}
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
    </Wrapper>
  );
}
