import { natsUserInboxPrefix } from "./nats-security.js";

/** Runtime peer ACL for pre-provisioned pull consumers. Management stays operator-only. */
export function buildNatsPeerPermissions(input: {
  user: string;
  agentId: string;
  peerIds: string[];
  stream?: string;
  consumers?: string[];
  jetstreamDomain?: string;
}): { publish: string[]; subscribe: string[] } {
  const stream = input.stream ?? "MURMUR";
  const consumers = input.consumers ?? [input.agentId, `${input.agentId}-ack`];
  for (const token of [input.agentId, ...input.peerIds, stream, ...consumers, ...(input.jetstreamDomain ? [input.jetstreamDomain] : [])]) {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("nats-acl-token-invalid");
  }
  if (!input.user) throw new Error("nats-acl-user-required");
  const apis = ["$JS.API", ...(input.jetstreamDomain ? [`$JS.${input.jetstreamDomain}.API`] : [])];
  return {
    publish: [
      ...input.peerIds.flatMap((peer) => [`msg.${peer}`, `msg.${peer}.>`, `ack.${peer}`]),
      ...apis.flatMap((api) => [`${api}.INFO`, `${api}.STREAM.INFO.${stream}`]),
      ...consumers.flatMap((consumer) => [
        ...apis.flatMap((api) => [`${api}.CONSUMER.INFO.${stream}.${consumer}`, `${api}.CONSUMER.MSG.NEXT.${stream}.${consumer}`]),
        `$JS.ACK.${stream}.${consumer}.>`,
        ...(input.jetstreamDomain ? [`$JS.ACK.${input.jetstreamDomain}.*.${stream}.${consumer}.>`] : []),
      ]),
    ],
    subscribe: [`msg.${input.agentId}`, `msg.${input.agentId}.>`, `ack.${input.agentId}`, `${natsUserInboxPrefix(input.user)}.>`],
  };
}
