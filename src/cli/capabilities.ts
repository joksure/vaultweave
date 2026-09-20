import type { Command } from "commander";
import { renderCapabilitiesMarkdown } from "../core/capabilities.js";

export function registerCapabilities(program: Command): void {
  program
    .command("capabilities")
    .description("Print what can and cannot be exported (the honesty matrix)")
    .action(() => {
      process.stdout.write(renderCapabilitiesMarkdown());
    });
}
