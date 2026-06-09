import { assert, it } from "@effect/vitest";

import {
  DEFAULT_NO_PROXY,
  normalizeProxyUrl,
  resolveProxyEnvironment,
  shouldBypassProxy,
} from "./proxy.ts";

it("normalizes localhost proxy port shorthand", () => {
  assert.equal(normalizeProxyUrl("7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl(":7890"), "http://127.0.0.1:7890");
});

it("resolves explicit HTTP proxy config for server fetch and child processes", () => {
  const resolved = resolveProxyEnvironment({
    T3CODE_PROXY_URL: "http://127.0.0.1:7890",
  });

  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.runtimeConfig, {
    dispatcherKind: "env-http",
    proxyUrl: "http://127.0.0.1:7890",
    source: "T3CODE_PROXY_URL",
    noProxy: DEFAULT_NO_PROXY,
  });
  assert.equal(resolved.environment.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(resolved.environment.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(resolved.environment.ALL_PROXY, "http://127.0.0.1:7890");
  assert.equal(resolved.environment.NO_PROXY, DEFAULT_NO_PROXY);
});

it("resolves explicit SOCKS5 proxy config for server fetch and child processes", () => {
  const resolved = resolveProxyEnvironment({
    T3CODE_PROXY_URL: "socks5://127.0.0.1:7890",
  });

  assert.equal(resolved.runtimeConfig?.dispatcherKind, "socks5");
  assert.equal(resolved.runtimeConfig?.proxyUrl, "socks5://127.0.0.1:7890");
  assert.equal(resolved.environment.HTTP_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(resolved.environment.HTTPS_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(resolved.environment.ALL_PROXY, "socks5://127.0.0.1:7890");
});

it("uses standard HTTP_PROXY and fills HTTPS_PROXY for provider child processes", () => {
  const resolved = resolveProxyEnvironment({
    HTTP_PROXY: "proxy.example.test:8080",
  });

  assert.equal(resolved.runtimeConfig?.dispatcherKind, "env-http");
  assert.equal(resolved.runtimeConfig?.proxyUrl, "http://proxy.example.test:8080");
  assert.equal(resolved.environment.HTTP_PROXY, "http://proxy.example.test:8080");
  assert.equal(resolved.environment.HTTPS_PROXY, "http://proxy.example.test:8080");
  assert.equal(resolved.environment.NO_PROXY, DEFAULT_NO_PROXY);
});

it("uses ALL_PROXY for SOCKS5-only environments", () => {
  const resolved = resolveProxyEnvironment({
    ALL_PROXY: "socks5://127.0.0.1:7890",
  });

  assert.equal(resolved.runtimeConfig?.dispatcherKind, "socks5");
  assert.equal(resolved.runtimeConfig?.proxyUrl, "socks5://127.0.0.1:7890");
  assert.equal(resolved.environment.ALL_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(resolved.environment.HTTP_PROXY, undefined);
  assert.equal(resolved.environment.HTTPS_PROXY, undefined);
});

it("matches no_proxy hosts for SOCKS5 bypass dispatching", () => {
  assert.equal(shouldBypassProxy("http://localhost:3000", DEFAULT_NO_PROXY), true);
  assert.equal(shouldBypassProxy("http://127.0.0.1:3000", DEFAULT_NO_PROXY), true);
  assert.equal(shouldBypassProxy("http://[::1]:3000", DEFAULT_NO_PROXY), true);
  assert.equal(shouldBypassProxy("https://api.openai.com", DEFAULT_NO_PROXY), false);
  assert.equal(shouldBypassProxy("https://api.example.test", "*.example.test"), true);
  assert.equal(shouldBypassProxy("https://api.example.test:443", "api.example.test:443"), true);
  assert.equal(shouldBypassProxy("https://api.example.test:8443", "api.example.test:443"), false);
});

it("leaves the environment unchanged when no proxy is configured", () => {
  const resolved = resolveProxyEnvironment({ PATH: "/bin" });

  assert.equal(resolved.enabled, false);
  assert.equal(resolved.runtimeConfig, undefined);
  assert.deepEqual(resolved.environment, { PATH: "/bin" });
});
