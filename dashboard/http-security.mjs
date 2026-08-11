import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
});

export function loadDashboardToken(tokenFile) {
  const stat = statSync(tokenFile);
  if (!stat.isFile()) throw new Error("dashboard token path is not a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("dashboard token file is accessible by group or others");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("dashboard token must be at least 32 URL-safe characters");
  }
  return token;
}

const secureEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function isAuthorizedHeader(header, token) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return secureEqual(username, "murmur") && secureEqual(password, token);
  } catch {
    return false;
  }
}

export function isSameOriginWebSocket(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === request.headers.host;
  } catch {
    return false;
  }
}
