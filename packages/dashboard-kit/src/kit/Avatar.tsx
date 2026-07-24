/** Initials avatar with a gradient fill. */
export function Avatar({ name, color = '#6366f1', size = 26 }: { name?: string; color?: string; size?: number }) {
  const initials = (name || '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-white font-medium shrink-0"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${color}, #4f46e5)`, fontSize: Math.max(9, size * 0.38), boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.15)' }}
    >
      {initials}
    </span>
  );
}
