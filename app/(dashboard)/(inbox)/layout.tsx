import type { ReactNode } from "react";
import { InboxWorkspace } from "@/components/dashboard/messaging/workspace";

// The inbox workspace around /inbox, /whatsapp, /instagram/messages and both conversation
// routes: the list stays mounted while conversations open beside it. Saved replies, templates
// and settings stay outside this group, as full pages.
export default function InboxLayout({ children }: { children: ReactNode }) {
  return <InboxWorkspace>{children}</InboxWorkspace>;
}
