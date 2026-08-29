const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const codexTaskConversationId = (threadId: string | undefined): string | null => {
  const value = String(threadId ?? "").trim();
  return THREAD_ID_PATTERN.test(value) ? `codex:task:${value}` : null;
};

export const defaultPeerConversationId = ({
  to,
  agentId,
  codexThreadId,
}: {
  to: string;
  agentId: string;
  codexThreadId?: string;
}): string => codexTaskConversationId(codexThreadId) ?? `dm:${agentId}:${to}`;
