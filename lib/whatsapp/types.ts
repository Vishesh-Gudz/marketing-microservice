import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// WhatsApp connection types (ADR 0014), derived from the PUBLIC v1 API only (type-only
// imports, D23): the dashboard never imports the server's DTO modules.

type WhatsApp = typeof api.v1.whatsapp;

export type SignupConfig = FunctionReturnType<WhatsApp["getSignupConfig"]>;
export type SetupResult = FunctionReturnType<WhatsApp["completeSignup"]>;
export type WhatsAppAccount = FunctionReturnType<WhatsApp["listAccounts"]>[number];
export type WhatsAppNumber = WhatsAppAccount["numbers"][number];
export type SetupStatus = WhatsAppAccount["setupStatus"];
export type SetupStep = NonNullable<WhatsAppAccount["nextStep"]>;
