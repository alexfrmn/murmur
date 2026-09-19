/** Legacy configuration is readable, but cannot authorize unsigned outbox mutations. */
export function normalizeAckSecurity(config = {}, env = process.env, log = () => {}) {
  const settings = config.ackSecurity ?? {};
  const flag = (name, envName, fallback) => {
    const value = env[envName] ?? settings[name];
    if (value === undefined) return fallback;
    if (env[envName] !== undefined) {
      if (value === "1" || value === "true") return true;
      if (value === "0" || value === "false") return false;
    } else if (typeof value === "boolean") return value;
    throw new Error(`ack-security-invalid:${name}`);
  };
  const emitSigned = flag("emitSigned", "MURMUR_EMIT_SIGNED_ACKS", true);
  const requestedRequireSigned = flag("requireSigned", "MURMUR_REQUIRE_SIGNED_ACKS", true);
  if (!requestedRequireSigned) log("warn", "ACK signature downgrade ignored", {
    reason: "unsigned-acks-cannot-settle-outbox", requestedRequireSigned: false, requireSigned: true,
  });
  if (!emitSigned) log("warn", "Unsigned ACK emission explicitly enabled", {
    reason: "upgraded-peers-will-ignore-delivery-acks", emitSigned: false, requireSigned: true,
  });
  return { emitSigned, requireSigned: true, requestedRequireSigned, unsignedAction: "ignore" };
}
