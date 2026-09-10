import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteRegistrar {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void;
  }): () => void;
}

export type ProtectedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  handler: () => Promise<void>,
) => Promise<void>;
