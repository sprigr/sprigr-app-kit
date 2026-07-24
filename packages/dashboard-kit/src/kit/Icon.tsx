/**
 * Icon resolver. The prototype used inline SVG glyph sets resolved by name;
 * this maps those same names onto lucide-react (the glyphs were Lucide-style).
 * Unknown names fall back to a small dot so a missing mapping is visible, not
 * a crash. Add new names to ICONS as screens need them.
 */
import {
  Activity, ArrowRight, ArrowUp, Bell, Box, Boxes, Building2, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleCheck, CircleX, Code2, Copy, Database,
  ExternalLink, FastForward, Gauge, History, Inbox, KeyRound, Lock, Minus, Moon,
  Pause, Pencil, Play, Plus, RefreshCw, Route, Search, Settings, ShieldCheck,
  SlidersHorizontal, Sparkles, Sun, TriangleAlert, Undo2, User, Wind, Workflow, X,
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
};

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
