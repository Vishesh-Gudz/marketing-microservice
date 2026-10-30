"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "../connections/connection-notice";
import { MessagingAccounts } from "../instagram/messaging-accounts";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/**
 * Instagram DM settings (/instagram/messages/settings; ADR 0017, IM5): every linked Instagram
 * account with how its direct messages stand; admins turn them on, retry their setup or turn
 * them off. Every member sees the states. The result of the latest action is shown at the top
 * and receives focus, so it is announced and reachable.
 */
export function InstagramMessagingSettingsView() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onNotice = useCallback((next: Notice | null) => setNotice(next), []);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[{ label: "Instagram DMs", href: "/instagram/messages" }, { label: "Settings" }]}
      />
      <PageHeader
        title="Instagram DM settings"
        description="Turn direct messages on or off for your linked Instagram accounts."
      />
      {notice && (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <ConnectionNotice notice={notice} />
        </div>
      )}
      <section aria-labelledby="instagram-messaging-accounts" className="flex flex-col gap-3">
        <h2 id="instagram-messaging-accounts" className="text-lg font-semibold">
          Instagram accounts
        </h2>
        <QueryBoundary resetKey="instagram-messaging-accounts" title="Instagram accounts">
          <MessagingAccounts onNotice={onNotice} />
        </QueryBoundary>
      </section>
    </div>
  );
}
