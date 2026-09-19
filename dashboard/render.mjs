const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export const validAgentId = (value) => typeof value === "string" && AGENT_ID.test(value);

const text = (value, fallback = "?", max = 500) =>
  typeof value === "string" ? value.slice(0, max) : fallback;

const element = (document, tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

export function createAgentItem(document, { agent, isSelf, isOnline, isActive, onToggle }) {
  if (!validAgentId(agent)) throw new TypeError("invalid agent id");

  const item = element(document, "button", "agent-item");
  item.type = "button";
  if (isSelf) item.classList.add("self");
  if (isActive) item.classList.add("active");
  item.dataset.agent = agent;

  item.append(element(document, "span", `agent-dot ${isOnline ? "online" : "offline"}`));
  item.append(element(document, "span", `agent-name${isSelf ? " self" : ""}`, `${agent}${isSelf ? " (me)" : ""}`));
  item.addEventListener("click", () => onToggle(agent));
  return item;
}

export function createMessageElement(document, data) {
  const from = validAgentId(data?.from) ? data.from : "unknown";
  const to = validAgentId(data?.to) ? data.to : "unknown";
  const direction = data?.direction === "inbound" ? "inbound" : "outbound";
  const kind = data?.type === "error" ? "error" : direction;
  const root = element(document, "article", `msg ${kind}${data?.historical === true ? " historical" : ""}`);
  root.dataset.from = from;
  root.dataset.to = to;

  const header = element(document, "div", "msg-header");
  const route = element(document, "div", "msg-route");
  route.append(element(document, "span", "from", from));
  route.append(element(document, "span", "arrow", " → "));
  route.append(element(document, "span", "to", to));
  header.append(route);

  const authenticated = data?.authenticated === true;
  const crypto = data?.encrypted === true ? (authenticated ? "🔐✅" : "🔐❌") : (authenticated ? "✅" : "⚠️");
  header.append(element(document, "span", "msg-crypto", crypto));

  let displayTime = "";
  if (typeof data?.ts === "string") {
    const parsed = new Date(data.ts);
    if (!Number.isNaN(parsed.valueOf())) displayTime = parsed.toLocaleTimeString();
  }
  header.append(element(document, "span", "msg-time", displayTime));
  root.append(header);
  root.append(element(document, "div", "msg-text", text(data?.text, "", 500)));
  return root;
}
