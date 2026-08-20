import { isIP } from "node:net";

export interface NatsTlsOptions {
  handshakeFirst?: boolean;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  /** Certificate DNS identity to verify when the connection URL uses an IP address. */
  serverName?: string;
}

export interface SecureNatsClientConfig {
  url: string;
  token?: string;
  user?: string;
  password?: string;
  tls?: NatsTlsOptions;
}

export interface SecureNatsConnectionOptions {
  servers: string;
  token?: string;
  user?: string;
  pass?: string;
  tls?: Omit<NatsTlsOptions, "serverName"> & { servername?: string };
}

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || (isIP(normalized) === 4 && normalized.split(".")[0] === "127");
};

/**
 * Builds the security-sensitive subset of nats.js ConnectionOptions.
 *
 * Plaintext is permitted only on loopback. A tls:// endpoint always sets an
 * explicit tls object, which makes nats.js require TLS and validate the server
 * certificate/hostname. Secrets in URLs and mixed token/user auth are rejected.
 */
export const buildSecureNatsConnectionOptions = (
  config: SecureNatsClientConfig,
): SecureNatsConnectionOptions => {
  let endpoint: URL;
  try {
    endpoint = new URL(config.url);
  } catch {
    throw new Error("nats-url-invalid");
  }

  if (endpoint.protocol !== "nats:" && endpoint.protocol !== "tls:") {
    throw new Error("nats-url-scheme-invalid");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("nats-url-embedded-credentials-rejected");
  }
  if ((endpoint.pathname && endpoint.pathname !== "/") || endpoint.search || endpoint.hash) {
    throw new Error("nats-url-components-invalid");
  }

  const token = config.token;
  const user = config.user;
  const password = config.password;
  if (token && (user || password)) {
    throw new Error("nats-auth-methods-conflict");
  }
  if (!!user !== !!password) {
    throw new Error("nats-user-password-pair-required");
  }

  if (endpoint.protocol === "nats:" && !isLoopbackHost(endpoint.hostname)) {
    throw new Error("nats-plaintext-non-loopback-rejected");
  }
  if (endpoint.protocol === "nats:" && config.tls) {
    throw new Error("nats-tls-options-require-tls-url");
  }

  const serverName = config.tls?.serverName?.trim();
  if (endpoint.protocol === "tls:" && isIP(endpoint.hostname) !== 0 && !serverName) {
    throw new Error("nats-tls-server-name-required-for-ip");
  }
  if (serverName && (isIP(serverName) !== 0 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(serverName))) {
    throw new Error("nats-tls-server-name-invalid");
  }

  const { serverName: _configuredServerName, ...tlsOptions } = config.tls ?? {};

  return {
    servers: config.url,
    ...(token ? { token } : {}),
    ...(user && password ? { user, pass: password } : {}),
    ...(endpoint.protocol === "tls:"
      ? { tls: { ...tlsOptions, ...(serverName ? { servername: serverName } : {}) } }
      : {}),
  };
};
