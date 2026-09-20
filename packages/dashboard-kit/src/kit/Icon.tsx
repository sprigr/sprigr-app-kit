/**
 * Icon resolver: a short, stable name (`gauge`, `alert-triangle`, `copy`) maps
 * onto a lucide-react glyph, so screens refer to icons by name and never import
 * lucide directly. Unknown names fall back to a small dot, making a missing
 * mapping visible rather than a crash. Add new names to ICONS as screens need
 * them, or drop a lucide component in directly where a one-off is simpler.
 */
import {
  Activity, ArrowLeft, ArrowRight, ArrowUp, Bell, Box, Boxes, Building2, Calendar, ChartColumn, Check, CheckCheck,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleX, Clock, Code2, Copy, Database, DollarSign,
  Download, ExternalLink, Eye, FastForward, FileText, FlaskConical, Gauge, History, Inbox, Info, KeyRound,
  LayoutDashboard, Lock, Megaphone, Minus, Moon,
  PackageCheck, Pause, Pencil, Phone, Play, Plus, RefreshCw, RotateCw, Route, Search,
  Settings, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Target, Trash2, TrendingDown, TrendingUp, Truck,
  TriangleAlert, Undo2, User, Wind, Workflow, X,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';

const ICONS: Record<string, LucideIcon> = {
  // ops glyphs
  gauge: Gauge,
  route: Route,
  'alert-triangle': TriangleAlert,
  building: Building2,
  boxes: Boxes,
  box: Box,
  sliders: SlidersHorizontal,
  broom: Wind,
  flow: Workflow,
  database: Database,
  // logistics / metrics
  'package-check': PackageCheck,
  truck: Truck,
  chart: ChartColumn,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
  'dollar-sign': DollarSign,
  phone: Phone,
  info: Info,
  clock: Clock,
  rotate: RotateCw,
  // actions / status
  undo: Undo2,
  refresh: RefreshCw,
  'x-circle': CircleX,
  'check-circle': CircleCheck,
  check: Check,
  'check-all': CheckCheck,
  close: X,
  minus: Minus,
  plus: Plus,
  'fast-forward': FastForward,
  'shield-check': ShieldCheck,
  key: KeyRound,
  pause: Pause,
  play: Play,
  pencil: Pencil,
  // nav / misc
  search: Search,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  copy: Copy,
  history: History,
  user: User,
  code: Code2,
  activity: Activity,
  inbox: Inbox,
  external: ExternalLink,
  lock: Lock,
  bell: Bell,
  sun: Sun,
  moon: Moon,
  sparkle: Sparkles,
  cog: Settings,
  // Added 2026-09-20 after a census of every `<Icon name>` / `icon:` across the
  // sprigr-apps and sprigr-private-apps dashboards found these eleven names in
  // use with no glyph behind them, each rendering as the fallback dot: a pager
  // whose "previous" button was a grey circle, a Reports tab with no icon, an
  // Export button with a dot. `external-link` is an alias of `external`.
  'arrow-left': ArrowLeft,
  'chevron-left': ChevronLeft,
  'chevron-up': ChevronUp,
  calendar: Calendar,
  download: Download,
  eye: Eye,
  'external-link': ExternalLink,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  'layout-dashboard': LayoutDashboard,
  megaphone: Megaphone,
  target: Target,
  trash: Trash2,
};

/** Names every screen may rely on; a test pins them so a rename here is loud. */
export const ICON_NAMES: readonly string[] = Object.freeze(Object.keys(ICONS));

const warnedUnknown = new Set<string>();

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.75, style }: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) {
    // The dot keeps the layout intact, but on its own it hides the defect: a
    // pager's "previous" chevron shipped as a grey circle for weeks because
    // nothing said the name was unknown. Say so once per name, in the console
    // where the developer building the screen is looking.
    if (!warnedUnknown.has(name)) {
      warnedUnknown.add(name);
      if (typeof console !== 'undefined') console.warn(`[dashboard-kit] <Icon name="${name}"> has no glyph; add it to ICONS in Icon.tsx (rendering a placeholder dot)`);
    }
    return (
      <span
        aria-hidden
        className={className}
        style={{ display: 'inline-block', width: size, height: size, borderRadius: 999, background: 'currentColor', opacity: 0.4, ...style }}
      />
    );
  }
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}
