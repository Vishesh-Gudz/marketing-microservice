import type { Page } from "@playwright/test";

/** An answer for one Convex function, from the query's arguments. */
export type Answer = (args: Record<string, unknown>) => unknown;

type Modification = {
  type?: string;
  queryId?: number;
  udfPath?: string;
  args?: Record<string, unknown>[];
  value?: unknown;
  journal?: unknown;
};

/**
 * Answer some Convex queries in the browser with fixed values, on the sync WebSocket: the
 * query is still sent to the local backend, and its reply (a result or an error, e.g. for an id
 * that does not exist) is replaced with `answers[udfPath](args)`. Every other message passes
 * through unchanged. Test data only: nothing is written to the backend.
 */
export async function answerQueries(page: Page, answers: Record<string, Answer>): Promise<void> {
  await page.routeWebSocket(/\/api\/[^/]+\/sync/, (ws) => {
    const server = ws.connectToServer();
    const answered = new Map<number, { answer: Answer; args: Record<string, unknown> }>();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes("ModifyQuerySet")) {
        const parsed = JSON.parse(message) as { type?: string; modifications?: Modification[] };
        for (const change of parsed.modifications ?? []) {
          const answer = change.udfPath === undefined ? undefined : answers[change.udfPath];
          if (change.type === "Add" && answer !== undefined && change.queryId !== undefined) {
            answered.set(change.queryId, { answer, args: change.args?.[0] ?? {} });
          }
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== "string" || answered.size === 0 || !message.includes("Transition")) {
        ws.send(message);
        return;
      }
      const parsed = JSON.parse(message) as { type?: string; modifications?: Modification[] };
      if (parsed.type === "Transition") {
        parsed.modifications = (parsed.modifications ?? []).map((change) => {
          const entry = change.queryId === undefined ? undefined : answered.get(change.queryId);
          if (entry === undefined) return change;
          if (change.type !== "QueryUpdated" && change.type !== "QueryFailed") return change;
          return {
            type: "QueryUpdated",
            queryId: change.queryId,
            value: entry.answer(entry.args),
            logLines: [],
            journal: change.journal ?? null,
          };
        });
      }
      ws.send(JSON.stringify(parsed));
    });
  });
}
