#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerBackup } from "./backup.js";
import { registerCapabilities } from "./capabilities.js";
import { registerStubs } from "./commands.js";
import { registerDoctor } from "./doctor.js";
import { registerExtract } from "./extract.js";
import { registerSync } from "./sync.js";
import { registerVerify } from "./verify.js";
import { registerWatch } from "./watch.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("vaultweave")
  .description("Your Notion, out of Notion — portable, versioned backups of a Notion workspace.")
  .version(version);

registerDoctor(program);
registerCapabilities(program);
registerExtract(program);
registerSync(program);
registerBackup(program);
registerVerify(program);
registerWatch(program);
registerStubs(program);

await program.parseAsync(process.argv);
