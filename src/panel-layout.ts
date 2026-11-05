export type PanelSize = { width: number; height: number };
type Bounds = PanelSize & { x: number; y: number };
export const panelDefaults = { width: 334, height: 426 };

export function fitPanel(size: PanelSize, bounds: Bounds, area: Bounds, bottomSpace: number) {
  const width = Math.min(area.width, Math.max(0, Math.round(size.width)) + 26);
  const height = Math.min(area.height, Math.max(0, Math.round(size.height)) + bottomSpace);
  const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
  const x = Math.max(area.x, Math.min(right - width, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bottom - height, area.y + area.height - height));
  return { bounds: { x, y, width, height }, size: { width: Math.max(0, width - 26), height: Math.max(0, height - bottomSpace) } };
}
