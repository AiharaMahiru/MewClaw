/** worker HTTP 面：窄路由、Bearer 鉴权、NDJSON 运行流与控制端点。 */
import { createServer } from "node:http";

import { RunHttpHandler } from "./http-handler.js";
import type { RunServer, RunServerOptions } from "./http-types.js";

export type { NdjsonWriter, RunServer, RunServerOptions } from "./http-types.js";

/** 创建监听中的 HTTP server（端口绑定完成才 resolve）。 */
export function createRunServer(options: RunServerOptions): Promise<RunServer> {
  const handler = new RunHttpHandler(options);
  const server = createServer((request, response) => {
    void handler.handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        server,
        url: `http://${options.host}:${port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
