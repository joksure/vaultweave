import {
  bookmark,
  bulleted,
  callout,
  childPage,
  code,
  columnList,
  divider,
  embed,
  emoji,
  equation,
  type Fixture,
  heading,
  linkToPage,
  mentionPage,
  numbered,
  pageParent,
  paragraph,
  quote,
  rt,
  syncedCopy,
  syncedOriginal,
  table,
  toc,
  todo,
  toggle,
  unsupported,
  WORKSPACE_PARENT,
  World,
} from "../support/world.js";

/** Nested pages, deep block trees, a >100-block page, synced blocks, unsupported block, orphan page. */
export function docsHeavy(): Fixture {
  const w = new World("docs-heavy");
  const toggleId = w.id("block");
  const syncedId = w.id("block");

  const handbook = w.page({
    title: "Engineering Handbook",
    parent: WORKSPACE_PARENT,
    icon: emoji("📘"),
  });
  const onboarding = w.page({ title: "Onboarding", parent: pageParent(handbook) });
  const day1 = w.page({ title: "Day 1 checklist", parent: pageParent(onboarding) });
  const runbooks = w.page({ title: "Runbooks", parent: pageParent(handbook) });
  const changelog = w.page({ title: "Changelog (long page)", parent: pageParent(handbook) });
  const hidden = w.page({
    title: "Page inside a toggle",
    parent: { type: "block_id", block_id: toggleId },
  });
  const decisions = w.page({ title: "Architecture decisions", parent: WORKSPACE_PARENT });
  // Visible to the integration, but its parent is not shared with it.
  const orphan = w.page({
    title: "Shared orphan",
    parent: pageParent("99999999-0000-4000-8000-000000000001"),
  });

  w.body(handbook, [
    heading(1, "Welcome"),
    paragraph([
      rt("Read "),
      rt("this first", { bold: true }),
      rt(", then "),
      mentionPage(onboarding, "Onboarding"),
      rt(" and the "),
      rt("style guide", { link: "https://example.com/style" }),
      rt("."),
    ]),
    quote("Make it work, make it right, make it fast."),
    callout("Ask in #eng-help before opening a ticket.", emoji("💡")),
    divider(),
    toc(),
    bulleted("Principles", [
      bulleted("Small changes", [
        bulleted("One concern per PR"),
        bulleted("Keep diffs reviewable"),
      ]),
      bulleted("Fast feedback"),
    ]),
    numbered("Clone the repo"),
    numbered("Run the tests"),
    todo("Set up SSH keys", true),
    todo("Join the on-call rota", false),
    code("export const answer = 42;", "typescript"),
    equation("E = mc^2"),
    table([
      ["Environment", "URL"],
      ["staging", "https://staging.example.com"],
      ["production", "https://example.com"],
    ]),
    columnList([[paragraph("Left column"), bulleted("Left item")], [paragraph("Right column")]]),
    toggle(
      "More reading",
      [paragraph("Inside the toggle."), childPage(hidden, "Page inside a toggle")],
      toggleId,
    ),
    bookmark("https://example.com/docs"),
    embed("https://example.com/embed"),
    linkToPage(runbooks),
    syncedOriginal(
      [paragraph("Security reminder: never paste secrets."), bulleted("Rotate keys quarterly")],
      syncedId,
    ),
    childPage(onboarding, "Onboarding"),
    childPage(runbooks, "Runbooks"),
    childPage(changelog, "Changelog (long page)"),
  ]);

  w.body(onboarding, [
    paragraph("Welcome aboard."),
    syncedCopy(syncedId),
    childPage(day1, "Day 1 checklist"),
    bookmark("https://example.com/hr"),
  ]);
  w.body(day1, [todo("Laptop", true), todo("Accounts", false), todo("Meet your buddy", false)]);
  w.body(runbooks, [
    paragraph("Incident response basics."),
    unsupported(),
    numbered("Acknowledge the page"),
    numbered("Open an incident channel"),
  ]);
  w.body(
    changelog,
    Array.from({ length: 105 }, (_, i) => paragraph(`Entry ${String(i + 1).padStart(3, "0")}`)),
  );
  w.body(hidden, [paragraph("Found me.")]);
  w.body(decisions, [
    heading(2, "ADR-001: Use PostgreSQL"),
    code("SELECT 1;", "sql"),
    callout("Status: accepted", emoji("✅")),
    table([
      ["Option", "Verdict"],
      ["PostgreSQL", "yes"],
      ["MongoDB", "no"],
    ]),
  ]);
  w.body(orphan, [paragraph("I am shared, but my parent is not.")]);

  return {
    name: "docs-heavy",
    ws: w.ws,
    ids: {
      handbook,
      onboarding,
      day1,
      runbooks,
      changelog,
      hidden,
      decisions,
      orphan,
      toggle: toggleId,
      synced: syncedId,
    },
  };
}
