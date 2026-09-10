import { describe, expect, it } from "vitest";

import { applyBrand } from "./client.js";

type Registration = {
  options: { name: string };
  component: (props: { size: number; className?: string }) => unknown;
};

describe("MewClaw 会话首屏品牌槽位", () => {
  it("等待官方 conversation 槽位声明后再注册占位者", () => {
    const registrations: Registration[] = [];
    const injected: Array<{ name: string; callback: () => () => void }> = [];
    const fakeContext = {
      slots: {
        inject(name: string, callback: () => () => void): () => void {
          injected.push({ name, callback });
          return () => undefined;
        },
        register(options: { name: string }, component: Registration["component"]): () => void {
          registrations.push({ options, component });
          return () => undefined;
        },
      },
    } as never;
    const fakeReact = {
      createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]) {
        return { type, props, children };
      },
    };

    applyBrand(fakeContext, fakeReact);

    expect(injected.map(({ name }) => name)).toEqual([
      "conversation.hero.brand.mark",
      "sidebar.brand.mark",
      "sidebar.brand.name",
    ]);
    expect(registrations).toHaveLength(0);

    injected[0]!.callback();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.options).toEqual({ name: "conversation.hero.brand.mark" });
    expect(registrations[0]!.component({ size: 34, className: "official-hero-mark" })).toMatchObject({
      type: "svg",
      props: {
        width: 34,
        height: 34,
        className: "official-hero-mark mewclaw-hero-mark",
      },
    });

    injected[1]!.callback();
    expect(registrations[1]!.component({ size: 20, className: "official-sidebar-mark" })).toMatchObject({
      type: "svg",
      props: {
        width: 20,
        height: 20,
        className: "official-sidebar-mark mewclaw-sidebar-mark",
      },
    });
    injected[2]!.callback();
    expect(registrations.map(({ options }) => options.name)).toEqual([
      "conversation.hero.brand.mark",
      "sidebar.brand.mark",
      "sidebar.brand.name",
    ]);
  });
});
