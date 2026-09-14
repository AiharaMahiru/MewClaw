import { createServer, type Server } from "node:http";

// 本机临时端口段与 WHATWG fetch bad-port 清单重叠（如 5060/6665-6669/10080）；
// 随机命中时 Node fetch 按规范直接拒绝连接，绑定后必须复核端口。
const BLOCKED_FETCH_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export async function bindAllowedPort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    if (!BLOCKED_FETCH_PORTS.has(address.port)) return address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error("test server could not bind an allowed port");
}

export async function allowedEphemeralPort(): Promise<number> {
  const probe = createServer();
  try {
    return await bindAllowedPort(probe);
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

export async function listenAllowedEdge(
  edge: { listen(): Promise<void>; server: Server },
  config: { port: number },
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    config.port = await allowedEphemeralPort();
    try {
      await edge.listen();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw error;
    }
    const address = edge.server.address();
    if (!address || typeof address === "string") throw new Error("edge test server did not bind");
    return address.port;
  }
  throw new Error("edge test server could not bind an allowed port");
}
