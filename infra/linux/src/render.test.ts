import { describe, expect, it } from "vitest";

import { renderNginxOverlay, renderSystemdUnit, rewriteNginxLoopbackProxyPasses } from "./render.js";

describe("systemd unit rendering", () => {
  it("renders a hardened non-root service without shell interpolation", () => {
    expect(
      renderSystemdUnit({
        after: ["network-online.target", "dsh-postgresql.service"],
        args: ["--patch", "apps/lark-worker/oci.overlay.yml"],
        description: "DSH Worker",
        entrypoint: "/opt/dsh/current/apps/lark-worker/dist/main.js",
        environment: [
          { name: "DSH_SANDBOX_IMAGE", value: "localhost/dsh-sandbox@sha256:abc123" },
        ],
        environmentFile: "/etc/dsh/dsh.env",
        name: "dsh-worker.service",
        nodePath: "/usr/bin/node",
        requires: ["dsh-podman-ready.service"],
        workingDirectory: "/opt/dsh/current",
        writablePaths: ["/var/lib/dsh"],
      }),
    ).toMatchInlineSnapshot(`
      "[Unit]
      Description=DSH Worker
      After=network-online.target dsh-postgresql.service
      Requires=dsh-podman-ready.service

      [Service]
      Type=simple
      User=dsh
      Group=dsh
      WorkingDirectory=/opt/dsh/current
      EnvironmentFile=/etc/dsh/dsh.env
      Environment=DSH_SANDBOX_IMAGE=localhost/dsh-sandbox@sha256:abc123
      ExecStart=/usr/bin/node /opt/dsh/current/apps/lark-worker/dist/main.js --patch apps/lark-worker/oci.overlay.yml
      Restart=on-failure
      RestartSec=5s
      TimeoutStopSec=30s
      KillSignal=SIGTERM
      NoNewPrivileges=true
      PrivateTmp=true
      ProtectHome=true
      ProtectSystem=strict
      ReadWritePaths=/var/lib/dsh
      UMask=0077

      [Install]
      WantedBy=multi-user.target
      "
    `);
  });

  it("rejects directives and shell controls in caller-provided fields", () => {
    const base = {
      after: ["network-online.target"],
      args: [] as string[],
      description: "DSH Auth",
      entrypoint: "/opt/dsh/current/apps/auth/dist/main.js",
      environment: [] as Array<{ name: string; value: string }>,
      environmentFile: "/etc/dsh/dsh.env",
      name: "dsh-auth.service",
      nodePath: "/usr/bin/node",
      requires: [] as string[],
      workingDirectory: "/opt/dsh/current",
      writablePaths: ["/var/lib/dsh"],
    };

    expect(() => renderSystemdUnit({ ...base, description: "unsafe\nExecStart=/bin/sh" })).toThrow(/description/);
    expect(() => renderSystemdUnit({ ...base, args: ["$(touch /tmp/escape)"] })).toThrow(/argument/);
    expect(() => renderSystemdUnit({
      ...base,
      environment: [{ name: "DATABASE_URL", value: "postgres://inline-secret" }],
    })).toThrow(/environment name/);
  });
});

describe("Nginx overlay rendering", () => {
  it("rewrites exactly both live vhost proxy_pass directives", () => {
    const source = [
      "server {",
      "  location / {",
      "    proxy_pass http://127.0.0.1:8787;",
      "  }",
      "  location /socket.io {",
      "    proxy_pass http://127.0.0.1:8787;",
      "  }",
      "}",
    ].join("\n");

    const candidate = rewriteNginxLoopbackProxyPasses(source, 8787, 13080);

    expect(candidate).not.toContain("127.0.0.1:8787");
    expect(candidate.match(/proxy_pass http:\/\/127\.0\.0\.1:13080;/g)).toHaveLength(2);
    expect(() => rewriteNginxLoopbackProxyPasses(source.replace(/\n  location \/socket[\s\S]+/, ""), 8787, 13080)).toThrow(
      /exactly 2/,
    );
  });

  it("routes HTTP and WebSocket traffic only to Auth Edge", () => {
    expect(
      renderNginxOverlay({
        authEdgePort: 13080,
        certificateKeyPath: "/etc/letsencrypt/live/chat.example/privkey.pem",
        certificatePath: "/etc/letsencrypt/live/chat.example/fullchain.pem",
        serverName: "chat.example",
      }),
    ).toMatchInlineSnapshot(`
      "upstream dsh_auth_edge {
        server 127.0.0.1:13080;
        keepalive 32;
      }

      server {
        listen 80;
        server_name chat.example;
        return 301 https://$host$request_uri;
      }

      server {
        listen 443 ssl;
        server_name chat.example;
        ssl_certificate /etc/letsencrypt/live/chat.example/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/chat.example/privkey.pem;

        location / {
          proxy_pass http://dsh_auth_edge;
          proxy_http_version 1.1;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto https;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection \"upgrade\";
        }
      }
      "
    `);
  });

  it("rejects Nginx directive injection and invalid ports", () => {
    const base = {
      authEdgePort: 13080,
      certificateKeyPath: "/etc/dsh/key.pem",
      certificatePath: "/etc/dsh/cert.pem",
      serverName: "chat.example",
    };

    expect(() => renderNginxOverlay({ ...base, serverName: "chat.example; include /tmp/x" })).toThrow(/serverName/);
    expect(() => renderNginxOverlay({ ...base, authEdgePort: 0 })).toThrow(/port/);
  });
});
