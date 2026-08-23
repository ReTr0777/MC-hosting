/*
 * Renderer for the node control panel.
 *
 * Runs with no Node access: everything it can do arrives on `window.node`, the
 * bridge defined in src/preload/index.ts. Plain DOM on purpose — the UI is a
 * handful of forms and a log tail, which does not justify a framework or a bundler.
 */

type DaemonState = 'stopped' | 'starting' | 'running' | 'crashed';
type DockerState = 'ok' | 'not-running' | 'not-installed' | 'checking' | 'starting';

interface DaemonStatus {
  state: DaemonState;
  pid: number | null;
  port: number;
  lastError: string | null;
  uptimeMs: number | null;
}
interface DockerStatus { state: DockerState; version: string | null; detail: string }
type UpdateState = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
interface UpdateStatus { state: UpdateState; version: string | null; percent: number | null }
interface NodeConfig {
  port: number;
  apiKey: string;
  startDockerWithApp: boolean;
  setupCompleted: boolean;
  /** The panel this node joined with a setup code; empty when it never did. */
  panelUrl: string;
  nodeName: string;
  frpServerAddr: string;
  frpServerPort: number;
  frpToken: string;
  /** Tunnel-server port mapping back to this node's API; 0 when not published. */
  frpApiRemotePort: number;
  enabledGames: string[];
  dataDir: string;
  /** Cap on RAM handed to servers, in MB; 0 for the whole machine. */
  maxMemoryMb: number;
  /** Cap on CPU handed to servers, in logical processors; 0 for all of them. */
  maxCpus: number;
}
interface AppInfo {
  version: string;
  machineMemoryMb: number;
  machineCpuCores: number;
  dataRoot: string;
  addresses: string[];
  hostname: string;
  autoStart: boolean;
  availableGames: { id: string; label: string }[];
  defaultDataDir: string;
}
interface StorageInfo {
  path: string;
  sizeBytes: number | null;
  freeBytes: number | null;
  serverCount: number;
  writable: boolean;
}
interface MoveDataResult { ok: boolean; detail: string; path: string }
interface LogLine { ts: number; stream: 'out' | 'err' | 'app'; text: string }
interface FirewallStatus { state: 'open' | 'missing' | 'unknown'; detail: string }
interface VerifyResult {
  ok: boolean;
  via?: 'tunnel' | 'direct';
  host?: string;
  port?: number;
  moved?: boolean;
  tried?: { address: string; via: 'tunnel' | 'direct' }[];
}
interface EnrollResult {
  node: { id: string; name: string; host: string; port: number };
  tunnel: { serverAddr: string; serverPort: number; token: string; apiRemotePort: number } | null;
  reachability: 'direct' | 'tunnel' | 'unverified';
  panelUrl: string;
  verified?: VerifyResult;
}

/**
 * What to tell the user once the panel has answered.
 *
 * The failure text is the important half. "Could not connect" sends someone to check
 * whether the node is running, which it plainly is — what they need is which address was
 * refused, because a direct one means a firewall and a tunnel one means the tunnel server
 * is not publishing that port. Two different jobs, and only this sentence distinguishes them.
 */
function verdict(enrolled: EnrollResult): string {
  const v = enrolled.verified;

  if (v?.ok) {
    const where = `${v.host}:${v.port}`;
    return v.via === 'tunnel'
      ? `Connected as "${enrolled.node.name}" and the panel can see it, through the tunnel at ${where}. This machine is ready to host.`
      : `Connected as "${enrolled.node.name}" and the panel can see it directly at ${where}. This machine is ready to host.`;
  }

  const tried = v?.tried ?? [];
  const direct = tried.filter((t) => t.via === 'direct').map((t) => t.address);
  const tunnel = tried.filter((t) => t.via === 'tunnel').map((t) => t.address);

  /*
   * The tunnel is the only address a tunnelled node is asked about, so it is usually the
   * whole of the failure rather than one line in a list — and it points at a specific,
   * fixable thing on the panel's side, which "could not reach this machine" does not.
   */
  let why = 'The panel could not reach this machine at any address.';
  if (tunnel.length > 0) {
    why =
      `The panel could not reach this machine through the tunnel at ${tunnel.join(', ')}. ` +
      'The node dialled out and the tunnel server accepted it, so the usual cause is that ' +
      'the tunnel server is not publishing that port — an administrator has to check its ' +
      'published range against NODE_TUNNEL_PORT_RANGE on the panel.';
  }
  if (direct.length > 0) {
    why +=
      tunnel.length > 0
        ? ` Nothing answered directly at ${direct.join(', ')} either.`
        : ` Nothing answered at ${direct.join(', ')} — usually Windows Firewall; the Overview tab can open the port.`;
  }

  return (
    `Registered as "${enrolled.node.name}", but not online yet. ${why} ` +
    'Fix that and press "Find this node again" on its page in the panel — the code is not needed twice.'
  );
}

interface NodeApi {
  getAppInfo(): Promise<AppInfo>;
  readConfig(): Promise<NodeConfig>;
  writeConfig(patch: Partial<NodeConfig>): Promise<NodeConfig>;
  regenerateApiKey(): Promise<string>;
  enroll(
    panelUrl: string,
    code: string,
    limits?: { memoryMb?: number; cpuCores?: number }
  ): Promise<EnrollResult>;
  completeSetup(): Promise<NodeConfig>;
  onEnrollProgress(cb: (message: string) => void): void;
  importConfig(): Promise<{ imported: boolean; nodeName?: string | null; panelUrl?: string | null }>;
  getStatus(): Promise<DaemonStatus>;
  getLogs(): Promise<LogLine[]>;
  clearLogs(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
  getFirewallStatus(): Promise<FirewallStatus>;
  openFirewall(): Promise<{ ok: boolean; detail: string; status: FirewallStatus }>;
  checkDocker(): Promise<DockerStatus>;
  openDockerDownload(): Promise<void>;
  startDocker(): Promise<DockerStatus>;
  configureDockerAutoStart(): Promise<{ ok: boolean; changed: boolean; detail: string }>;
  onDockerStatus(cb: (s: DockerStatus) => void): void;
  getStorageInfo(): Promise<StorageInfo>;
  chooseStorageDir(): Promise<{ path: string; ok: boolean; message: string } | null>;
  moveStorageDir(target: string): Promise<MoveDataResult>;
  onStorageProgress(cb: (message: string) => void): void;
  setLimits(limits: { maxMemoryMb?: number; maxCpus?: number }): Promise<NodeConfig>;
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

/**
 * The sentence the main process threw, without Electron's wrapper around it.
 *
 * Every handler here raises text meant to be read by whoever is at the keyboard; the IPC
 * layer prefixes it with the channel name, which is noise to them and detail to us.
 */
function stripIpcPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '');
}

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

const DOCKER_LABELS: Record<DockerState, string> = {
  ok: 'Running',
  'not-running': 'Not running',
  'not-installed': 'Not installed',
  checking: 'Checking…',
  starting: 'Starting…',
};

/**
 * Paints Docker's state wherever it is shown.
 *
 * Both the Overview card and the wizard's copy of it, because the engine can take minutes
 * to come up and the two must not disagree about what is happening while it does. Called
 * from the poll and from the main process's own progress events alike.
 */
function renderDocker(d: DockerStatus): void {
  for (const [badgeId, detailId] of [
    ['docker-badge', 'docker-detail'],
    ['wiz-docker-badge', 'wiz-docker-detail'],
  ] as const) {
    const badge = document.getElementById(badgeId);
    const detail = document.getElementById(detailId);
    if (!badge || !detail) continue;
    badge.textContent = DOCKER_LABELS[d.state];
    badge.dataset.state = d.state;
    detail.textContent = d.detail;
  }

  const installed = d.state !== 'not-installed';
  // Starting it again while it is starting achieves nothing but confusion.
  const offerStart = d.state === 'not-running';
  $('btn-docker-download').classList.toggle('hidden', installed);
  $('btn-docker-start').classList.toggle('hidden', !offerStart);
  $('wiz-docker-download').classList.toggle('hidden', installed);
  $('wiz-docker-start').classList.toggle('hidden', !offerStart);
}

/**
 * Windows Firewall, in both places it is shown.
 *
 * Treated as first-class rather than a footnote because a blocked port is invisible from
 * this side: the node runs, the daemon answers locally, and only the panel knows anything
 * is wrong — by which point it just says "offline".
 */
function renderFirewall(f: FirewallStatus): void {
  const labels: Record<FirewallStatus['state'], string> = {
    open: 'Allowed',
    missing: 'Blocked',
    unknown: 'Unknown',
  };

  for (const [badgeId, detailId] of [
    ['firewall-badge', 'firewall-detail'],
    ['wiz-firewall-badge', 'wiz-firewall-detail'],
  ] as const) {
    const badge = document.getElementById(badgeId);
    const detail = document.getElementById(detailId);
    if (!badge || !detail) continue;
    badge.textContent = labels[f.state];
    // Reuse the Docker badge's colours: ok is the same green, blocked the same amber.
    badge.dataset.state = f.state === 'open' ? 'ok' : f.state === 'missing' ? 'not-running' : '';
    detail.textContent = f.detail;
  }

  const blocked = f.state !== 'open';
  $('btn-firewall-open').classList.toggle('hidden', !blocked);
  $('wiz-firewall-open').classList.toggle('hidden', !blocked);
}

async function refreshFirewall(): Promise<void> {
  renderFirewall(await api.getFirewallStatus());
}

async function allowThroughFirewall(): Promise<void> {
  const result = await api.openFirewall();
  renderFirewall(result.status);
  // The elevated command's own message is the useful one when it went wrong: it carries
  // the netsh line to run by hand.
  if (!result.ok) toast(result.detail.split('\n')[0]);
}

async function refreshDocker(): Promise<void> {
  renderDocker({ state: 'checking', version: null, detail: 'Checking for Docker Desktop…' });
  renderDocker(await api.checkDocker());
}

/** Launches Docker and keeps the UI honest for however long the engine takes. */
async function startDocker(): Promise<void> {
  renderDocker({ state: 'starting', version: null, detail: 'Starting Docker Desktop…' });
  renderDocker(await api.startDocker());
}

/* ---------- updates ---------- */

function renderUpdate(u: UpdateStatus): void {
  const badge = $('update-badge');
  const labels: Record<UpdateState, string> = {
    idle: 'Up to date',
    checking: 'Checking for updates…',
    current: 'Up to date',
    available: `Version ${u.version ?? '?'} available`,
    downloading: u.percent === null ? 'Downloading update…' : `Downloading update… ${u.percent}%`,
    installing: `Installing ${u.version ?? 'update'} — the node will restart`,
    error: 'Update check failed',
  };
  badge.textContent = labels[u.state];
  // Only the states the user might need to act on get colour.
  badge.dataset.state = u.state === 'error' ? 'not-running' : u.state === 'installing' ? 'ok' : '';

  // An offered update stays reachable here, so declining the popup is not a dead end.
  const offered = u.state === 'available';
  $('btn-update-install').classList.toggle('hidden', !offered);
  // Nothing to check for while an update is already on its way in.
  $('btn-update-check').classList.toggle('hidden', u.state === 'downloading' || u.state === 'installing');

  const detail = $('update-detail');
  detail.classList.toggle('hidden', !offered);
  if (offered) {
    detail.textContent =
      'Installing restarts the node agent — it shows offline in the panel for a few seconds. ' +
      'Game servers keep running.';
  }
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
  // 0 is "not published" — show it as empty rather than as a port nobody chose.
  $<HTMLInputElement>('inp-frp-api-port').value = config.frpApiRemotePort ? String(config.frpApiRemotePort) : '';

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

  renderEnrollment();
  renderAddress();
  renderLimits();
}

/**
 * What this node has already joined, if anything.
 *
 * Worth showing prominently: on a machine that is already a node, the commonest reason to
 * open this tab is to check *which* panel it answers to before changing anything.
 */
function renderEnrollment(): void {
  const badge = $('enroll-badge');
  const joined = !!config.panelUrl;
  badge.classList.toggle('hidden', !joined);
  if (joined) {
    badge.textContent = `Joined ${config.panelUrl}`;
    badge.dataset.state = 'ok';
  }

  const result = $('enroll-result');
  if (joined && result.classList.contains('hidden')) {
    result.textContent =
      `This machine is registered as "${config.nodeName || 'a node'}" on ${config.panelUrl}. ` +
      'Entering a new code moves it to whichever panel issued that code.';
    result.classList.remove('hidden');
  }
}

/* ---------- resources ---------- */

/** Where the user has said to move the servers, before they confirm it. Null when idle. */
let pendingDataDir: string | null = null;

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The storage line: what is stored, and whether the drive can take much more.
 *
 * Free space is the number that matters. A node that fills its drive stops mid-save, and
 * the first anyone hears of it is a world that will not load.
 */
async function renderStorage(): Promise<void> {
  $<HTMLInputElement>('inp-data-dir').value = config.dataDir;

  const detail = $('storage-detail');
  detail.textContent = 'Reading…';
  try {
    const store = await api.getStorageInfo();
    const parts: string[] = [];
    parts.push(
      store.serverCount === 1 ? '1 server stored here' : `${store.serverCount} servers stored here`
    );
    if (store.sizeBytes !== null) parts.push(`using ${gb(store.sizeBytes)}`);
    if (store.freeBytes !== null) parts.push(`${gb(store.freeBytes)} free on that drive`);
    if (!store.writable) parts.push('— this folder cannot be written to');
    detail.textContent = `${parts.join(', ')}.`;
  } catch (err: any) {
    detail.textContent = stripIpcPrefix(err.message);
  }
}

/**
 * The two allowance sliders.
 *
 * Both run to the machine's own size, and sitting at the top means "no limit" — which is
 * stored as 0 rather than as the current hardware figure, so the node still offers the
 * whole machine after a RAM upgrade instead of being pinned to what it had that day.
 */
function renderLimits(): void {
  const memory = $<HTMLInputElement>('rng-max-memory');
  // Whole gigabytes: nobody wants to aim a slider at 6144 MB, and the daemon rounds anyway.
  const machineGb = Math.max(1, Math.floor(info.machineMemoryMb / 1024));
  memory.min = '1';
  memory.max = String(machineGb);
  memory.step = '1';
  memory.value = String(config.maxMemoryMb > 0 ? Math.max(1, Math.round(config.maxMemoryMb / 1024)) : machineGb);

  const cpu = $<HTMLInputElement>('rng-max-cpu');
  cpu.min = '1';
  cpu.max = String(info.machineCpuCores);
  cpu.step = '1';
  cpu.value = String(config.maxCpus > 0 ? Math.max(1, Math.round(config.maxCpus)) : info.machineCpuCores);

  renderLimitLabels();
}

function renderLimitLabels(): void {
  const machineGb = Math.max(1, Math.floor(info.machineMemoryMb / 1024));
  const gbValue = Number($<HTMLInputElement>('rng-max-memory').value);
  const cores = Number($<HTMLInputElement>('rng-max-cpu').value);

  $('lbl-max-memory').textContent = `${gbValue} GB`;
  $('lbl-max-cpu').textContent = cores === 1 ? '1 CPU' : `${cores} CPUs`;

  $('hint-max-memory').textContent =
    gbValue >= machineGb
      ? `The whole machine (${machineGb} GB). Servers can use all of it.`
      : `${machineGb - gbValue} GB of this machine's ${machineGb} GB stays yours.`;
  /*
   * "CPUs", not "cores".
   *
   * This counts logical processors — threads — because that is what Docker limits a
   * container to and what a server's own CPU figure means. On a chip with SMT it is twice
   * the core count, so calling it cores would have an 8-core machine reporting 16 of them.
   */
  $('hint-max-cpu').textContent =
    cores >= info.machineCpuCores
      ? `Everything this machine has (${info.machineCpuCores} logical processors).`
      : `${info.machineCpuCores - cores} of ${info.machineCpuCores} logical processors stay yours.`;
}

async function chooseDataDir(): Promise<void> {
  const error = $('storage-error');
  error.classList.add('hidden');

  const picked = await api.chooseStorageDir();
  if (!picked) return;

  if (!picked.ok) {
    error.textContent = picked.message;
    error.classList.remove('hidden');
    return;
  }

  // Chosen but not moved. The move stops the node and rewrites hundreds of gigabytes;
  // it does not happen because somebody clicked through a folder picker.
  pendingDataDir = picked.path;
  const pending = $('storage-pending');
  pending.textContent = `Move to ${picked.path}? ${picked.message} The node stops while this runs.`;
  pending.classList.remove('hidden');
  $('storage-move-row').classList.remove('hidden');
}

function cancelMove(): void {
  pendingDataDir = null;
  $('storage-pending').classList.add('hidden');
  $('storage-move-row').classList.add('hidden');
  $('storage-error').classList.add('hidden');
}

async function moveDataDir(): Promise<void> {
  if (!pendingDataDir) return;

  const button = $<HTMLButtonElement>('btn-move-data');
  const pending = $('storage-pending');
  const error = $('storage-error');
  button.disabled = true;
  error.classList.add('hidden');
  pending.textContent = 'Stopping the node…';

  try {
    const result = await api.moveStorageDir(pendingDataDir);
    if (result.ok) {
      config = await api.readConfig();
      cancelMove();
      await renderStorage();
      toast(result.detail);
    } else {
      error.textContent = result.detail;
      error.classList.remove('hidden');
      pending.classList.add('hidden');
    }
  } catch (err: any) {
    error.textContent = stripIpcPrefix(err.message);
    error.classList.remove('hidden');
    pending.classList.add('hidden');
  } finally {
    button.disabled = false;
  }
}

async function saveLimits(): Promise<void> {
  const machineGb = Math.max(1, Math.floor(info.machineMemoryMb / 1024));
  const gbValue = Number($<HTMLInputElement>('rng-max-memory').value);
  const cores = Number($<HTMLInputElement>('rng-max-cpu').value);
  const error = $('limits-error');
  error.classList.add('hidden');

  try {
    config = await api.setLimits({
      // At the top of the slider the answer is "no limit", not "exactly what this
      // machine has today".
      maxMemoryMb: gbValue >= machineGb ? 0 : gbValue * 1024,
      maxCpus: cores >= info.machineCpuCores ? 0 : cores,
    });
    renderLimits();
    $('limits-saved').classList.remove('hidden');
    window.setTimeout(() => $('limits-saved').classList.add('hidden'), 4000);
    toast(
      config.maxMemoryMb || config.maxCpus
        ? 'Limits saved. The panel picks them up at its next health check.'
        : 'Limits removed. This node offers the whole machine again.'
    );
  } catch (err: any) {
    error.textContent = stripIpcPrefix(err.message);
    error.classList.remove('hidden');
  }
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

/* ---------- first-run wizard ---------- */

/*
 * Four steps, in the order a node actually needs them: Docker, what to host, how much of
 * the machine to give away, and which panel to join. Enrolling is last because it is the
 * only one that cannot be undone from in here — the code is spent once it is used.
 */
const WIZARD_STEPS = 5;
let wizardStep = 1;
/** Set once enrollment succeeds, so the last step turns into a summary rather than a retry. */
let wizardJoined = false;

function renderWizard(): void {
  $('wizard-step-label').textContent = `Step ${wizardStep} of ${WIZARD_STEPS}`;
  document.querySelectorAll<HTMLElement>('.wizard-step').forEach((el) => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== wizardStep);
  });

  // Both checks are re-read on arrival: the user may have just installed Docker or
  // clicked through a UAC prompt, and a stale badge is worse than no badge.
  if (wizardStep === 1) void refreshDocker();
  if (wizardStep === 2) void refreshFirewall();

  ($('wiz-back') as HTMLButtonElement).disabled = wizardStep === 1;
  const next = $('wiz-next') as HTMLButtonElement;
  next.textContent = wizardStep < WIZARD_STEPS ? 'Next' : wizardJoined ? 'Finish' : 'Connect';
}

/** Game toggles, built from whatever games this build knows about. */
function renderWizardGames(): void {
  const row = $('wiz-games');
  row.textContent = '';
  for (const game of info.availableGames) {
    const label = document.createElement('label');
    label.className = 'check inline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = game.id;
    box.checked = config.enabledGames.includes(game.id);
    const text = document.createElement('span');
    text.textContent = game.label;
    label.append(box, text);
    row.appendChild(label);
  }
}

function openWizard(): void {
  wizardStep = 1;
  wizardJoined = false;

  renderWizardGames();

  /*
   * Suggested limits, not the whole machine.
   *
   * Three quarters of the RAM and one core held back: this is somebody's PC as well as a
   * node, and a node registered at its full size is one the panel will fill until Windows
   * starts swapping. Both are only defaults — the fields are there to be argued with.
   */
  const suggestedMemory = Math.max(512, Math.floor((info.machineMemoryMb * 0.75) / 512) * 512);
  const suggestedCores = Math.max(1, info.machineCpuCores - 1);
  $<HTMLInputElement>('wiz-memory').value = String(suggestedMemory);
  $<HTMLInputElement>('wiz-cores').value = String(suggestedCores);
  $('wiz-memory-hint').textContent = `This machine has ${(info.machineMemoryMb / 1024).toFixed(1)} GB.`;
  // Threads, not cores — see renderLimitLabels. The old wording claimed an 8-core chip
  // with SMT had 16 cores.
  $('wiz-cores-hint').textContent = `This machine has ${info.machineCpuCores} logical processors.`;

  $<HTMLInputElement>('wiz-chk-docker').checked = config.startDockerWithApp;
  $<HTMLInputElement>('wiz-chk-autostart').checked = true;

  $('wizard').classList.remove('hidden');
  renderWizard();
  void refreshDocker();
}

async function closeWizard(): Promise<void> {
  $('wizard').classList.add('hidden');
  config = await api.completeSetup();
  renderConfig();
}

/** Applies the choices made on the step being left, so Back never loses them. */
async function commitWizardStep(step: number): Promise<void> {
  if (step === 1) {
    const withApp = $<HTMLInputElement>('wiz-chk-docker').checked;
    config = await api.writeConfig({ startDockerWithApp: withApp });

    if ($<HTMLInputElement>('wiz-chk-docker-login').checked) {
      // Docker's own setting, which is the half that survives this app being closed.
      const result = await api.configureDockerAutoStart();
      if (!result.ok) toast(result.detail);
    }
  }

  if (step === 3) {
    const picked = Array.from($('wiz-games').querySelectorAll<HTMLInputElement>('input:checked')).map(
      (b) => b.value
    );
    // writeConfig refuses an empty list, and rightly: a node hosting nothing is invisible
    // to the panel. Keep whatever was already set rather than failing the step.
    if (picked.length > 0) config = await api.writeConfig({ enabledGames: picked });
  }
}

/** The last step: join the panel with the code, using the limits chosen on step 3. */
async function wizardEnroll(): Promise<void> {
  const next = $('wiz-next') as HTMLButtonElement;
  const error = $('wiz-error');
  const success = $('wiz-success');
  error.classList.add('hidden');

  const code = $<HTMLInputElement>('wiz-code').value;
  if (!code.trim()) {
    error.textContent = 'Enter the setup code from the panel, or skip setup and do it later.';
    error.classList.remove('hidden');
    return;
  }

  next.disabled = true;
  next.textContent = 'Connecting…';
  try {
    const enrolled = await api.enroll($<HTMLInputElement>('wiz-panel-url').value, code, {
      memoryMb: Number($<HTMLInputElement>('wiz-memory').value),
      cpuCores: Number($<HTMLInputElement>('wiz-cores').value),
    });

    if ($<HTMLInputElement>('wiz-chk-autostart').checked) {
      const applied = await api.setAutoStart(true);
      $<HTMLInputElement>('chk-autostart').checked = applied;
      if (!applied) toast('Windows would not accept the start-at-sign-in setting.');
    }

    config = await api.readConfig();
    renderConfig();
    wizardJoined = true;
    success.textContent = verdict(enrolled);
    success.classList.remove('hidden');
    $<HTMLInputElement>('wiz-code').value = '';
  } catch (err) {
    error.textContent = stripIpcPrefix((err as Error).message);
    error.classList.remove('hidden');
  } finally {
    next.disabled = false;
    renderWizard();
  }
}

function wireWizard(): void {
  $('wiz-next').addEventListener('click', async () => {
    if (wizardStep < WIZARD_STEPS) {
      await commitWizardStep(wizardStep);
      wizardStep++;
      renderWizard();
      return;
    }
    // Last step: connect, and then the same button finishes.
    if (wizardJoined) return closeWizard();
    await wizardEnroll();
  });

  $('wiz-back').addEventListener('click', () => {
    if (wizardStep > 1) wizardStep--;
    renderWizard();
  });

  // Skipping is legitimate: an admin may be registering this node by hand, and the
  // Connection tab does everything the wizard does.
  $('wiz-skip').addEventListener('click', () => {
    void commitWizardStep(wizardStep).finally(closeWizard);
  });

  $('wiz-docker-start').addEventListener('click', startDocker);
  $('wiz-docker-recheck').addEventListener('click', refreshDocker);
  $('wiz-docker-download').addEventListener('click', () => api.openDockerDownload());
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
  $('btn-docker-start').addEventListener('click', startDocker);

  $('btn-firewall-recheck').addEventListener('click', refreshFirewall);
  $('btn-firewall-open').addEventListener('click', allowThroughFirewall);
  $('wiz-firewall-recheck').addEventListener('click', refreshFirewall);
  $('wiz-firewall-open').addEventListener('click', allowThroughFirewall);

  $('chk-docker-autostart').addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    config = await api.writeConfig({ startDockerWithApp: on });
    toast(on ? 'Docker will start with this app.' : 'Docker will not be started automatically.');
  });

  $('btn-docker-login').addEventListener('click', async () => {
    const result = await api.configureDockerAutoStart();
    $('docker-login-detail').textContent = result.detail;
    toast(result.ok ? 'Docker set to start at sign-in.' : 'Docker could not be configured.');
  });

  wireWizard();

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
      toast(stripIpcPrefix((err as Error).message));
    }
  });

  $('btn-enroll').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('btn-enroll');
    const error = $('enroll-error');
    const result = $('enroll-result');
    const panelUrl = $<HTMLInputElement>('inp-panel-url').value;
    const code = $<HTMLInputElement>('inp-enroll-code').value;

    error.classList.add('hidden');
    result.classList.add('hidden');

    if (!code.trim()) {
      error.textContent = 'Enter the setup code the panel gave you.';
      error.classList.remove('hidden');
      return;
    }

    // The panel probes this machine before it answers, so this is not a quick request and
    // a second click would spend a second code on the same node.
    button.disabled = true;
    button.textContent = 'Connecting…';

    try {
      const enrolled = await api.enroll(panelUrl, code);
      config = await api.readConfig();
      renderConfig();

      result.textContent = verdict(enrolled);
      result.classList.remove('hidden');
      $<HTMLInputElement>('inp-enroll-code').value = '';
      toast(`Joined ${enrolled.panelUrl} as "${enrolled.node.name}".`);
    } catch (err) {
      // The main process throws a sentence meant for the user; Electron wraps it.
      error.textContent = stripIpcPrefix((err as Error).message);
      error.classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });

  $('btn-regen').addEventListener('click', async () => {
    config.apiKey = await api.regenerateApiKey();
    renderConfig();
    // The restart is already done by the time this resolves, so the key on screen is
    // the one the agent is now accepting — nothing left for the user to remember.
    toast('New key generated and node restarted. Paste it into the web panel.');
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
      frpApiRemotePort: Number($<HTMLInputElement>('inp-frp-api-port').value) || 0,
    });
    renderConfig();
    await api.restart();
    toast(
      config.frpApiRemotePort
        ? `Saved. Register this node in the panel as ${config.frpServerAddr}:${config.frpApiRemotePort}`
        : 'Tunnel settings saved. Node restarting.'
    );
  });

  $('chk-autostart').addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    const applied = await api.setAutoStart(on);
    (e.target as HTMLInputElement).checked = applied;
    toast(applied ? 'Node will start with Windows.' : 'Automatic start disabled.');
  });

  $('btn-open-data').addEventListener('click', () => api.openDataDir());
  $('btn-open-data-2').addEventListener('click', () => api.openDataDir());
  $('btn-choose-data-dir').addEventListener('click', chooseDataDir);
  $('btn-move-data').addEventListener('click', moveDataDir);
  $('btn-cancel-move').addEventListener('click', cancelMove);
  $('btn-save-limits').addEventListener('click', saveLimits);
  $('rng-max-memory').addEventListener('input', renderLimitLabels);
  $('rng-max-cpu').addEventListener('input', renderLimitLabels);

  // A move of any size takes minutes, so the app says which stage it is at rather than
  // sitting on one message while nothing visibly happens.
  api.onStorageProgress((message) => {
    $('storage-pending').textContent = message;
    $('storage-pending').classList.remove('hidden');
  });

  $('btn-update-check').addEventListener('click', async () => {
    await api.checkForUpdate();
    toast('Checking for updates…');
  });

  $('btn-update-install').addEventListener('click', async () => {
    await api.installUpdate();
    toast('Downloading the update. The node restarts when it is ready.');
  });

  $('btn-open-log').addEventListener('click', () => api.openLogFile());
  $('btn-clear-logs').addEventListener('click', () => api.clearLogs());

  // Docker progress is pushed as well as polled: a launch takes minutes, and the app must
  // not sit on "Not running" for the whole of it.
  /*
   * The panel is polled for up to two minutes after enrolling, and a button that says
   * "Connecting…" for that long looks hung. Say what is being waited for instead.
   */
  api.onEnrollProgress((message) => {
    for (const id of ['enroll-result', 'wiz-success']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = message;
      el.classList.remove('hidden');
    }
  });

  api.onDockerStatus(renderDocker);
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
  $<HTMLInputElement>('chk-docker-autostart').checked = config.startDockerWithApp;

  wire();
  renderConfig();
  // Walks the whole server folder, so it is left to finish on its own rather than
  // holding up the window.
  void renderStorage();
  renderStatus(daemonStatus);
  renderUpdate(await api.getUpdateStatus());
  for (const line of await api.getLogs()) appendLog(line);

  /*
   * A machine that has never been set up gets the wizard instead of four tabs of settings
   * it has no way to rank. It opens the setup itself, so refreshDocker below is left to
   * the wizard — starting two probes at once only makes the badge flicker.
   */
  if (!config.setupCompleted) openWizard();
  else {
    await refreshDocker();
    await refreshFirewall();
  }

  // Uptime is derived from a start timestamp, so it only advances if we re-render.
  window.setInterval(async () => renderStatus(await api.getStatus()), 1000);
}

void init();
