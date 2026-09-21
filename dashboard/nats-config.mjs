import { buildSecureNatsConnectionOptions } from "../packages/core/dist/src/index.js";

/** Dashboard credentials are independent from daemon credentials. Never inherit its write role. */
export const dashboardNatsOptions = (env = process.env) => buildSecureNatsConnectionOptions({
  url: env.NATS_URL || "nats://localhost:4222",
  token: env.NATS_TOKEN,
  user: env.NATS_USER,
  password: env.NATS_PASSWORD,
  ...(env.NATS_CA_FILE || env.NATS_SERVER_NAME || env.NATS_CERT_FILE || env.NATS_KEY_FILE ? { tls: {
    ...(env.NATS_CA_FILE ? { caFile: env.NATS_CA_FILE } : {}),
    ...(env.NATS_SERVER_NAME ? { serverName: env.NATS_SERVER_NAME } : {}),
    ...(env.NATS_CERT_FILE ? { certFile: env.NATS_CERT_FILE } : {}),
    ...(env.NATS_KEY_FILE ? { keyFile: env.NATS_KEY_FILE } : {}),
  } } : {}),
});
