import type { Fixture } from "../support/world.js";
import { databaseHeavy } from "./database-heavy.js";
import { docsHeavy } from "./docs-heavy.js";
import { mediaHeavy } from "./media-heavy.js";

export const FIXTURES: ReadonlyArray<{ name: string; build: () => Fixture }> = [
  { name: "docs-heavy", build: docsHeavy },
  { name: "database-heavy", build: databaseHeavy },
  { name: "media-heavy", build: mediaHeavy },
];
