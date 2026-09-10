import { runMigrationCli } from "./cli.js";

const exitCode = await runMigrationCli(process.argv.slice(2), {
  start: async (actor, statePath) => {
    const { startMigrationRuntime } = await import("./runtime.js");
    return startMigrationRuntime(actor, statePath);
  },
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = exitCode;
