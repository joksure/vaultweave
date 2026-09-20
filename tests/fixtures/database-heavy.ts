import {
  childDatabase,
  childPage,
  def,
  type Fixture,
  heading,
  P,
  pageParent,
  paragraph,
  schemaOf,
  WORKSPACE_PARENT,
  World,
} from "../support/world.js";

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

/** 101 rows (crosses the 100-item page boundary), >25 relations, views, multi-source database. */
export function databaseHeavy(): Fixture {
  const w = new World("database-heavy");
  const users = [w.id("user"), w.id("user")] as const;

  const dash = w.page({ title: "CRM Dashboard", parent: WORKSPACE_PARENT });
  const projectsDb = w.database({ title: "Projects", parent: pageParent(dash), inline: true });
  const tasksDb = w.database({ title: "Tasks", parent: pageParent(dash) });
  const multiDb = w.database({ title: "Multi-source", parent: pageParent(dash) });

  const tasksDs = w.dataSource(tasksDb, {
    name: "Tasks",
    properties: schemaOf(
      def("Name", "title", "title"),
      def("State", "st", "select", { options: [] }),
      def("Project", "proj", "relation", {}),
    ),
  });
  const projectsDs = w.dataSource(projectsDb, {
    name: "Projects",
    properties: schemaOf(
      def("Name", "title", "title"),
      def("Status", "stat", "select", {
        options: [{ name: "Planned" }, { name: "Active" }, { name: "Done" }],
      }),
      def("Tags", "tags", "multi_select", {
        options: [{ name: "web" }, { name: "mobile" }, { name: "data" }],
      }),
      def("Due", "due", "date"),
      def("Budget", "budg", "number", { format: "dollar" }),
      def("Owner", "ownr", "people"),
      def("Tasks", "tsks", "relation", { data_source_id: tasksDs, type: "dual_property" }),
      def("Health", "form", "formula", { expression: 'prop("Budget") / 1000' }),
      def("Open tasks", "roll", "rollup", { function: "count" }),
    ),
  });

  // Tasks first (projects reference them), back-references patched in afterwards.
  const taskIds: string[] = [];
  for (let i = 1; i <= 32; i++) {
    taskIds.push(
      w.row(tasksDs, {
        title: `Task ${pad(i, 2)}`,
        properties: {
          State: P.select("st", i % 2 ? "Open" : "Closed"),
          Project: P.relation("proj", []),
        },
      }),
    );
  }

  const statuses = ["Planned", "Active", "Done"];
  const tags = [["web"], ["mobile", "data"], ["web", "data"]];
  const projectIds: string[] = [];
  for (let i = 1; i <= 101; i++) {
    const related = i % 10 === 0 ? [taskIds[(i / 10) % taskIds.length] as string] : [];
    projectIds.push(
      w.row(projectsDs, {
        title: `Project ${pad(i)}`,
        properties: {
          Status: P.select("stat", statuses[i % 3] as string),
          Tags: P.multiSelect("tags", tags[i % 3] as string[]),
          Due: P.date("due", `2026-03-${pad((i % 28) + 1, 2)}`),
          Budget: P.number("budg", i * 1000),
          Owner: P.people("ownr", [users[i % 2] as string]),
          Tasks: P.relation("tsks", related),
          Health: P.formula("form", i),
          "Open tasks": P.rollup("roll", related.length),
        },
      }),
    );
  }

  // Row 7 relates to 30 tasks: the row payload is truncated at 25 (has_more) and the rest
  // must be fetched through the property-items endpoint.
  const bigRow = projectIds[6] as string;
  const thirty = taskIds.slice(0, 30);
  const bigRowPage = w.ws.pages.get(bigRow);
  if (bigRowPage) {
    (bigRowPage.properties as Record<string, unknown>).Tasks = P.relation(
      "tsks",
      thirty.slice(0, 25),
      true,
    );
  }
  w.propertyItems(
    bigRow,
    "tsks",
    thirty.map((id, k) => ({
      object: "property_item",
      type: "relation",
      id: `rel-${pad(k, 2)}`,
      relation: { id },
    })),
  );

  // Back-references on a few tasks.
  for (const [k, taskId] of taskIds.slice(0, 3).entries()) {
    const page = w.ws.pages.get(taskId);
    if (page)
      (page.properties as Record<string, unknown>).Project = P.relation("proj", [
        bigRow,
        projectIds[k] as string,
      ]);
  }

  // A row with a body containing a nested child page.
  const rowWithBody = projectIds[4] as string;
  const kickoff = w.page({ title: "Kickoff notes", parent: pageParent(rowWithBody) });
  w.body(rowWithBody, [paragraph("This row has a body."), childPage(kickoff, "Kickoff notes")]);
  w.body(kickoff, [paragraph("Agenda: scope, budget, owners.")]);

  // Multi-source database (two data sources under one database container).
  const alpha = w.dataSource(multiDb, {
    name: "Alpha",
    properties: schemaOf(def("Name", "title", "title")),
  });
  const beta = w.dataSource(multiDb, {
    name: "Beta",
    properties: schemaOf(def("Name", "title", "title")),
  });
  for (const n of [1, 2, 3]) w.row(alpha, { title: `Alpha ${n}` });
  for (const n of [1, 2, 3]) w.row(beta, { title: `Beta ${n}` });

  w.view(projectsDb, {
    name: "All projects",
    type: "table",
    dataSourceId: projectsDs,
    configuration: { type: "table", properties: [{ property_id: "title", visible: true }] },
  });
  w.view(projectsDb, {
    name: "By status",
    type: "board",
    dataSourceId: projectsDs,
    configuration: { type: "board", group_by: { type: "select", property_id: "stat" } },
  });
  w.view(projectsDb, {
    name: "Due dates",
    type: "calendar",
    dataSourceId: projectsDs,
    configuration: { type: "calendar", date_property_id: "due" },
  });
  w.view(tasksDb, {
    name: "Open tasks",
    type: "table",
    dataSourceId: tasksDs,
    configuration: { type: "table", properties: [{ property_id: "title", visible: true }] },
  });
  w.view(multiDb, {
    name: "Everything",
    type: "list",
    dataSourceId: alpha,
    configuration: { type: "list" },
  });

  w.body(dash, [
    heading(1, "CRM"),
    childDatabase(projectsDb, "Projects"),
    childDatabase(tasksDb, "Tasks"),
    childDatabase(multiDb, "Multi-source"),
  ]);

  return {
    name: "database-heavy",
    ws: w.ws,
    ids: {
      dash,
      projectsDb,
      tasksDb,
      multiDb,
      projectsDs,
      tasksDs,
      alpha,
      beta,
      bigRow,
      rowWithBody,
      kickoff,
    },
  };
}
