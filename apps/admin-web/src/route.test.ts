import { describe, expect, it } from "vitest";

import { pathForRoute, routeFromPath } from "./route.js";

describe("admin-web routes", () => {
  it("uses dashboard as the default and accepts the management paths", () => {
    expect(routeFromPath("/admin")).toBe("dashboard");
    expect(routeFromPath("/admin/conversations")).toBe("conversations");
    expect(routeFromPath("/admin/knowledge/")).toBe("knowledge");
    expect(routeFromPath("/admin/users")).toBe("users");
    expect(routeFromPath("/admin/sessions")).toBe("sessions");
    expect(routeFromPath("/admin/billing")).toBe("billing");
  });

  it("keeps deep links and browser history paths stable", () => {
    expect(pathForRoute("dashboard")).toBe("/admin");
    expect(pathForRoute("conversations")).toBe("/admin/conversations");
    expect(pathForRoute("knowledge")).toBe("/admin/knowledge");
    expect(pathForRoute("users")).toBe("/admin/users");
    expect(pathForRoute("sessions")).toBe("/admin/sessions");
    expect(pathForRoute("billing")).toBe("/admin/billing");
  });
});
