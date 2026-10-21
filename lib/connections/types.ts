import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AdAccount, Connection } from "@/lib/analytics/types";

// Connection-flow types, derived from the PUBLIC v1 API only (type-only imports, D23).
// Nothing here is React-specific: the future SDK (Phase 14) can reuse these helpers.

export type DiscoveredAsset = FunctionReturnType<
  typeof api.v1.connections.listDiscoveredAssets
>[number];
export type ManagerStatus = DiscoveredAsset["managerStatus"];
export type TestAccountStatus = DiscoveredAsset["testAccountStatus"];
export type AccountStatus = DiscoveredAsset["status"];
export type ConnectionStatus = Connection["status"];
export type ConnectionError = NonNullable<Connection["lastError"]>;
export type SyncStatus = NonNullable<AdAccount["sync"]>;
/** Allowlisted public error reasons (shared by connection discovery and sync errors). */
export type ErrorReason = NonNullable<ConnectionError["reason"]>;

export type NoticeTone = "success" | "info" | "warning" | "error";
/** A user-facing message. Never carries raw platform codes or callback parameter values. */
export type Notice = { tone: NoticeTone; title: string; message: string };
