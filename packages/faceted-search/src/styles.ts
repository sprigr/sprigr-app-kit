/**
 * Embedded CSS for the faceted-search UI, as a string constant so the component
 * ships styling with zero build step and the embed bundle can inline it.
 *
 * All custom properties are prefixed `--fb-` to avoid colliding with a host
 * page's variables. Defaults are the SearchApp (realestate) palette; the
 * `theme` config overrides any of them at the `.fb` root. Class names are
 * scoped under `.fb` so the sheet is safe to inject into any page.
 */

/** The default `--fb-*` custom-property values (the SearchApp palette). */
export const DEFAULT_THEME: Record<string, string> = {
  '--fb-ground': '#F5F4F0',
  '--fb-surface': '#fff',
  '--fb-ink': '#171C16',
  '--fb-muted': '#6C7268',
  '--fb-line': '#E4E3DC',
  '--fb-rail': '#1E241C',
  '--fb-rail-2': '#262E23',
  '--fb-rail-ink': '#EAEBE3',
  '--fb-rail-muted': '#98A18F',
  '--fb-rail-line': '#333B30',
  '--fb-accent': '#B9D94B',
  '--fb-accent-deep': '#57763F',
  '--fb-ok': '#2F6F5E',
  '--fb-warn': '#B98900',
  '--fb-err': '#B4523A',
  '--fb-neutral': '#6C7268',
  '--fb-radius': '10px',
  '--fb-shadow': '0 1px 2px rgba(23,28,22,.06),0 6px 20px rgba(23,28,22,.05)',
};

/** Render the default theme as a `:root`-less inline var block for the `.fb` el. */
export function themeStyle(theme?: Record<string, string>): Record<string, string> {
  return { ...DEFAULT_THEME, ...(theme ?? {}) } as Record<string, string>;
}

export const CSS = `
.fb{background:var(--fb-ground);color:var(--fb-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.45;min-height:100vh}
.fb *{box-sizing:border-box}
.fb button{font:inherit;cursor:pointer;color:inherit}
.fb a{color:inherit;text-decoration:none}
.fb .fb-gate{display:grid;place-items:center;min-height:70vh;text-align:center;color:var(--fb-muted);padding:40px}
.fb header{position:sticky;top:0;z-index:30;background:var(--fb-rail);color:var(--fb-rail-ink);border-bottom:1px solid var(--fb-rail-line)}
.fb .fb-bar{display:flex;align-items:center;gap:20px;padding:14px 22px;max-width:1440px;margin:0 auto}
.fb .fb-brand{display:flex;align-items:baseline;gap:9px;flex-shrink:0}
.fb .fb-title{font-weight:700;font-size:17px;letter-spacing:-.02em}
.fb .fb-searchwrap{position:relative;flex:1;max-width:560px}
.fb .fb-searchwrap svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--fb-rail-muted)}
.fb .fb-searchwrap input{width:100%;background:var(--fb-rail-2);border:1px solid var(--fb-rail-line);color:var(--fb-rail-ink);border-radius:8px;padding:10px 14px 10px 38px;outline:none}
.fb .fb-searchwrap input:focus{border-color:var(--fb-accent)}
.fb .fb-stat{margin-left:auto;text-align:right;line-height:1.15}
.fb .fb-stat b{font-size:16px;font-weight:700;color:var(--fb-accent);font-variant-numeric:tabular-nums}
.fb .fb-stat span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--fb-rail-muted)}
.fb .fb-shell{display:grid;grid-template-columns:264px minmax(0,1fr);max-width:1440px;margin:0 auto;align-items:start}
.fb aside{position:sticky;top:57px;align-self:start;background:var(--fb-rail);color:var(--fb-rail-ink);height:calc(100vh - 57px);overflow-y:auto;padding:6px 0 40px}
.fb .fb-group{border-bottom:1px solid var(--fb-rail-line);padding:4px 0}
.fb .fb-head{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:0;padding:13px 20px;text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:600;color:var(--fb-rail-ink)}
.fb .fb-chev{color:var(--fb-rail-muted);transition:transform .18s}
.fb .fb-group.fb-collapsed .fb-chev{transform:rotate(-90deg)}
.fb .fb-body{padding:2px 20px 14px}
.fb .fb-item{display:flex;align-items:center;gap:10px;padding:5px 0;color:var(--fb-rail-ink);width:100%;background:none;border:0;text-align:left}
.fb .fb-box{width:16px;height:16px;border:1.5px solid var(--fb-rail-muted);border-radius:4px;flex-shrink:0;display:grid;place-items:center;color:var(--fb-rail)}
.fb .fb-item[aria-pressed="true"] .fb-box{background:var(--fb-accent);border-color:var(--fb-accent)}
.fb .fb-item .fb-box svg{opacity:0}
.fb .fb-item[aria-pressed="true"] .fb-box svg{opacity:1}
.fb .fb-lbl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fb .fb-cnt{color:var(--fb-rail-muted);font-size:12px;font-variant-numeric:tabular-nums}
.fb .fb-item:hover .fb-lbl{color:#fff}
.fb .fb-item.fb-disabled{opacity:.32;pointer-events:none}
.fb .fb-note{color:var(--fb-rail-muted);font-size:12px;padding:4px 0}
.fb .fb-subsearch{width:100%;background:var(--fb-rail-2);border:1px solid var(--fb-rail-line);color:var(--fb-rail-ink);border-radius:7px;padding:7px 10px;outline:none;margin-bottom:8px;font-size:13px}
.fb .fb-subsearch:focus{border-color:var(--fb-accent)}
.fb .fb-scroll-list{max-height:216px;overflow-y:auto}
.fb .fb-range-row{display:flex;align-items:center;gap:8px;margin-top:4px}
.fb .fb-range-row input{width:100%;background:var(--fb-rail-2);border:1px solid var(--fb-rail-line);color:var(--fb-rail-ink);border-radius:7px;padding:8px 10px;outline:none;min-width:0}
.fb .fb-range-row input:focus{border-color:var(--fb-accent)}
.fb .fb-dash{color:var(--fb-rail-muted)}
.fb main{padding:20px 22px 60px;min-height:calc(100vh - 57px)}
.fb .fb-toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.fb .fb-result-count{font-size:15px;font-weight:600}
.fb .fb-result-count b{color:var(--fb-accent-deep);font-variant-numeric:tabular-nums}
.fb .fb-result-count .fb-muted{color:var(--fb-muted);font-weight:400}
.fb .fb-result-count .fb-err{color:var(--fb-err)}
.fb .fb-sortwrap{margin-left:auto;display:flex;align-items:center;gap:8px}
.fb .fb-sortwrap label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--fb-muted)}
.fb select{background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:8px;padding:8px 11px;outline:none;color:var(--fb-ink)}
.fb .fb-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.fb .fb-chips:empty{display:none}
.fb .fb-chip{display:inline-flex;align-items:center;gap:7px;background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:999px;padding:5px 8px 5px 12px;font-size:12.5px;box-shadow:var(--fb-shadow)}
.fb .fb-chip .fb-k{color:var(--fb-muted)}
.fb .fb-chip button{background:var(--fb-ground);border:0;border-radius:999px;width:18px;height:18px;display:grid;place-items:center;color:var(--fb-muted);font-size:13px}
.fb .fb-chip.fb-clear-all{background:var(--fb-ink);color:var(--fb-ground);border-color:var(--fb-ink);padding:6px 13px}
.fb .fb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:18px}
.fb .fb-card{background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:var(--fb-radius);overflow:hidden;box-shadow:var(--fb-shadow);display:flex;flex-direction:column;transition:transform .16s,box-shadow .16s}
.fb .fb-card:hover{transform:translateY(-3px);box-shadow:0 2px 4px rgba(23,28,22,.08),0 14px 34px rgba(23,28,22,.12)}
.fb .fb-card.fb-skeleton{height:330px;background:linear-gradient(100deg,#efeee8 30%,#f6f5f1 50%,#efeee8 70%);background-size:200% 100%;animation:fb-sk 1.2s infinite}
@keyframes fb-sk{to{background-position:-200% 0}}
.fb .fb-thumb{position:relative;aspect-ratio:4/3;background:linear-gradient(135deg,#eceadf,#d6dccb);overflow:hidden}
.fb .fb-thumb .fb-ph{position:absolute;inset:0;display:grid;place-items:center;color:#bcc0ad}
.fb .fb-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fb .fb-pill{position:absolute;top:10px;left:10px;padding:4px 9px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase;color:#fff}
.fb .fb-pill.fb-tone-ok{background:var(--fb-ok)}
.fb .fb-pill.fb-tone-warn{background:var(--fb-warn)}
.fb .fb-pill.fb-tone-err{background:var(--fb-err)}
.fb .fb-pill.fb-tone-neutral{background:var(--fb-neutral)}
.fb .fb-pill-row{display:flex;gap:6px;flex-wrap:wrap}
.fb .fb-pill-row .fb-pill{position:static}
/* Badges overlaid on a card image. The ROW is positioned, not each pill: a bare
   .fb-pill defaults to absolute top/left so a lone pill can sit on a thumbnail
   (realestate's SearchApp still does that), but two of them then stack on the
   same 10/10 corner and all you see is the tail of the one underneath.
   right:10px lets a long pair wrap inside the image instead of running off it. */
.fb .fb-thumb .fb-pill-row{position:absolute;top:10px;left:10px;right:10px}
.fb .fb-cbody{padding:13px 14px 15px;display:flex;flex-direction:column;gap:7px;flex:1}
.fb .fb-primary{font-size:21px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.fb .fb-primary.fb-na{font-size:15px;color:var(--fb-muted)}
.fb .fb-ctitle{font-size:13.5px;font-weight:600;line-height:1.3}
.fb .fb-csubtitle{font-size:12.5px;color:var(--fb-muted)}
.fb .fb-specs{display:flex;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:10px;border-top:1px solid var(--fb-line);font-size:13px}
.fb .fb-specs .fb-s.fb-muted{color:var(--fb-muted)}
/* Card action buttons (card.actions). The card element stops being the link and
   becomes a plain wrapper, so .fb-card-main has to take over the flex column the
   thumb and body were sizing against, otherwise .fb-cbody{flex:1} has nothing to
   grow inside and the meta row loses its margin-top:auto push. */
.fb .fb-card-main{display:flex;flex-direction:column;flex:1;min-height:0}
.fb .fb-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:11px 14px 12px;border-top:1px solid var(--fb-line)}
.fb .fb-actions button{background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
.fb .fb-actions button:disabled{opacity:.4;cursor:default}
.fb .fb-actions button.fb-act-ok{border-color:var(--fb-ok);color:var(--fb-ok)}
.fb .fb-actions button.fb-act-warn{border-color:var(--fb-warn);color:var(--fb-warn)}
.fb .fb-actions button.fb-act-err{border-color:var(--fb-err);color:var(--fb-err)}
.fb .fb-actions button.fb-act-neutral{border-color:var(--fb-line);color:var(--fb-neutral)}
.fb .fb-actions button.fb-act-pending{opacity:.6}
/* The error message shares the fb-act-err class name with the err tone, so the
   two rules are separated by element type: buttons above, this div here. */
.fb .fb-actions div.fb-act-err{flex-basis:100%;color:var(--fb-err);font-size:12.5px}
.fb .fb-empty{text-align:center;padding:70px 20px;color:var(--fb-muted)}
.fb .fb-empty h3{color:var(--fb-ink);font-size:18px;margin:0 0 6px}
.fb .fb-empty button{margin-top:14px;background:var(--fb-ink);color:var(--fb-ground);border:0;border-radius:8px;padding:9px 16px}
.fb .fb-pager{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:28px}
.fb .fb-pager button{background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:8px;padding:9px 16px;font-weight:600;box-shadow:var(--fb-shadow)}
.fb .fb-pager button:disabled{opacity:.4;cursor:default;box-shadow:none}
.fb .fb-pager .fb-pageinfo{font-size:13px;color:var(--fb-muted);font-variant-numeric:tabular-nums}
.fb :focus-visible{outline:2px solid var(--fb-accent-deep);outline-offset:2px}
.fb aside :focus-visible{outline-color:var(--fb-accent)}
@media(max-width:860px){.fb .fb-shell{grid-template-columns:1fr}.fb aside{display:none}}
@media(prefers-reduced-motion:reduce){.fb *{transition:none!important;animation:none!important}}
`;
