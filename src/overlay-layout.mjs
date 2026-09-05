const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function overlayLayout({ player, viewport, preset, position = null }) {
  const padding = 14;
  const controlsClearance = 54;
  const visible = {
    left: Math.max(0, player.left),
    top: Math.max(0, player.top),
    right: Math.min(viewport.width, player.right),
    bottom: Math.min(viewport.height, player.bottom),
  };
  const visibleWidth = visible.right - visible.left;
  const visibleHeight = visible.bottom - visible.top;
  if (visibleWidth < 160 || visibleHeight < 120) return null;

  const bounds = {
    left: visible.left + padding,
    top: visible.top + padding,
    right: visible.right - padding,
    // On short players reserve what fits, while retaining room for the
    // viewer's controls. Larger players retain the full YouTube-control gap.
    bottom: visible.bottom - Math.min(controlsClearance, Math.max(padding, visibleHeight - 300 - padding)),
  };
  const width = Math.min(preset.width, bounds.right - bounds.left);
  const height = Math.min(preset.height, bounds.bottom - bounds.top);
  const left = position
    ? clamp(position.left, padding, Math.max(padding, viewport.width - width - padding))
    : bounds.right - width;
  const top = position
    ? clamp(position.top, padding, Math.max(padding, viewport.height - height - padding))
    : bounds.bottom - height;

  return {
    width, height, left, top,
    toggleLeft: Math.max(visible.left + padding, visible.right - 62),
    toggleTop: Math.max(visible.top + padding, visible.bottom - 108),
  };
}
