/** 隔离 Chromium 验证真实构建的主题模块；不连接生产、不读取 .env。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { apply } from "../packages/ui/liquid-glass/lib/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = resolve(process.env.GLASS_RELEASE_ROOT || root);
const evidence = resolve(root, "docs/evidence/liquid-glass-theme");
const profile = await mkdtemp(join(tmpdir(), "mew-glass-browser-"));
const bundle = await build({
  entryPoints: [join(root, "packages/ui/liquid-glass/tests/browser-fixture.mjs")],
  bundle: true, write: false, outdir: profile, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
});
const assets = new Map(bundle.outputFiles.map((file) => [`/${file.path.endsWith(".css") ? "fixture.css" : "fixture.js"}`, file.contents]));
if (!assets.has("/fixture.css")) assets.set("/fixture.css", "");
for (const [url, path] of [
  ["/theme.js", "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"],
  ["/renderer.js", "node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js"],
  ["/glass.js", "packages/ui/liquid-glass/client.js"],
]) assets.set(url, await readFile(join(releaseRoot, path)));
let html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>液态玻璃隔离验收</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--dsw-alias-bg-base,#f1f4f3);font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/fixture.js"></script><script src="/theme.js"></script><script src="/renderer.js"></script><script src="/glass.js"></script><script>bootGlassFixture().catch(error=>{console.error(error);document.body.dataset.bootError=error.message})</script></body></html>';
apply({ effect: (fn) => fn(), webServer: { tapIndex: (fn) => { html = fn(html); return () => {}; } } });
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  if (path === "/auth/me") {
    const account = new URL(req.headers.referer || "http://fixture").searchParams.get("account") || "alice";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: { id: account } })); return;
  }
  const asset = path === "/" ? html : assets.get(path);
  if (asset === undefined) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", path === "/" ? "text/html; charset=utf-8" : path.endsWith(".css") ? "text/css" : "text/javascript");
  res.end(asset);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = spawn(process.env.CHROMIUM_PATH || "/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
let socket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
try {
  let port;
  for (let retry = 0; retry < 100; retry++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; await pause(100); }
  }
  assert.ok(port, "Chromium 未启动");
  const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let retry = 0; retry < 70; retry++) { if (await evaluate(expression)) return; await pause(100); }
    throw new Error(`浏览器断言超时: ${expression}\n${JSON.stringify(errors)}`);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await waitFor('Boolean(window.glassFixture && document.querySelector("[data-refraction=on]"))');
  await mkdir(evidence, { recursive: true });
  const capture = async (name) => {
    await pause(250);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(evidence, `${name}.png`), Buffer.from(data, "base64"));
  };
  const transcript = [];
  transcript.push(await evaluate('document.querySelector(".mew-glass-page").innerText'));
  assert.equal(transcript[0].trim(), (await readFile(join(root, "packages/ui/liquid-glass/tests/appearance.snapshot.txt"), "utf8")).trim(), "真实浏览器文案快照变化");
  assert.equal(await evaluate('glassFixture.snapshot().active.tokens["--dsw-alias-bg-base"]'), "rgb(242 242 244 / 28%)");
  const lightWallpaper = await evaluate('getComputedStyle(document.body).backgroundImage');
  await evaluate('window.titleProbe=document.createElement("header");titleProbe.innerHTML="<nav aria-label=会话层级><button disabled>你好</button></nav>";document.body.appendChild(titleProbe)');
  assert.equal(await evaluate('getComputedStyle(titleProbe.firstChild).backgroundColor'), "rgba(0, 0, 0, 0)");
  assert.equal(await evaluate('getComputedStyle(titleProbe.firstChild).boxShadow'), "none");
  assert.equal(await evaluate('getComputedStyle(titleProbe.firstChild).backdropFilter'), "none");
  await evaluate('titleProbe.remove()');
  assert.ok(lightWallpaper.includes("data:image/svg+xml"), "浅色SVG背景未挂载");
  await evaluate('window.surfaceProbe=document.createElement("div");surfaceProbe.setAttribute("role","dialog");surfaceProbe.textContent="语义浮层";document.body.appendChild(surfaceProbe)');
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).backdropFilter'), "blur(22px) saturate(1.35)");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).borderRadius'), "24px");
  await evaluate('surfaceProbe.setAttribute("role","menu");surfaceProbe.innerHTML="<button role=menuitem>第一项</button><button role=menuitem>第二项</button>"');
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).padding'), "8px");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe.lastChild).marginTop'), "4px");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe.lastChild).boxShadow'), "none");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe.lastChild).borderRadius'), "10px");
  await evaluate('surfaceProbe.remove()');
  await evaluate('surfaceProbe.setAttribute("role","tablist");surfaceProbe.innerHTML="<button role=tab aria-selected=true>对话</button><button role=tab aria-selected=false>轨迹</button><button role=tab aria-selected=false>上下文</button>";document.body.appendChild(surfaceProbe)');
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).padding'), "0px");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).borderRadius'), "0px");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).backgroundColor'), "rgba(0, 0, 0, 0)");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe).backdropFilter'), "none");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe.firstChild).paddingLeft'), "14px");
  assert.ok(await evaluate('surfaceProbe.getBoundingClientRect().width < 400'), "分段栏被拉成整行");
  assert.ok(await evaluate('surfaceProbe.children[1].getBoundingClientRect().left-surfaceProbe.children[0].getBoundingClientRect().right>=4'), "标签挤在一起");
  assert.equal(await evaluate('getComputedStyle(surfaceProbe.firstChild).backgroundColor'), "rgba(0, 0, 0, 0)");
  assert.notEqual(await evaluate('getComputedStyle(surfaceProbe.firstChild).borderBottomColor'), await evaluate('getComputedStyle(surfaceProbe.lastChild).borderBottomColor'));
  await evaluate('surfaceProbe.scrollIntoView({block:"center"})');
  await capture("tabs");
  await evaluate('surfaceProbe.style.maxWidth="150px"');
  assert.ok(await evaluate('surfaceProbe.scrollWidth>surfaceProbe.clientWidth && getComputedStyle(surfaceProbe).overflowX==="auto"'), "窄标签栏不能内部滚动");
  await evaluate('surfaceProbe.setAttribute("aria-orientation","vertical")');
  assert.notEqual(await evaluate('getComputedStyle(surfaceProbe).display'), "flex", "竖向标签受到横向布局覆盖");
  await evaluate('surfaceProbe.remove()');
  await evaluate('scrollTo(0,0)');
  await capture("light");
  await evaluate('glassFixture.setTheme("dark")');
  await waitFor('document.querySelector(".mew-glass-page").dataset.scheme === "dark"');
  assert.equal(await evaluate('glassFixture.snapshot().active.tokens["--dsw-alias-bg-base"]'), "rgb(25 25 29 / 28%)");
  assert.notEqual(await evaluate('getComputedStyle(document.body).backgroundImage'), lightWallpaper, "暗色背景未切换");
  await capture("dark");
  await evaluate('glassFixture.setTheme("system")');
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitFor('document.querySelector(".mew-glass-page").dataset.scheme === "light"');
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await waitFor('document.querySelector(".mew-glass-page").dataset.scheme === "dark"');
  await evaluate('glassFixture.setTheme("dark")');
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await pause(250);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), "窄屏横向溢出");
  assert.ok(await evaluate('(()=>{const r=document.querySelector("button").getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.height>=40})()'), "按钮不可见或触摸尺寸不足");
  await capture("mobile");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await waitFor('Boolean(document.querySelector("[data-refraction=off]"))');
  assert.equal(await evaluate('document.querySelectorAll(".mew-glass-optics svg").length'), 0);
  await capture("reduced-motion");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await waitFor('Boolean(document.querySelector("[data-refraction=off]"))');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".mew-glass-card")).backdropFilter'), "none");
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundImage'), "none");
  await waitFor('glassFixture.snapshot().active.tokens["--dsw-alias-bg-base"] === "#19191d"');
  // 实际 CDP 鼠标点击，不用直接调用组件处理器来替代交互。
  const point = await evaluate('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  await waitFor('document.querySelector("button").getAttribute("aria-checked") === "false"');
  assert.equal(await evaluate('Object.keys(glassFixture.snapshot().active.tokens).length'), 0);
  assert.equal(await evaluate('document.documentElement.hasAttribute("data-mew-glass")'), false);
  assert.equal(await evaluate('localStorage.getItem("mewclaw.liquid-glass.v1.alice")'), "off");
  await send("Page.reload");
  await waitFor('Boolean(window.glassFixture && document.querySelector("button") && !document.querySelector("button").disabled)');
  assert.equal(await evaluate('document.querySelector("button").getAttribute("aria-checked")'), "false", "刷新后开关未保留");
  await evaluate('glassFixture.setTheme("dark")');
  // Tab 键仍能聚焦主题按钮；焦点不得被滤镜层遮挡。
  await evaluate('document.activeElement.blur()');
  await evaluate('document.body.focus()');
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  // 从文档末端可能先返回浏览器导航栏，再按一次进入唯一的页面控件。
  if (!await evaluate('document.activeElement.tagName === "BUTTON"')) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }
  assert.ok(await evaluate('document.activeElement.tagName === "BUTTON" && getComputedStyle(document.activeElement).outlineStyle !== "none"'), "键盘焦点不可见");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor('document.querySelector("button").getAttribute("aria-checked") === "true"');
  await send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  await capture("forced-colors");
  await evaluate('glassFixture.unload()');
  await waitFor('!document.querySelector(".mew-glass-page")');
  assert.equal(await evaluate('document.querySelectorAll("style[data-mewclaw-liquid-glass]").length'), 0);
  assert.equal(await evaluate('document.documentElement.hasAttribute("data-mew-glass-scheme")'), false);
  assert.equal(await evaluate('Object.keys(glassFixture.snapshot().active.tokens).length'), 0);
  await evaluate('window.savedGlassConfig=document.getElementById("mewclaw-liquid-glass-config");savedGlassConfig.remove();glassFixture.mount()');
  assert.equal(await evaluate('document.querySelectorAll("style[data-mewclaw-liquid-glass]").length'), 0);
  await evaluate('glassFixture.unload()');
  await evaluate('document.head.appendChild(savedGlassConfig);window.savedGlassText=savedGlassConfig.textContent;savedGlassConfig.textContent="{\\"enabled\\":false}";glassFixture.mount()');
  assert.equal(await evaluate('document.querySelectorAll("style[data-mewclaw-liquid-glass]").length'), 0);
  await evaluate('glassFixture.unload()');
  await evaluate('savedGlassConfig.textContent=savedGlassText');
  await evaluate('glassFixture.addBaseLayer()');
  for (let i = 0; i < 3; i++) {
    await evaluate('glassFixture.mount()');
    await waitFor('Boolean(document.querySelector("button") && !document.querySelector("button").disabled)');
    assert.equal(await evaluate('document.querySelectorAll("style[data-mewclaw-liquid-glass]").length'), 1);
    await evaluate('glassFixture.unload()');
    assert.equal(await evaluate('glassFixture.snapshot().active.tokens["--dsw-alias-bg-base"]'), "#121212", "卸载未恢复下层主题");
    assert.equal(await evaluate('glassFixture.snapshot().preference'), "dark", "插件改变了官方主题偏好");
  }
  await evaluate('localStorage.setItem("mewclaw.liquid-glass.v1.alice","off")');
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?account=bob` });
  await waitFor('Boolean(document.querySelector("button") && !document.querySelector("button").disabled)');
  assert.equal(await evaluate('document.querySelector("button").getAttribute("aria-checked")'), "true", "新账号继承了其他账号的开关");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?account=alice` });
  await waitFor('Boolean(document.querySelector("button") && !document.querySelector("button").disabled)');
  assert.equal(await evaluate('document.querySelector("button").getAttribute("aria-checked")'), "false");
  await evaluate('glassFixture.finish()');
  assert.deepEqual(errors, [], "浏览器运行错误");
  await writeFile(join(evidence, "transcript.txt"), transcript.join("\n") + "\n");
  console.log(JSON.stringify({ status: "GLASS_BROWSER_VERIFIED", releaseRoot, viewports: [1000, 360], schemes: ["light", "dark", "system"], reducedMotion: true, reducedTransparency: true, forcedColors: true, keyboard: true, disabledConfig: true, persistedAfterReload: true, accountIsolation: true, unloadReload: 3, runtimeErrors: errors.length, evidence, profile }, null, 2));
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
}
