"use client";

import { useSyncExternalStore } from "react";

// The sidebar's collapsed state, kept in this browser (localStorage) and shared by every
// component that reads it. The server render is always expanded; a collapsed sidebar
// applies right after hydration.

const KEY = "gudz-marketing.sidebar";
const CHANGE = "gudz-marketing:sidebar";

// Used when storage is unavailable (private mode, blocked storage): the change still
// applies to this page, it is just not remembered.
let inMemory: boolean | null = null;

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

function read(): boolean {
  if (inMemory !== null) return inMemory;
  try {
    return window.localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function setSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded");
    inMemory = null;
  } catch {
    inMemory = collapsed;
  }
  window.dispatchEvent(new Event(CHANGE));
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
