/**
 * @sprigr/apps-dashboard-kit — shared dashboard design system.
 *
 * Styles are imported separately (CSS, not JS):
 *   import "@sprigr/apps-dashboard-kit/styles";   // after `@import "tailwindcss";`
 *
 * Everything below is the React component kit. Requires React 18+ and
 * lucide-react (peer deps), and the Tailwind v4 utility layer + the kit's CSS.
 */

export { Icon, type IconProps } from './kit/Icon';
export { Avatar } from './kit/Avatar';
export {
  StatusBadge, SeverityBadge, ExcStatusBadge, FreshnessDot, HealthBar,
  ROUTING_TONES, SEV, EXC_STATUS, FRESH,
} from './kit/badges';
export { Code, CopyChip } from './kit/Code';
export { Loading, EmptyState, ErrorState } from './kit/states';
export { DataTable, Checkbox, type Column, type DataTableProps } from './kit/DataTable';
export { FilterBar, Segmented, Toggle, type SegmentedOption } from './kit/filters';
export { Drawer, type DrawerProps } from './kit/Drawer';
export { AuditTimeline, type AuditItem } from './kit/AuditTimeline';
export { KV, FieldGroup } from './kit/fields';
export { ConfirmDialog, type ConfirmDialogProps } from './kit/ConfirmDialog';
export { ResultPanel, type ToolResult } from './kit/ResultPanel';
export { StatTile, type StatTileProps } from './kit/StatTile';
export { ToastProvider, useToast } from './kit/toast';
export { TONE_C, type Tone } from './kit/tones';
export { relTime, relFromMs, ageLabel } from './kit/time';
export { money } from './kit/money';
