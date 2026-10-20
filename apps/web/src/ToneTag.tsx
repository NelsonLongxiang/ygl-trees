/**
 * Outlined status tag: the token color carries text and border over a
 * transparent ground, so the word sits on the card surface (≥4.8:1 for every
 * status color in both themes). antd's filled presets derive their own tint
 * from the theme algorithm — success on that tint is 2.67:1 in light.
 */
import type { ReactNode } from "react";
import { Tag } from "antd";

export function ToneTag({ color, children, style }: { color: string; children: ReactNode; style?: React.CSSProperties }) {
  return <Tag style={{ color, borderColor: color, background: "transparent", ...style }}>{children}</Tag>;
}
