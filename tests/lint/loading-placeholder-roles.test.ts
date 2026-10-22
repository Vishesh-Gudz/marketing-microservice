import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Generic elements (<div>, <span>, and <Skeleton>, which renders a <div>) have no role: an
// aria-label on them is prohibited (axe "aria-prohibited-attr") and not reliably announced.
// Labelled loading placeholders use role="status" (as the organic views always did); inline
// markers such as the partial-data asterisk use screen-reader-only text instead
// (components/dashboard/partial-marker.tsx).

const ROOTS = ["components", "app"].map((dir) => join(process.cwd(), dir));

/** Opening <div> / <span> / <Skeleton> tags, including multi-line JSX and `{…}` values. */
const OPENING_TAG = /<(div|span|Skeleton)\b(?:[^<>]|=>|\{[^{}]*\})*?>/gs;

function sourceFiles(): string[] {
  return ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx") && !/\.test\.tsx$/.test(file))
      .map((file) => join(root, file)),
  );
}

function roleLessLabels(source: string): string[] {
  return [...source.matchAll(OPENING_TAG)]
    .map(([tag]) => tag)
    .filter((tag) => /\baria-label=/.test(tag) && !/\brole=/.test(tag));
}

describe("labelled generic elements have a role", () => {
  it("detects the problem it guards against", () => {
    expect(
      roleLessLabels('<Skeleton className="h-4" aria-label="Loading campaigns" />'),
    ).toHaveLength(1);
    expect(
      roleLessLabels(
        '<div\n  className="x"\n  aria-busy="true"\n  aria-label={`Loading ${name}`}\n>',
      ),
    ).toHaveLength(1);
    expect(roleLessLabels('<span aria-label="(partial data)">*</span>')).toHaveLength(1);
    expect(
      roleLessLabels(
        '<span\n  className="ml-0.5 text-amber-600"\n  aria-label={partial ? "(partial data)" : undefined}\n>\n  *\n</span>',
      ),
    ).toHaveLength(1);
    expect(
      roleLessLabels('<Skeleton className="h-4" role="status" aria-label="Loading campaigns" />'),
    ).toEqual([]);
    expect(roleLessLabels('<span role="img" aria-label="(partial data)">*</span>')).toEqual([]);
    // Other attributes that merely contain the word are not labels.
    expect(roleLessLabels('<span aria-labelledby="heading">x</span>')).toEqual([]);
    expect(roleLessLabels('<span className="sr-only"> (partial data)</span>')).toEqual([]);
  });

  it("no <div>, <span> or <Skeleton> in components/ or app/ carries an aria-label without a role", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((file) =>
      roleLessLabels(readFileSync(file, "utf8")).map(
        (tag) => `${file.replace(process.cwd(), "")}: ${tag.replace(/\s+/g, " ")}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
