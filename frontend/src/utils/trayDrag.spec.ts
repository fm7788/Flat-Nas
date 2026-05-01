import { describe, it, expect } from "vitest";
import type { NavItem } from "@/types";
import { reorderTrayCards } from "./trayDrag";

const makeItem = (id: string): NavItem => ({
  id,
  title: id,
  url: `https://example.com/${id}`,
  icon: "",
  isPublic: true,
});

describe("reorderTrayCards", () => {
  it("reorders within range without mutating input", () => {
    const original = [makeItem("a"), makeItem("b"), makeItem("c")];
    const result = reorderTrayCards(original, 0, 2, 4);
    expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(original.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("moves to end when dropping beyond current length", () => {
    const original = [makeItem("a"), makeItem("b")];
    const result = reorderTrayCards(original, 0, 3, 4);
    expect(result.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("keeps order when from index is invalid", () => {
    const original = [makeItem("a"), makeItem("b")];
    const result = reorderTrayCards(original, 5, 1, 4);
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
