import { describe, expect, it } from "vitest";
import {
  YOUTUBE_DISCONNECT_CONSEQUENCES,
  youtubeDeletionNotice,
  youtubeOtherDeletionNotice,
} from "./youtube";

// A YouTube disconnect deletes the channel's stored data on the server; the page claims the
// deletion only once the server confirms it (the channel's row is gone).

describe("youtubeDeletionNotice", () => {
  it("shows nothing before a disconnect", () => {
    expect(youtubeDeletionNotice(null, [{ id: "a" }])).toBeNull();
  });

  it("is in progress while a channel row remains, and confirmed only once it is gone", () => {
    const deletion = { channelIds: ["a"] };
    const pending = youtubeDeletionNotice(deletion, [{ id: "a" }, { id: "other" }]);
    expect(pending).toMatchObject({ tone: "info", title: "Deleting stored YouTube data…" });
    expect(pending!.message).not.toMatch(/deleted\./);
    expect(youtubeDeletionNotice(deletion, [{ id: "other" }])).toMatchObject({
      tone: "success",
      title: "Stored YouTube data deleted",
    });
  });

  it("never claims Google confirmed the revocation", () => {
    for (const notice of [
      youtubeDeletionNotice({ channelIds: [] }, []),
      youtubeDeletionNotice({ channelIds: ["a"] }, [{ id: "a" }]),
      youtubeDeletionNotice({ channelIds: ["a"] }, []),
    ]) {
      expect(notice!.message).not.toMatch(/Google (confirmed|revoked)/);
    }
    expect(youtubeDeletionNotice({ channelIds: [] }, [])).toMatchObject({
      title: "YouTube disconnected",
    });
  });
});

describe("youtubeOtherDeletionNotice", () => {
  it("counts deletions this page did not start", () => {
    expect(youtubeOtherDeletionNotice(0)).toBeNull();
    expect(youtubeOtherDeletionNotice(1)!.message).toContain("1 channel ");
    expect(youtubeOtherDeletionNotice(2)!.message).toContain("2 channels");
  });
});

describe("YOUTUBE_DISCONNECT_CONSEQUENCES", () => {
  it("says the stored data is deleted and that this cannot be undone", () => {
    expect(YOUTUBE_DISCONNECT_CONSEQUENCES.join(" ")).toMatch(/is deleted\. This cannot be undone/);
  });
});
