import { createAgentItem, createMessageElement, validAgentId } from "/render.mjs";

const msgContainer = document.getElementById("messages");
const agentList = document.getElementById("agentList");
const connStatus = document.getElementById("connStatus");
const statMsgs = document.getElementById("statMsgs");
const statAgents = document.getElementById("statAgents");
const statUptime = document.getElementById("statUptime");

let ws;
let agents = [];
let selfAgent = "";
let seenAgents = new Set();
let reconnectDelay = 1000;
let filterAgent = null;

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function toggleFilter(agent) {
  filterAgent = filterAgent === agent ? null : agent;
  renderAgents();
  document.querySelectorAll("#messages .msg").forEach((node) => {
    node.classList.toggle(
      "filtered-out",
      Boolean(filterAgent && node.dataset.from !== filterAgent && node.dataset.to !== filterAgent),
    );
  });
}

function renderAgents() {
  const fragment = document.createDocumentFragment();
  for (const agent of agents) {
    fragment.append(createAgentItem(document, {
      agent,
      isSelf: agent === selfAgent,
      isOnline: seenAgents.has(agent) || agent === selfAgent,
      isActive: filterAgent === agent,
      onToggle: toggleFilter,
    }));
  }
  agentList.replaceChildren(fragment);
}

function addMessage(data) {
  if (data?.authenticated !== true) return;
  const empty = msgContainer.querySelector(".empty-state");
  if (empty) empty.remove();

  if (validAgentId(data.from)) seenAgents.add(data.from);
  renderAgents();

  const node = createMessageElement(document, data);
  if (filterAgent && node.dataset.from !== filterAgent && node.dataset.to !== filterAgent) {
    node.classList.add("filtered-out");
  }
  msgContainer.prepend(node);

  while (msgContainer.children.length > 200) msgContainer.lastChild.remove();
}

function onFrame(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  if (data?.type === "init") {
    selfAgent = validAgentId(data.self) ? data.self : "";
    agents = Array.isArray(data.agents) ? [...new Set(data.agents.filter(validAgentId))] : [];
    renderAgents();
    return;
  }

  if (data?.type === "stats") {
    statMsgs.textContent = String(safeCount(data.totalMessages));
    statAgents.textContent = String(Array.isArray(data.agents) ? data.agents.filter(validAgentId).length : 0);
    const secs = Math.floor(safeCount(data.uptimeMs) / 1000);
    const mins = Math.floor(secs / 60);
    const hrs = Math.floor(mins / 60);
    statUptime.textContent = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${secs % 60}s`;
    return;
  }

  if (data?.type === "message") addMessage(data);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = location.pathname.replace(/\/[^/]*$/, "");
  ws = new WebSocket(`${proto}//${location.host}${base}/ws`);
  ws.addEventListener("open", () => {
    connStatus.className = "status-badge status-connected";
    connStatus.textContent = "● Connected";
    reconnectDelay = 1000;
  });
  ws.addEventListener("close", () => {
    connStatus.className = "status-badge status-disconnected";
    connStatus.textContent = "● Disconnected";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  ws.addEventListener("message", onFrame);
}

connect();
