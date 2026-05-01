import type { NavItem } from "@/types";

const clampIndex = (index: number, min: number, max: number) => Math.max(min, Math.min(max, index));

export const reorderTrayCards = (
  cards: NavItem[],
  fromIndex: number,
  toIndex: number,
  capacity: number,
) => {
  const list = cards.slice(0, capacity);
  if (fromIndex < 0 || fromIndex >= list.length) return list;
  const [moved] = list.splice(fromIndex, 1);
  if (!moved) return list;
  const clampedTo = clampIndex(toIndex, 0, capacity - 1);
  const insertAt = Math.min(clampedTo, list.length);
  list.splice(insertAt, 0, moved);
  return list;
};
