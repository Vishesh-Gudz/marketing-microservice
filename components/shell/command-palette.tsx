"use client";

import { CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NAV_LINKS, useNavQuery, withQuery, type FlatNavLink } from "@/components/dashboard/nav";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Every word typed must appear in the page's name, section or keywords. */
export function searchPages(text: string): FlatNavLink[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...NAV_LINKS];
  return NAV_LINKS.filter((link) => {
    const haystack = [link.name, link.section, link.parent?.label, link.keywords]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The result highlighted before any arrow key: the first page whose own name holds every word
 * typed (so "conv" picks Conversions, not Inbox by its keywords), else the first result.
 */
export function bestMatchIndex(results: readonly FlatNavLink[], text: string): number {
  const words = text.toLowerCase().split(/s+/).filter(Boolean);
  const byName = results.findIndex((link) =>
    words.every((word) => link.name.toLowerCase().includes(word)),
  );
  return Math.max(byName, 0);
}

const noSubscribe = () => () => {};

/** "⌘K" on Apple devices, "Ctrl K" elsewhere (the server render assumes Apple). */
export function useShortcutLabel(): string {
  const apple = useSyncExternalStore(
    noSubscribe,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  );
  return apple ? "⌘K" : "Ctrl K";
}

/** Toggles the palette on ⌘K / Ctrl+K anywhere in the dashboard. */
export function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}

function PaletteBody({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const query = useNavQuery();
  const listId = useId();
  const [text, setText] = useState("");
  // null until an arrow key or the pointer picks a result: then the best match is highlighted.
  const [cursor, setCursor] = useState<number | null>(null);
  const results = searchPages(text);
  const activeIndex =
    results.length === 0
      ? -1
      : cursor === null
        ? bestMatchIndex(results, text)
        : Math.min(cursor, results.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  function go(link: FlatNavLink) {
    onDone();
    router.push(withQuery(link.href, query));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    const last = results.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor(activeIndex >= last ? 0 : activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(activeIndex <= 0 ? last : activeIndex - 1);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setCursor(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const link = results[activeIndex];
      if (link) go(link);
    }
  }

  // Consecutive results of one section form a group.
  const groups: { section: string; items: { link: FlatNavLink; index: number }[] }[] = [];
  results.forEach((link, index) => {
    const lastGroup = groups.at(-1);
    if (lastGroup?.section === link.section) lastGroup.items.push({ link, index });
    else groups.push({ section: link.section, items: [{ link, index }] });
  });

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-label="Search pages"
          placeholder="Search pages…"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(null);
          }}
          onKeyDown={onKeyDown}
          className="h-13 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <kbd className="hidden rounded-[6px] border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">
          Esc
        </kbd>
      </div>
      <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
        <div id={listId} role="listbox" aria-label="Pages">
          {groups.map((group) => (
            <div
              key={`${group.section}-${group.items[0]!.index}`}
              role="group"
              aria-label={group.section}
            >
              <div
                aria-hidden="true"
                className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase"
              >
                {group.section}
              </div>
              {group.items.map(({ link, index }) => {
                const active = index === activeIndex;
                const Icon = link.icon;
                return (
                  <div
                    key={link.href}
                    id={optionId(index)}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => {
                      if (!active) setCursor(index);
                    }}
                    onClick={() => go(link)}
                    className={cn(
                      "flex h-10 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 text-sm text-ink-2",
                      active && "bg-blue-50 text-ink",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active ? "text-blue-deep" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{link.name}</span>
                    {link.parent &&
                      !link.name.toLowerCase().includes(link.parent.label.toLowerCase()) && (
                        <span className="text-xs text-muted-foreground">{link.parent.label}</span>
                      )}
                    {active && (
                      <CornerDownLeft className="size-3.5 text-blue-deep" aria-hidden="true" />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {results.length === 0 && (
          <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">
            No pages match &ldquo;{text.trim()}&rdquo;.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * ⌘K: jump to any dashboard page. Pages only for now (no server search); links carry the
 * global filters like the sidebar does. Radix handles the focus trap, Escape and focus return.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-0 p-0 sm:top-[12vh] sm:w-[min(92vw,36rem)] sm:translate-y-0"
      >
        <DialogTitle className="sr-only">Go to a page</DialogTitle>
        <PaletteBody onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
