"use client";

import { useAction } from "convex/react";
import Script from "next/script";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import {
  awaitingFinish,
  codeOfLoginResponse,
  IDLE,
  nextAttempt,
  PAIRING_TIMEOUT_MS,
  parseSignupMessage,
} from "@/lib/whatsapp/embedded-signup";
import {
  availableConfig,
  embeddedSignupLoginOptions,
  facebookSdk,
  FACEBOOK_SDK_URL,
  initFacebookSdk,
} from "@/lib/whatsapp/facebook-sdk";
import {
  SDK_FAILED_NOTICE,
  setupResultNotice,
  signupEndNotice,
  signupErrorNotice,
  UNAVAILABLE_NOTICE,
} from "@/lib/whatsapp/messages";
import type { SignupConfig } from "@/lib/whatsapp/types";
import { ConnectionNotice } from "../connections/connection-notice";

export type SignupStatus =
  /** Not an admin: nothing is loaded, nothing can start. */
  | "disabled"
  | "loading_config"
  | "unavailable"
  | "preparing"
  | "sdk_failed"
  | "ready"
  | "waiting"
  | "completing";

export type EmbeddedSignup = {
  status: SignupStatus;
  /** Opens Meta's signup. Call it directly from a click (pop-up blockers): no-op unless ready. */
  start: () => void;
  /** Meta's SDK script (next/script), rendered only when signup is available. */
  script: ReactNode;
};

/**
 * Meta's Embedded Signup for the WhatsApp page (ADR 0014, B3). The SDK is loaded only when
 * `config` says signup is available (the page passes null for non-admins, so nothing loads
 * for them). One attempt at a time: the code from FB.login and the ids from Meta's message
 * are paired in memory (lib/whatsapp/embedded-signup), handed to v1/whatsapp:completeSignup
 * once, and dropped; the code is never rendered, logged, stored or put in a URL. Every
 * outcome reaches `onNotice` as fixed text.
 */
export function useEmbeddedSignup(
  config: SignupConfig | undefined | null,
  onNotice: (notice: Notice | null) => void,
): EmbeddedSignup {
  const completeSignup = useAction(api.v1.whatsapp.completeSignup);
  const available = config === null ? null : availableConfig(config);
  const [sdk, setSdk] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, dispatch] = useReducer(nextAttempt, IDLE);
  const [completing, setCompleting] = useState(false);
  // Attempts already handed to the server. A WeakSet: it never keeps an attempt (and its code)
  // alive once nothing else refers to it.
  const submitted = useRef(new WeakSet<object>());
  const reported = useRef<object | null>(null);
  // Held from start() until the attempt ended or the server answered: a second start in the
  // same tick (before React re-renders the status) never opens a second Meta window.
  const busy = useRef(false);
  const settled = attempt.phase === "ended" || (attempt.phase === "idle" && !completing);
  useEffect(() => {
    if (settled) busy.current = false;
  }, [settled, attempt]);

  // Meta's messages count only while an attempt waits for them.
  const waiting = attempt.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const onMessage = (event: MessageEvent) => {
      const message = parseSignupMessage(event.origin, event.data);
      if (message !== null) dispatch({ type: "message", message });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [waiting]);

  const pairing = awaitingFinish(attempt);
  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => dispatch({ type: "timeout" }), PAIRING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pairing]);

  useEffect(() => {
    if (attempt.phase === "ended" && reported.current !== attempt) {
      reported.current = attempt;
      onNotice(signupEndNotice(attempt.end));
    }
    if (attempt.phase !== "ready" || submitted.current.has(attempt)) return;
    submitted.current.add(attempt);
    const { code, wabaId, phoneNumberId } = attempt;
    dispatch({ type: "submitted" });
    setCompleting(true);
    completeSignup({ code, wabaId, phoneNumberId }).then(
      (result) => {
        setCompleting(false);
        onNotice(setupResultNotice(result));
      },
      (error: unknown) => {
        setCompleting(false);
        onNotice(signupErrorNotice(error));
      },
    );
  }, [attempt, completeSignup, onNotice]);

  let status: SignupStatus;
  if (config === null) status = "disabled";
  else if (config === undefined) status = "loading_config";
  else if (available === null) status = "unavailable";
  else if (completing) status = "completing";
  else if (attempt.phase === "waiting" || attempt.phase === "ready") status = "waiting";
  else if (sdk === "failed") status = "sdk_failed";
  else if (sdk === "loading") status = "preparing";
  else status = "ready";

  const start = useCallback(() => {
    const loaded = facebookSdk();
    if (busy.current || status !== "ready" || available === null || loaded === undefined) return;
    busy.current = true;
    onNotice(null);
    dispatch({ type: "start" });
    loaded.login(
      (response) => dispatch({ type: "login", code: codeOfLoginResponse(response) }),
      embeddedSignupLoginOptions(available),
    );
  }, [status, available, onNotice]);

  const script =
    available === null ? null : (
      <Script
        src={FACEBOOK_SDK_URL}
        strategy="afterInteractive"
        crossOrigin="anonymous"
        onReady={() => {
          const loaded = facebookSdk();
          if (loaded === undefined) {
            setSdk("failed");
            return;
          }
          initFacebookSdk(loaded, available);
          setSdk("ready");
        }}
        onError={() => setSdk("failed")}
      />
    );

  return { status, start, script };
}

const PROGRESS: Partial<Record<SignupStatus, string>> = {
  waiting: "Finish the steps in the Meta window. Keep this page open.",
  completing: "Connecting your WhatsApp number. This can take a few seconds.",
};

const BUTTON_LABEL: Partial<Record<SignupStatus, string>> = {
  preparing: "Preparing Meta sign-in…",
  waiting: "Waiting for Meta…",
  completing: "Connecting…",
};

/** The "Connect WhatsApp" control (admins). */
export function ConnectWhatsApp({ signup }: { signup: EmbeddedSignup }) {
  const { status } = signup;
  if (status === "disabled") return null;
  if (status === "loading_config") {
    return (
      <Skeleton
        className="h-9 w-48"
        role="status"
        aria-label="Checking whether WhatsApp can be connected"
      />
    );
  }
  if (status === "unavailable") return <ConnectionNotice notice={UNAVAILABLE_NOTICE} />;
  return (
    <div className="flex flex-col items-start gap-2">
      {signup.script}
      {status === "sdk_failed" ? (
        <ConnectionNotice notice={SDK_FAILED_NOTICE} />
      ) : (
        <Button type="button" disabled={status !== "ready"} onClick={signup.start}>
          {BUTTON_LABEL[status] ?? "Connect WhatsApp"}
        </Button>
      )}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {PROGRESS[status] ?? ""}
      </p>
    </div>
  );
}
