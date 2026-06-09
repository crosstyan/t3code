import {
  Dispatcher,
  EnvHttpProxyAgent,
  Socks5ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

export const DEFAULT_LOCAL_PROXY_PORT = 7890;
export const DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1";
export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

const PROXY_URL_ENV_NAMES = ["T3CODE_PROXY_URL", "T3CODE_PROXY"] as const;
const HTTP_PROXY_ENV_NAMES = ["http_proxy", "HTTP_PROXY"] as const;
const HTTPS_PROXY_ENV_NAMES = ["https_proxy", "HTTPS_PROXY"] as const;
const ALL_PROXY_ENV_NAMES = ["all_proxy", "ALL_PROXY"] as const;
const NO_PROXY_ENV_NAMES = ["no_proxy", "NO_PROXY"] as const;

type ProxyProtocol = "http" | "https" | "socks" | "socks5";
type ProxyDispatcherKind = "env-http" | "socks5";

export interface ProxyRuntimeConfig {
  readonly dispatcherKind: ProxyDispatcherKind;
  readonly proxyUrl: string;
  readonly source: string;
  readonly noProxy: string;
}

export interface ProxyEnvironmentResolution {
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeConfig: ProxyRuntimeConfig | undefined;
}

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const firstNonEmptyEnv = (
  env: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
): { readonly name: string; readonly value: string } | undefined => {
  for (const name of names) {
    const value = trimNonEmpty(env[name]);
    if (value !== undefined) return { name, value };
  }
  return undefined;
};

const isProxyProtocol = (protocol: string): protocol is `${ProxyProtocol}:` =>
  protocol === "http:" || protocol === "https:" || protocol === "socks:" || protocol === "socks5:";

const protocolName = (url: string): ProxyProtocol => {
  const protocol = new URL(url).protocol;
  if (!isProxyProtocol(protocol)) {
    throw new Error(`Unsupported proxy protocol '${protocol}'.`);
  }
  return protocol.slice(0, -1) as ProxyProtocol;
};

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

const serializeProxyUrl = (url: URL): string => {
  const href = url.href;
  return url.pathname === "/" && url.search.length === 0 && url.hash.length === 0
    ? href.slice(0, -1)
    : href;
};

export function normalizeProxyUrl(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error("Proxy URL cannot be empty.");
  }

  const normalized =
    /^\d+$/.test(value) || value.startsWith(":")
      ? `http://${DEFAULT_LOCAL_PROXY_HOST}${value.startsWith(":") ? value : `:${value}`}`
      : hasScheme(value)
        ? value
        : `http://${value}`;

  const url = new URL(normalized);
  if (!isProxyProtocol(url.protocol)) {
    throw new Error(
      `Unsupported proxy protocol '${url.protocol}'. Use http://, https://, socks://, or socks5://.`,
    );
  }
  return serializeProxyUrl(url);
}

const setProxyEnvPair = (
  env: NodeJS.ProcessEnv,
  lowerName: string,
  upperName: string,
  value: string,
) => {
  env[lowerName] = value;
  env[upperName] = value;
};

const setNoProxyDefault = (env: NodeJS.ProcessEnv) => {
  const existing = firstNonEmptyEnv(env, NO_PROXY_ENV_NAMES);
  const noProxy = existing?.value ?? DEFAULT_NO_PROXY;
  setProxyEnvPair(env, "no_proxy", "NO_PROXY", noProxy);
  return noProxy;
};

const isSocksProxyUrl = (proxyUrl: string): boolean => {
  const protocol = protocolName(proxyUrl);
  return protocol === "socks" || protocol === "socks5";
};

const normalizeNoProxyHost = (value: string): string =>
  value.replace(/^\[(.*)\]$/, "$1").toLowerCase();

const splitHostPort = (
  value: string,
): { readonly host: string; readonly port: string | undefined } => {
  if (value.startsWith("[") && value.includes("]")) {
    const bracketIndex = value.indexOf("]");
    const host = value.slice(1, bracketIndex);
    const port = value[bracketIndex + 1] === ":" ? value.slice(bracketIndex + 2) : undefined;
    return { host: normalizeNoProxyHost(host), port };
  }

  const colonIndex = value.lastIndexOf(":");
  if (colonIndex > -1 && value.indexOf(":") === colonIndex) {
    return {
      host: normalizeNoProxyHost(value.slice(0, colonIndex)),
      port: value.slice(colonIndex + 1),
    };
  }

  return { host: normalizeNoProxyHost(value), port: undefined };
};

export function shouldBypassProxy(origin: string | URL | undefined, noProxy: string): boolean {
  if (origin === undefined) return false;

  const originUrl = typeof origin === "string" ? new URL(origin) : origin;
  const originHost = normalizeNoProxyHost(originUrl.hostname);
  const originPort =
    originUrl.port ||
    (originUrl.protocol === "https:" ? "443" : originUrl.protocol === "http:" ? "80" : undefined);
  const entries = noProxy
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (entry === "*") return true;

    const { host: rawHost, port } = splitHostPort(entry);
    if (port !== undefined && port !== originPort) continue;

    const host = rawHost.startsWith("*") ? rawHost.slice(1) : rawHost;
    if (host.length === 0) continue;
    if (originHost === host) return true;
    if (host.startsWith(".") && originHost.endsWith(host)) return true;
  }

  return false;
}

class NoProxyDispatcher extends Dispatcher {
  private readonly proxyDispatcher: Dispatcher;
  private readonly directDispatcher: Dispatcher;
  private readonly noProxy: string;

  constructor(proxyDispatcher: Dispatcher, directDispatcher: Dispatcher, noProxy: string) {
    super();
    this.proxyDispatcher = proxyDispatcher;
    this.directDispatcher = directDispatcher;
    this.noProxy = noProxy;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const dispatcher = shouldBypassProxy(options.origin, this.noProxy)
      ? this.directDispatcher
      : this.proxyDispatcher;
    return dispatcher.dispatch(options, handler);
  }

  override close(callback: () => void): void;
  override close(): Promise<void>;
  override close(callback?: () => void): void | Promise<void> {
    if (callback) {
      this.proxyDispatcher.close(callback);
      return;
    }
    return this.proxyDispatcher.close();
  }

  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(error?: Error | null): Promise<void>;
  override destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void) {
    if (typeof errorOrCallback === "function") {
      this.proxyDispatcher.destroy(errorOrCallback);
      return;
    }
    if (callback) {
      this.proxyDispatcher.destroy(errorOrCallback ?? null, callback);
      return;
    }
    return errorOrCallback !== undefined
      ? this.proxyDispatcher.destroy(errorOrCallback)
      : this.proxyDispatcher.destroy();
  }
}

const findExplicitT3Proxy = (env: NodeJS.ProcessEnv) => {
  const configured = firstNonEmptyEnv(env, PROXY_URL_ENV_NAMES);
  if (configured === undefined) return undefined;
  return {
    source: configured.name,
    proxyUrl: normalizeProxyUrl(configured.value),
  };
};

const applyExplicitProxyEnvironment = (
  env: NodeJS.ProcessEnv,
  proxyUrl: string,
): ProxyRuntimeConfig => {
  setProxyEnvPair(env, "all_proxy", "ALL_PROXY", proxyUrl);
  setProxyEnvPair(env, "http_proxy", "HTTP_PROXY", proxyUrl);
  setProxyEnvPair(env, "https_proxy", "HTTPS_PROXY", proxyUrl);
  const noProxy = setNoProxyDefault(env);
  return {
    dispatcherKind: isSocksProxyUrl(proxyUrl) ? "socks5" : "env-http",
    proxyUrl,
    source: "T3CODE_PROXY_URL",
    noProxy,
  };
};

const fillHttpProxyDefaults = (env: NodeJS.ProcessEnv) => {
  const httpProxy = firstNonEmptyEnv(env, HTTP_PROXY_ENV_NAMES);
  const httpsProxy = firstNonEmptyEnv(env, HTTPS_PROXY_ENV_NAMES);
  const allProxy = firstNonEmptyEnv(env, ALL_PROXY_ENV_NAMES);

  if (allProxy) {
    setProxyEnvPair(env, "all_proxy", "ALL_PROXY", normalizeProxyUrl(allProxy.value));
  }

  if (httpProxy) {
    setProxyEnvPair(env, "http_proxy", "HTTP_PROXY", normalizeProxyUrl(httpProxy.value));
  }

  if (httpsProxy) {
    setProxyEnvPair(env, "https_proxy", "HTTPS_PROXY", normalizeProxyUrl(httpsProxy.value));
  }

  if (httpProxy && !httpsProxy) {
    setProxyEnvPair(env, "https_proxy", "HTTPS_PROXY", normalizeProxyUrl(httpProxy.value));
  }

  if (
    !httpProxy &&
    !httpsProxy &&
    allProxy &&
    !isSocksProxyUrl(normalizeProxyUrl(allProxy.value))
  ) {
    const proxyUrl = normalizeProxyUrl(allProxy.value);
    setProxyEnvPair(env, "http_proxy", "HTTP_PROXY", proxyUrl);
    setProxyEnvPair(env, "https_proxy", "HTTPS_PROXY", proxyUrl);
  }
};

const resolveRuntimeProxyConfig = (env: NodeJS.ProcessEnv): ProxyRuntimeConfig | undefined => {
  const socksCandidate =
    firstNonEmptyEnv(env, ALL_PROXY_ENV_NAMES) ??
    firstNonEmptyEnv(env, HTTPS_PROXY_ENV_NAMES) ??
    firstNonEmptyEnv(env, HTTP_PROXY_ENV_NAMES);
  if (socksCandidate !== undefined) {
    const proxyUrl = normalizeProxyUrl(socksCandidate.value);
    if (isSocksProxyUrl(proxyUrl)) {
      return {
        dispatcherKind: "socks5",
        proxyUrl,
        source: socksCandidate.name,
        noProxy: setNoProxyDefault(env),
      };
    }
  }

  const httpProxy =
    firstNonEmptyEnv(env, HTTP_PROXY_ENV_NAMES) ?? firstNonEmptyEnv(env, HTTPS_PROXY_ENV_NAMES);
  if (httpProxy === undefined) return undefined;

  return {
    dispatcherKind: "env-http",
    proxyUrl: normalizeProxyUrl(httpProxy.value),
    source: httpProxy.name,
    noProxy: setNoProxyDefault(env),
  };
};

export function resolveProxyEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): ProxyEnvironmentResolution {
  const environment = { ...baseEnv };
  const explicitProxy = findExplicitT3Proxy(environment);
  if (explicitProxy !== undefined) {
    const runtimeConfig = applyExplicitProxyEnvironment(environment, explicitProxy.proxyUrl);
    return {
      enabled: true,
      environment,
      runtimeConfig: { ...runtimeConfig, source: explicitProxy.source },
    };
  }

  fillHttpProxyDefaults(environment);
  const runtimeConfig = resolveRuntimeProxyConfig(environment);
  return {
    enabled: runtimeConfig !== undefined,
    environment,
    runtimeConfig,
  };
}

function applyResolvedProxyEnvironment(target: NodeJS.ProcessEnv, resolved: NodeJS.ProcessEnv) {
  for (const name of [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    const value = resolved[name];
    if (value !== undefined) {
      target[name] = value;
    }
  }
}

export function makeProxyDispatcher(
  config: ProxyRuntimeConfig,
  directDispatcher: Dispatcher = getGlobalDispatcher(),
): Dispatcher {
  if (config.dispatcherKind === "socks5") {
    return new NoProxyDispatcher(
      new Socks5ProxyAgent(config.proxyUrl),
      directDispatcher,
      config.noProxy,
    );
  }
  return new EnvHttpProxyAgent({ noProxy: config.noProxy });
}

export function installProxySupport(
  env: NodeJS.ProcessEnv = process.env,
): ProxyRuntimeConfig | undefined {
  const resolution = resolveProxyEnvironment(env);
  applyResolvedProxyEnvironment(env, resolution.environment);
  const config = resolution.runtimeConfig;
  if (config === undefined) return undefined;
  setGlobalDispatcher(makeProxyDispatcher(config, getGlobalDispatcher()));
  return config;
}
