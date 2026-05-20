import type { BookmarkItem, BookmarkCategory } from "@/types";

export const parseBookmarks = (html: string): (BookmarkItem | BookmarkCategory)[] => {
  // Preprocess: Remove <p> tags which break parsing in strict HTML parsers (like DOMParser)
  // because <p> is not allowed inside <dl> in strict mode, causing elements to be ejected or structure to break.
  // Netscape bookmark files use <p> loosely as separators.
  const cleanHtml = html.replace(/<p>/gi, "").replace(/<\/p>/gi, "");
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleanHtml, "text/html");
  const createId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const directChild = (parent: Element, tagName: string) =>
    Array.from(parent.children).find((child) => child.tagName.toLowerCase() === tagName.toLowerCase()) ||
    null;
  const isBookmarkUrl = (url: string) => /^(https?|ftp):/i.test(url);

  const processList = (dl: Element): (BookmarkItem | BookmarkCategory)[] => {
    const items: (BookmarkItem | BookmarkCategory)[] = [];
    const children = Array.from(dl.children);

    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (!node) continue;
      // Handle DT (Item or Folder)
      if (node.tagName.toLowerCase() === "dt") {
        const h3 = directChild(node, "h3");
        const a = directChild(node, "a") as HTMLAnchorElement | null;

        if (h3) {
          // Folder
          const title = h3.textContent || "Untitled Folder";
          let childrenList: (BookmarkItem | BookmarkCategory)[] = [];

          // 1. Check inside the DT itself (some parsers put DL inside DT when <p> is removed)
          const internalDL = directChild(node, "dl");
          if (internalDL) {
            childrenList = processList(internalDL);
          } else {
            // 2. Look ahead for siblings
            for (let j = i + 1; j < children.length; j++) {
              const sibling = children[j];
              if (!sibling) continue;
              const tagName = sibling.tagName.toLowerCase();

              if (tagName === "dl") {
                childrenList = processList(sibling);
                break; // Found the children container
              } else if (tagName === "dd") {
                const childDL = directChild(sibling, "dl");
                if (childDL) {
                  childrenList = processList(childDL);
                }
                break; // Found the children container
              } else if (tagName === "dt") {
                break; // Hit the next item, so this folder is empty
              }
            }
          }

          items.push({
            id: createId(),
            title,
            type: "category",
            children: childrenList,
            collapsed: false,
          });
        } else if (a) {
          // Link
          const rawUrl = a.getAttribute("href") || a.href || "";
          const url = rawUrl.trim();
          if (!isBookmarkUrl(url)) continue;

          let icon =
            a.getAttribute("icon") ||
            a.getAttribute("ICON") ||
            a.getAttribute("icon_uri") ||
            a.getAttribute("ICON_URI");
          if (!icon) {
            try {
              icon = `https://www.favicon.vip/get.php?url=${encodeURIComponent(url)}`;
            } catch {
              icon = "";
            }
          }

          items.push({
            id: createId(),
            title: a.textContent || url,
            url,
            icon: icon || "",
            type: "link",
          });
        }
      } else if (node.tagName.toLowerCase() === "dl") {
        items.push(...processList(node));
      } else if (node.tagName.toLowerCase() === "dd") {
        const childDL = directChild(node, "dl");
        if (childDL) {
          items.push(...processList(childDL));
        }
      }
    }
    return items;
  };

  const rootDL = doc.querySelector("dl");
  if (!rootDL) {
    // Fallback: just find all links if no DL structure found
    const links = doc.querySelectorAll("a");
    const simpleItems: BookmarkItem[] = [];
    links.forEach((link) => {
      const anchor = link as HTMLAnchorElement;
      const url = (anchor.getAttribute("href") || anchor.href || "").trim();
      if (!isBookmarkUrl(url)) return;
      simpleItems.push({
        id: createId(),
        title: anchor.textContent || url,
        url: url,
        icon: "",
        type: "link",
      });
    });
    return simpleItems;
  }

  return processList(rootDL);
};
