/*
 * Renderer for the node control panel.
 *
 * Runs with no Node access: everything it can do arrives on `window.node`, the
 * bridge defined in src/preload/index.ts. Plain DOM on purpose — the UI is a
 * handful of forms and a log tail, which does not justify a framework or a bundler.
 */

type DaemonState = 'stopped' | 'starting' | 'running' | 'crashed';
type DockerState = 'ok' | 'not-running' | 'not-installed' | 'checking';

interface DaemonStatus {
  state: DaemonState;
  pid: number | null;
  port: number;
  lastError: string | null;
  uptimeMs: number | null;
}
interface DockerStatus { state: DockerState; version: string | null; detail: string }
type UpdateState = 'idle' | 'checking' | 'current' | 'downloading' | 'installing' | 'error';
interface UpdateStatus { state: UpdateState; version: string | null; percent: number | null }
interface NodeConfig {
  port: number;
  apiKey: string;
  frpServerAddr: string;
  frpServerPort: number;
  frpToken: string;
  enabledGames: string[];
  dataDir: string;
}
interface AppInfo {
  version: string;
  dataRoot: string;
  addresses: string[];
  hostname: string;
  autoStart: boolean;
  availableGames: { id: string; label: string }[];
}
interface LogLine { ts: number; stream: 'out' | 'err' | 'app'; text: string }

interface NodeApi {
  getAppInfo(): Promise<AppInfo>;
  readConfig(): Promise<NodeConfig>;
  writeConfig(patch: Partial<NodeConfig>): Promise<NodeConfig>;
  regenerateApiKey(): Promise<string>;
  importConfig(): Promise<{ imported: boolean; nodeName?: string | null; panelUrl?: string | null }>;
  getStatus(): Promise<DaemonStatus>;
  getLogs(): Promise<LogLine[]>;
  clearLogs(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
  checkDocker(): Promise<DockerStatus>;
  openDockerDownload(): Promise<void>;
  setAutoStart(enabled: boolean): Promise<boolean>;
  openDataDir(): Promise<void>;
  openLogFile(): Promise<void>;
  onStatus(cb: (s: DaemonStatus) => void): void;
  onLog(cb: (l: LogLine) => void): void;
  onLogsCleared(cb: () => void): void;
}

// This file compiles as a plain script, not a module, so the interface below merges
// with the DOM's Window rather than shadowing it.
interface Window {
  node: NodeApi;
}

const api: NodeApi = window.node;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let config: NodeConfig;
let info: AppInfo;
// Not `status`: that name is already taken by the global `window.status` string.
let daemonStatus: DaemonStatus;

/* ---------- helpers ---------- */

function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  window.setTimeout(() => el.classList.add('hidden'), 2600);
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/* ---------- status ---------- */

function renderStatus(s: DaemonStatus): void {
  daemonStatus = s;
  const label = s.state.charAt(0).toUpperCase() + s.state.slice(1);

  const pill = $('state-pill');
  pill.textContent = label;
  pill.dataset.state = s.state;

  $('fact-state').textContent = label;
  $('fact-uptime').textContent = formatUptime(s.uptimeMs);
  $('fact-pid').textContent = s.pid ? `PID ${s.pid}` : '—';
  $('fact-port').textContent = `Port ${s.port}`;

  const err = $('fact-error');
  if (s.lastError) {
    err.textContent = s.lastError;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }

  const busy = s.state === 'running' || s.state === 'starting';
  ($('btn-start') as HTMLButtonElement).disabled = busy;
  ($('btn-stop') as HTMLButtonElement).disabled = !busy;

  renderAddress();
}

function renderAddress(): void {
  const host = info?.addresses[0] ?? 'localhost';
  $<HTMLInputElement>('inp-address').value = `http://${host}:${config?.port ?? 3500}`;
  const others = (info?.addresses ?? []).slice(1);
  $('address-hint').textContent = others.length
    ? `Also reachable on: ${others.map((a) => `${a}:${config.port}`).join(', ')}`
    : 'This is the address to enter in the web panel when adding the node.';
}

/* ---------- docker ---------- */

async function refreshDocker(): Promise<void> {
  const badge = $('docker-badge');
  badge.textContent = 'Checking…';
  badge.dataset.state = 'checking';

  const d = await api.checkDocker();
  const labels: Record<DockerState, string> = {
    ok: 'Running',
    'not-running': 'Not running',
    'not-installed': 'Not installed',
    checking: 'Checking…',
  };
  badge.textContent = labels[d.state];
  badge.dataset.state = d.state;
  $('docker-detail').textContent = d.detail;
  $('btn-docker-download').classList.toggle('hidden', d.state !== 'not-installed');
}

/* ---------- updates ---------- */

function renderUpdate(u: UpdateStatus): void {
  const badge = $('update-badge');
  const labels: Record<UpdateState, string> = {
    idle: 'Up to date',
    checking: 'Checking for updates…',
    current: 'Up to date',
    downloading: u.percent === null ? 'Downloading update…' : `Downloading update… ${u.percent}%`,
    installing: `Installing ${u.version ?? 'update'} — the node will restart`,
    error: 'Update check failed',
  };
  badge.textContent = labels[u.state];
  // Only the two states the user might need to act on get colour.
  badge.dataset.state = u.state === 'error' ? 'not-running' : u.state === 'installing' ? 'ok' : '';
}

/* ---------- logs ---------- */

function appendLog(line: LogLine): void {
  const view = $('log-view');
  const stamp = new Date(line.ts).toLocaleTimeString();
  const row = document.createElement('div');
  row.className = line.stream;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `${stamp}  `;
  row.appendChild(ts);
  // textContent, not innerHTML: log lines are untrusted process output.
  row.appendChild(document.createTextNode(line.text));

  view.appendChild(row);
  while (view.childElementCount > 2000) view.removeChild(view.firstChild as ChildNode);

  if ($<HTMLInputElement>('chk-follow').checked) view.scrollTop = view.scrollHeight;
}

/* ---------- config forms ---------- */

function renderConfig(): void {
  $<HTMLInputElement>('inp-apikey').value = config.apiKey;
  $<HTMLInputElement>('inp-port').value = String(config.port);
  $<HTMLInputElement>('inp-frp-addr').value = config.frpServerAddr;
  $<HTMLInputElement>('inp-frp-port').value = String(config.frpServerPort);
  $<HTMLInputElement>('inp-frp-token').value = config.frpToken;

  const row = $('games-row');
  row.textContent = '';
  for (const game of info.availableGames) {
    const label = document.createElement('label');
    label.className = 'check inline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = game.id;
    box.checked = config.enabledGames.includes(game.id);
    box.addEventListener('change', saveGames);
    const text = document.createElement('span');
    text.textContent = game.label;
    label.append(box, text);
    row.appendChild(label);
  }

  renderAddress();
}

async function saveGames(): Promise<void> {
  const picked = Array.from($('games-row').querySelectorAll<HTMLInputElement>('input:checked')).map((b) => b.value);
  try {
    config = await api.writeConfig({ enabledGames: picked });
    toast('Games updated. Restart the node to apply.');
  } catch (err) {
    toast((err as Error).message);
    renderConfig(); // Put the boxes back the way the saved config says.
  }
}

/* ---------- wiring ---------- */

function wire(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  $('btn-start').addEventListener('click', () => api.start());
  $('btn-stop').addEventListener('click', () => api.stop());
  $('btn-restart').addEventListener('click', () => api.restart());

  $('btn-docker-recheck').addEventListener('click', refreshDocker);
  $('btn-docker-download').addEventListener('click', () => api.openDockerDownload());

  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = $<HTMLInputElement>(btn.dataset.copy as string);
      await navigator.clipboard.writeText(input.value);
      toast('Copied to clipboard.');
    });
  });

  $('btn-reveal').addEventListener('click', () => {
    const input = $<HTMLInputElement>('inp-apikey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('btn-reveal').textContent = hidden ? 'Hide' : 'Show';
  });

  $('btn-import').addEventListener('click', async () => {
    try {
      const result = await api.importConfig();
      if (!result.imported) return; // User closed the file picker.
      config = await api.readConfig();
      renderConfig();
      toast(
        result.nodeName
          ? `Imported settings for "${result.nodeName}". Node restarting.`
          : 'Config imported. Node restarting.'
      );
    } catch (err) {
      // The main process throws a sentence meant for the user; show it verbatim.
      toast((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, ''));
    }
  });

  $('btn-regen').addEventListener('click', async () => {
    config.apiKey = await api.regenerateApiKey();
    renderConfig();
    toast('New key generated. Update it in the web panel, then restart the node.');
  });

  $('btn-save-port').addEventListener('click', async () => {
    const port = Number($<HTMLInputElement>('inp-port').value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('Enter a port between 1 and 65535.');
    config = await api.writeConfig({ port });
    renderConfig();
    await api.restart();
    toast('Port saved. Node restarting.');
  });

  $('btn-save-tunnel').addEventListener('click', async () => {
    config = await api.writeConfig({
      frpServerAddr: $<HTMLInputElement>('inp-frp-addr').value,
      frpServerPort: Number($<HTMLInputElement>('inp-frp-port').value) || 7000,
      frpToken: $<HTMLInputElement>('inp-frp-token').value,
    });
    renderConfig();
    await api.restart();
    toast('Tunnel settings saved. Node restarting.');
  });

  $('chk-autostart').addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    const applied = await api.setAutoStart(on);
    (e.target as HTMLInputElement).checked = applied;
    toast(applied ? 'Node will start with Windows.' : 'Automatic start disabled.');
  });

  $('btn-open-data').addEventListener('click', () => api.openDataDir());
  $('btn-open-log').addEventListener('click', () => api.openLogFile());
  $('btn-clear-logs').addEventListener('click', () => api.clearLogs());

  api.onStatus(renderStatus);
  api.onUpdateStatus(renderUpdate);
  api.onLog(appendLog);
  api.onLogsCleared(() => {
    $('log-view').textContent = '';
  });
}

async function init(): Promise<void> {
  [info, config, daemonStatus] = await Promise.all([api.getAppInfo(), api.readConfig(), api.getStatus()]);

  $('host-line').textContent = `${info.hostname} · v${info.version}`;
  $('fact-datadir').textContent = info.dataRoot;
  $<HTMLInputElement>('chk-autostart').checked = info.autoStart;

  wire();
  renderConfig();
  renderStatus(daemonStatus);
  renderUpdate(await api.getUpdateStatus());
  for (const line of await api.getLogs()) appendLog(line);
  await refreshDocker();

  // Uptime is derived from a start timestamp, so it only advances if we re-render.
  window.setInterval(async () => renderStatus(await api.getStatus()), 1000);
}

void init();
