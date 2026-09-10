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
      useState<T>(initializer: () => T): [T, (value: T) => void] {
        return [initializer(), () => undefined];
      },
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
      type: "span",
      props: {
        className: "mewclaw-hero-brand",
      },
      children: [expect.objectContaining({ type: "svg", props: expect.objectContaining({ width: 46, height: 46 }) }), expect.objectContaining({ type: "span" })],
    });
    expect(JSON.stringify(registrations[0]!.component({ size: 34 }))).toMatch(/该做点什么呢~ Mew|灵感正伸着懒腰|把难题交给猫爪|今天也要聪明一点/u);
    expect((registrations[0]!.component({ size: 34 }) as { children: unknown[] }).children).toHaveLength(2);

    injected[1]!.callback();
    expect(registrations[1]!.component({ size: 20, className: "official-sidebar-mark" })).toMatchObject({
      type: "svg",
      props: {
        width: 24,
        height: 24,
        className: "official-sidebar-mark mewclaw-sidebar-mark mewclaw-brand-mark",
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
