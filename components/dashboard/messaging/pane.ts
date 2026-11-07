// The open conversation's size (Kinso K3-K4), shared by the pane, its loading state and the
// route's loading skeleton. A plain module (no "use client"), so server components can use it.

/**
 * Below 1024 px the open conversation fills the screen between the top bar (3.5rem) and the dock
 * (the shell's 5rem bottom padding), like a chat app: the history scrolls and the composer stays
 * above the dock. It is never shorter than 30rem; on a shorter screen the page scrolls instead.
 * From 1024 px it fills the inbox workspace's pane.
 */
export const CONVERSATION_PANE_SIZE = "h-[calc(100dvh-8.5rem)] min-h-[30rem] lg:h-full lg:min-h-0";
