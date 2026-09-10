import { assertPort, assertSafeAbsolutePath, assertSafeToken } from "./validation.js";

const SYSTEMD_RESTART_SECONDS = 5;
const SYSTEMD_STOP_SECONDS = 30;
const NGINX_KEEPALIVE_CONNECTIONS = 32;
const EXPECTED_LIVE_PROXY_PASSES = 2;

interface SystemdUnitConfig {
  after: readonly string[];
  args: readonly string[];
  description: string;
  entrypoint: string;
  environment: readonly SystemdEnvironmentOverride[];
  environmentFile: string;
  name: string;
  nodePath: string;
  requires: readonly string[];
  workingDirectory: string;
  writablePaths: readonly string[];
}

interface SystemdEnvironmentOverride {
  name: string;
  value: string;
}

interface NginxOverlayConfig {
  authEdgePort: number;
  certificateKeyPath: string;
  certificatePath: string;
  serverName: string;
}

export function renderSystemdUnit(config: SystemdUnitConfig): string {
  validateSystemdConfig(config);
  const after = config.after.length > 0 ? [`After=${config.after.join(" ")}`] : [];
  const requires = config.requires.length > 0 ? [`Requires=${config.requires.join(" ")}`] : [];
  const execStart = [config.nodePath, config.entrypoint, ...config.args].join(" ");
  const environment = config.environment.map(({ name, value }) => `Environment=${name}=${value}`);
  return [
    "[Unit]",
    `Description=${config.description}`,
    ...after,
    ...requires,
    "",
    "[Service]",
    "Type=simple",
    "User=dsh",
    "Group=dsh",
    `WorkingDirectory=${config.workingDirectory}`,
    `EnvironmentFile=${config.environmentFile}`,
    ...environment,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    `RestartSec=${SYSTEMD_RESTART_SECONDS}s`,
    `TimeoutStopSec=${SYSTEMD_STOP_SECONDS}s`,
    "KillSignal=SIGTERM",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectHome=true",
    "ProtectSystem=strict",
    `ReadWritePaths=${config.writablePaths.join(" ")}`,
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function rewriteNginxLoopbackProxyPasses(source: string, currentPort: number, nextPort: number): string {
  const current = assertPort(currentPort, "current proxy port");
  const next = assertPort(nextPort, "next proxy port");
  if (current === next) throw new Error("current and next proxy ports must differ");
  const directive = new RegExp(
    `^([ \\t]*)proxy_pass[ \\t]+http:\\/\\/127\\.0\\.0\\.1:${current};[ \\t]*(\\r?)$`,
    "gm",
  );
  let replacements = 0;
  const candidate = source.replace(directive, (_match, indentation: string, carriageReturn: string) => {
    replacements += 1;
    return `${indentation}proxy_pass http://127.0.0.1:${next};${carriageReturn}`;
  });
  if (replacements !== EXPECTED_LIVE_PROXY_PASSES) {
    throw new Error(`live Nginx vhost must contain exactly ${EXPECTED_LIVE_PROXY_PASSES} matching proxy_pass directives`);
  }
  return candidate;
}

export function renderNginxOverlay(config: NginxOverlayConfig): string {
  const port = assertPort(config.authEdgePort, "authEdge port");
  const certificate = assertSafeAbsolutePath(config.certificatePath, "certificatePath");
  const certificateKey = assertSafeAbsolutePath(config.certificateKeyPath, "certificateKeyPath");
  if (!isValidServerName(config.serverName)) throw new Error("serverName is invalid");
  return [
    "upstream dsh_auth_edge {",
    `  server 127.0.0.1:${port};`,
    `  keepalive ${NGINX_KEEPALIVE_CONNECTIONS};`,
    "}",
    "",
    "server {",
    "  listen 80;",
    `  server_name ${config.serverName};`,
    "  return 301 https://$host$request_uri;",
    "}",
    "",
    "server {",
    "  listen 443 ssl;",
    `  server_name ${config.serverName};`,
    `  ssl_certificate ${certificate};`,
    `  ssl_certificate_key ${certificateKey};`,
    "",
    "  location / {",
    "    proxy_pass http://dsh_auth_edge;",
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto https;",
    "    proxy_set_header Upgrade $http_upgrade;",
    "    proxy_set_header Connection \"upgrade\";",
    "  }",
    "}",
    "",
  ].join("\n");
}

function validateSystemdConfig(config: SystemdUnitConfig): void {
  if (!/^[A-Za-z0-9 .:_-]+$/.test(config.description)) throw new Error("description is invalid");
  if (!/^[a-z0-9@_.-]+\.service$/.test(config.name)) throw new Error("unit name is invalid");
  assertSafeAbsolutePath(config.nodePath, "nodePath");
  assertSafeAbsolutePath(config.entrypoint, "entrypoint");
  assertSafeAbsolutePath(config.environmentFile, "environmentFile");
  assertSafeAbsolutePath(config.workingDirectory, "workingDirectory");
  if (config.writablePaths.length === 0) throw new Error("writablePaths must not be empty");
  config.writablePaths.forEach((value, index) => assertSafeAbsolutePath(value, `writablePaths[${index}]`));
  config.args.forEach((value, index) => assertSafeToken(value, `args[${index}]`));
  config.environment.forEach(assertSystemdEnvironment);
  [...config.after, ...config.requires].forEach(assertSystemdUnitToken);
}

const NON_SECRET_ENVIRONMENT = new Set([
  "AUTH_ADMIN_URL",
  "AUTH_ADMIN_WORKSPACE_ROOT",
  "AUTH_HOST",
  "AUTH_PAIRING_ENDPOINT",
  "AUTH_PORT",
  "AUTH_PUBLIC_ORIGIN",
  "AUTH_TRUSTED_ORIGINS",
  "AUTH_USER_WORKSPACE_ROOT",
  "DSH_SANDBOX_IMAGE",
  "DSH_WEB_INTERNAL_URL",
]);

function assertSystemdEnvironment(entry: SystemdEnvironmentOverride, index: number): void {
  if (!NON_SECRET_ENVIRONMENT.has(entry.name)) throw new Error(`environment name at ${index} is not allowed`);
  assertSafeToken(entry.value, `environment value at ${index}`);
}

function assertSystemdUnitToken(value: string): void {
  if (!/^[A-Za-z0-9@_.-]+$/.test(value)) throw new Error("systemd dependency unit is invalid");
}

function isValidServerName(value: string): boolean {
  if (value.length > 253 || !/^[A-Za-z0-9.-]+$/.test(value)) return false;
  return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
