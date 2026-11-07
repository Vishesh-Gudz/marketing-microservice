"use client";

import { FileText, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "../connections/connection-notice";
import { ChannelCard, SectionHeader } from "../library";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { ConnectWhatsApp, useEmbeddedSignup } from "../whatsapp/connect-whatsapp";
import { WhatsAppAccounts } from "../whatsapp/whatsapp-accounts";

/**
 * WhatsApp settings (/whatsapp/settings; ADR 0014, B3): admins connect a WhatsApp Business
 * number through Meta's Embedded Signup and follow its setup; every member sees the connected
 * accounts. The inbox is /whatsapp. Non-admins never
 * call v1/whatsapp:getSignupConfig and never load Meta's SDK. The result of the latest action
 * is shown at the top and receives focus, so it is announced and reachable.
 */
export function WhatsAppView() {
  const org = useOrg();
  const isAdmin = org.role === "admin";
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onNotice = useCallback((next: Notice | null) => setNotice(next), []);
  const { data: config } = useAnalyticsQuery(
    api.v1.whatsapp.getSignupConfig,
    isAdmin ? {} : "skip",
  );
  const signup = useEmbeddedSignup(isAdmin ? config : null, onNotice);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs items={[{ label: "WhatsApp", href: "/whatsapp" }, { label: "Settings" }]} />
      <PageHeader
        title="WhatsApp settings"
        description="Connect your WhatsApp Business number and follow its setup."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/whatsapp/templates">
              <FileText aria-hidden="true" />
              Templates
            </Link>
          </Button>
        }
      />
      {notice && (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <ConnectionNotice notice={notice} />
        </div>
      )}
      <ChannelCard
        id="whatsapp-connect"
        icon={MessageCircle}
        title="Connect WhatsApp"
        description="A WhatsApp Business number, for your inbox and templates."
      >
        {isAdmin ? (
          <ConnectWhatsApp signup={signup} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can connect WhatsApp.
          </p>
        )}
      </ChannelCard>
      <section aria-labelledby="whatsapp-accounts" className="flex flex-col gap-3">
        <SectionHeader id="whatsapp-accounts" title="Connected accounts" />
        <QueryBoundary resetKey="whatsapp-accounts" title="WhatsApp accounts">
          <WhatsAppAccounts isAdmin={isAdmin} signup={signup} onNotice={onNotice} />
        </QueryBoundary>
      </section>
    </div>
  );
}
