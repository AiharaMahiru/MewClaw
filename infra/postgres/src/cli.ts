#!/usr/bin/env node
/**
 * 便携 PostgreSQL 命令行入口（install/setup/start/status/stop 与 pgweb 管理）。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */

import { createRuntimePaths, loadLocalDatabaseConfig, redactDatabaseUrl } from "./config.js";
import { installPortablePostgres } from "./installer.js";
import { getPostgresStatus, startPostgres, stopPostgres } from "./lifecycle.js";
import { installPgweb } from "./pgweb-installer.js";
import { getPgwebStatus, startPgweb, stopPgweb } from "./pgweb.js";

const repositoryRoot = process.cwd();
const paths = createRuntimePaths(repositoryRoot);
const config = loadLocalDatabaseConfig(process.env);
const command = process.argv[2];

try {
  if (command === "install") {
    await installPortablePostgres(paths);
    console.log(`Portable PostgreSQL installed under ${paths.postgresRoot}`);
  } else if (command === "setup") {
    await installPortablePostgres(paths);
    await startPostgres(paths, config);
    await printStatus();
  } else if (command === "start") {
    await startPostgres(paths, config);
    await printStatus();
  } else if (command === "stop") {
    await stopPostgres(paths);
    console.log("Portable PostgreSQL stopped");
  } else if (command === "status") {
    await printStatus();
  } else if (command === "web-install") {
    await installPgweb(paths);
    console.log(`Portable pgweb installed under ${paths.pgwebRoot}`);
  } else if (command === "web-setup") {
    await installPgweb(paths);
    await startPgweb(paths, config);
    await printPgwebStatus();
  } else if (command === "web-start") {
    await startPgweb(paths, config);
    await printPgwebStatus();
  } else if (command === "web-stop") {
    await stopPgweb(paths);
    console.log("Portable pgweb stopped");
  } else if (command === "web-status") {
    await printPgwebStatus();
  } else {
    throw new Error("Usage: postgres-runtime <install|setup|start|stop|status|web-*>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function printStatus(): Promise<void> {
  const status = await getPostgresStatus(paths, config);
  console.log(
    JSON.stringify({ ...status, database: redactDatabaseUrl(config), dataRoot: paths.dataRoot }),
  );
  if (!status.running || !status.vectorVersion) process.exitCode = 1;
}

async function printPgwebStatus(): Promise<void> {
  const status = await getPgwebStatus(paths);
  console.log(JSON.stringify(status));
  if (!status.running) process.exitCode = 1;
}
