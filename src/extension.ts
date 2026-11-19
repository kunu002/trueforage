import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ChangeSet, type AcceptedOutput, type SelectionBounds, type StagedEdit } from './core/changes';
import { normalizeWorkspacePath } from './core/paths';
import { retrieveContext, renderContextEntry, type ContextEntry } from './core/context';
import { TrueForgeHarness, normalizeGatewayUrl, type HarnessEvent, type HarnessApproval, type WorkMode } from './harness/client';
import { LocalRuntime, resolveExternalNode } from './runtime';
import { ChatHistory } from './history';
import { executeCommand, classifyCommand } from './execution';
import { startMcpServer } from './mcp';
import { Workspace } from './workspace';
import agent from './agent.json';

interface InlineScope extends SelectionBounds { path: string; content: string }
interface PanelHunk { id: string; path: string; startLine: number; oldText: string; newText: string; reason?: string; status: string }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; status?: string }
interface ConnectionState { connected: boolean; label: string; detail: string; status: string }
interface PlanStep { id: string; step: string; status: 'pending' | 'in_progress' | 'completed' }
interface TaskEvent { id: string; type: 'tool' | 'edit' | 'command' | 'status'; title: string; detail?: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; timestamp: number }
interface CommandRun { id: string; executable: string; args: string[]; cwd: string; revision: number; stale?: boolean; status: 'running' | 'passed' | 'failed' | 'cancelled' | 'timed_out'; stdout: string; stderr: string; exitCode?: number | null; durationMs?: number; truncated?: boolean }
interface PanelState {
  mode: 'trueforge' | 'demo'; status: string; model: string; sessionId: string; prompt: string;
  stream: string; context: ContextEntry[]; budgetUsed: number; budgetLimit: number;
  hunks: PanelHunk[]; logs: string[]; canUndo: boolean; busy: boolean; error: string;
  applied: boolean; workspaceLabel: string;
  messages: ChatMessage[]; connection: ConnectionState;
  workMode: WorkMode; plan: PlanStep[]; events: TaskEvent[]; commands: CommandRun[];
  task: { title: string; phase: string; verification?: 'not_run' | 'passed' | 'failed' | 'running' }; history: { id: string; title: string; updatedAt: number }[];
  changedFiles: { path: string; status: 'modified' | 'created' }[];
}
const initialState = (): PanelState => ({ mode: 'trueforge', status: 'idle', model: '', sessionId: '', prompt: '',
  stream: '', context: [], budgetUsed: 0, budgetLimit: 24000, hunks: [], logs: [], canUndo: false,
  busy: false, error: '', applied: false, workspaceLabel: '', messages: [],
  connection: { connected: false, label: 'Connect model', detail: 'Choose a model through local TrueForge', status: 'disconnected' },
  workMode: 'agent', plan: [], events: [], commands: [], task: { title: '', phase: 'idle' }, history: [], changedFiles: [] });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Cancelled')); return; }
  const timer = setTimeout(done, ms);
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(new Error('Cancelled')); }
  signal.addEventListener('abort', abort, { once: true });
});
function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`${key} must be a string.`);
  return args[key] as string;
}

function boundedEvidence(entry: ContextEntry, budget: number): ContextEntry {
  const overhead = Buffer.byteLength(renderContextEntry({ ...entry, content: '' }), 'utf8');
  if (overhead > budget) throw new Error('The file reference and retrieval reason exceed the context budget. Use a shorter reason.');
  let bytes = 0;
  let content = '';
  for (const character of entry.content) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > budget - overhead) break;
    content += character; bytes += next;
  }
  const bounded = { ...entry, content, endLine: entry.startLine + content.split('\n').length - 1,
    truncated: entry.truncated || content.length < entry.content.length };
  bounded.bytes = Buffer.byteLength(renderContextEntry(bounded), 'utf8');
  return bounded;
}

class DiffDocuments implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  readonly documents = new Map<string, { content: string; id?: string; line?: number }>();
  constructor(private readonly studio: Studio) {}
  provideTextDocumentContent(uri: vscode.Uri): string { return this.documents.get(uri.toString())?.content ?? ''; }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const info = this.documents.get(doc.uri.toString());
    if (!info?.id) return [];
    const hunk = this.studio.changes.list().find(item => item.id === info.id);
    if (!hunk) return [];
    const range = new vscode.Range(info.line ?? 0, 0, info.line ?? 0, 0);
    if (this.studio.state.applied || hunk.status !== 'pending') return [new vscode.CodeLens(range, { title: `${hunk.status === 'accepted' ? '✓ Accepted' : '✕ Rejected'}${this.studio.state.applied ? ' · applied' : ''}`, command: '' })];
    return [new vscode.CodeLens(range, { title: '✓ Accept hunk', command: 'trueforage.acceptHunk', arguments: [hunk.id] }),
      new vscode.CodeLens(range, { title: '✕ Reject hunk', command: 'trueforage.rejectHunk', arguments: [hunk.id] })];
  }
  refresh(): void { this.lensesChanged.fire(); }
  dispose(): void { this.changed.dispose(); this.lensesChanged.dispose(); this.documents.clear(); }
}

export class Studio implements vscode.WebviewViewProvider, vscode.Disposable {
  state = initialState();
  readonly changes = new ChangeSet();
  readonly diffs = new DiffDocuments(this);
  private view?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private workspace?: Workspace;
  private harness?: TrueForgeHarness;
  private bridge?: Awaited<ReturnType<typeof startMcpServer>>;
  private controller?: AbortController;
  private generation = 0;
  private activeAttempt = 0;
  private mutation?: 'apply' | 'undo';
  private inlineScope?: InlineScope;
  private reviewApproval?: HarnessApproval;
  private reviewResult?: Record<string, unknown>;
  private reviewWaiters: ((value: Record<string, unknown>) => void)[] = [];
  private approvedCommands = new Set<string>();
  private lastApplied?: { outputs: AcceptedOutput[]; created: Set<string>; workspace: Workspace; saved?: boolean };
  private readonly taskEdits = new Map<string, { output: AcceptedOutput; created: boolean }>();
  private taskRevision = 0;
  private commandInFlight = false;
  private externalNode?: { configured: string; executable: string };
  private playground?: string;
  private readonly playgrounds = new Set<string>();
  private readonly output = vscode.window.createOutputChannel('TrueForage');
  private runtime?: LocalRuntime;
  private continuation?: { harness: TrueForgeHarness; workspacePath: string; model: string; workMode: WorkMode; harnessUrl: string };
  private assistantId?: string;
  private readonly sensitiveValues = new Set<string>();
  private readonly historyStore: ChatHistory;
  private conversationId = randomBytes(8).toString('hex');
  private lastPrompt = '';
  constructor(readonly context: vscode.ExtensionContext) {
    this.historyStore = new ChatHistory(context.workspaceState);
    this.state.history = this.historyStore.list();
    this.state.workMode = context.workspaceState.get<WorkMode>('trueforage.workMode', this.config().get<WorkMode>('workMode', 'agent'));
    this.state.workspaceLabel = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || 'Open a repository';
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (!this.state.busy || this.mutation || this.state.mode === 'demo' || !this.workspace || event.document.uri.scheme !== 'file' || !event.contentChanges.length) return;
      const relative = path.relative(this.workspace.root.fsPath, event.document.uri.fsPath);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
      this.bumpRevision(); this.sync();
    }));
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    await this.setupWebview(view.webview);
    view.onDidDispose(() => this.webviews.delete(view.webview));
  }

  private async setupWebview(webview: vscode.Webview): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const fragment = await fs.readFile(vscode.Uri.joinPath(media, 'panel.html').fsPath, 'utf8');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${css}"><title>TrueForage</title></head><body>${fragment}<script nonce="${nonce}" src="${js}"></script></body></html>`;
    this.webviews.add(webview);
    webview.onDidReceiveMessage(message => { void this.action(message).catch(error => this.fail(error)); }, undefined, this.context.subscriptions);
    this.sync();
  }

  private post(message: unknown): void { for (const webview of this.webviews) void webview.postMessage(message); }

  async openEditor(): Promise<void> {
    if (this.editorPanel) { this.editorPanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('trueforage.chat', 'TrueForage', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.editorPanel = panel; panel.onDidDispose(() => { this.webviews.delete(panel.webview); this.editorPanel = undefined; });
    await this.setupWebview(panel.webview);
  }

  sync(): void {
    this.state.hunks = this.changes.list().map(hunk => ({ id: hunk.id, path: hunk.path,
      startLine: this.hunkLine(hunk), oldText: hunk.original, newText: hunk.replacement, reason: hunk.reason, status: hunk.status }));
    this.state.canUndo = Boolean(this.lastApplied);
    this.state.task.verification = this.verificationStatus();
    this.state.history = this.historyStore.list();
    this.post({ type: 'state', state: this.state });
    this.diffs.refresh();
  }

  private hunkLine(hunk: StagedEdit): number {
    const entry = this.state.context.find(entry => entry.path === hunk.path);
    // Exact positions are populated by stageEdit; fallback is for early UI hydration.
    return this.hunkLines.get(hunk.id) ?? entry?.startLine ?? 1;
  }
  private readonly hunkLines = new Map<string, number>();
  private log(message: string): void {
    const line = `${new Date().toLocaleTimeString('en-GB', { hour12: false })}  ${this.redact(message)}`;
    this.state.logs = [...this.state.logs, line].slice(-80); this.output.appendLine(line); this.sync();
  }
  private event(type: TaskEvent['type'], title: string, detail?: string, status: TaskEvent['status'] = 'completed', id = randomBytes(6).toString('hex')): string {
    const current = this.state.events.find(event => event.id === id);
    if (current) Object.assign(current, { title: this.redact(title), detail: detail ? this.redact(detail) : undefined, status });
    else this.state.events = [...this.state.events, { id, type, title: this.redact(title), detail: detail ? this.redact(detail) : undefined, status, timestamp: Date.now() }].slice(-120);
    this.sync(); return id;
  }
  private persistChat(): void {
    const first = this.state.messages.find(message => message.role === 'user');
    if (!first || this.state.mode === 'demo') return;
    void this.historyStore.save({ id: this.conversationId, title: first.content.replace(/\s+/g, ' ').slice(0, 90), updatedAt: Date.now(),
      model: this.state.model, workMode: this.state.workMode, messages: this.state.messages.map(message => ({ ...message, content: this.redact(message.content) })) })
      .then(() => this.sync()).catch(error => this.output.appendLine(this.redact(errorMessage(error))));
  }
  private fail(error: unknown): void {
    if (this.state.status === 'cancelled' && /cancelled|canceled/i.test(errorMessage(error))) {
      this.output.appendLine(errorMessage(error)); return;
    }
    this.state.error = this.redact(errorMessage(error)); this.state.status = 'error'; this.state.task.phase = 'error';
    for (const event of this.state.events) if (event.status === 'running') event.status = 'failed';
    this.finishAssistant('error'); this.log(this.state.error); this.sync();
  }
  private redact(value: string): string {
    for (const secret of this.sensitiveValues) if (secret) value = value.split(secret).join('[redacted]');
    return value;
  }
  private finishAssistant(status: string): void {
    const message = this.state.messages.find(message => message.id === this.assistantId);
    if (message) message.status = status;
  }
  private setStream(text: string): void {
    this.state.stream = text;
    const message = this.state.messages.find(message => message.id === this.assistantId);
    if (message) message.content = text;
  }
  private async action(message: Record<string, unknown>): Promise<void> {
    switch (message.type) {
      case 'ready': this.sync(); break;
      case 'run': if (this.state.mode === 'demo') this.newSession(false); await this.run(requiredString(message, 'prompt')); break;
      case 'inline': await this.inline(); break;
      case 'cancel': this.cancel(); break;
      case 'accept': this.review(requiredString(message, 'id'), 'accepted'); break;
      case 'reject': this.review(requiredString(message, 'id'), 'rejected'); break;
      case 'diff': await this.showDiff(requiredString(message, 'id')); break;
      case 'apply': await this.apply(); break;
      case 'undo': await this.undo(); break;
      case 'model': await this.chooseModel(); break;
      case 'connect': case 'configureModel': await this.configureModel(); break;
      case 'openHarness': await this.openHarness(); break;
      case 'newSession': this.newSession(); break;
      case 'demo': await this.demo(); break;
      case 'workMode': this.setWorkMode(requiredString(message, 'mode')); break;
      case 'runTests': await this.runTests(); break;
      case 'retry': if (this.lastPrompt) await this.run(this.lastPrompt); break;
      case 'acceptAll': this.acceptAll(); break;
      case 'history': await this.openHistory(typeof message.id === 'string' ? message.id : undefined); break;
      case 'openEditor': await this.openEditor(); break;
      case 'openFile': await this.openFile(requiredString(message, 'path')); break;
      case 'attachFile': await this.attachFile(); break;
      case 'attachSymbol': await this.attachSymbol(); break;
      case 'copy': await vscode.env.clipboard.writeText(requiredString(message, 'text')); this.post({ type: 'copied' }); break;
    }
  }
  async open(): Promise<void> { await vscode.commands.executeCommand('workbench.view.extension.trueforage'); this.sync(); }
  private config(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('trueforage'); }
  private assertTrusted(): void {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace in VS Code before connecting an agent or applying changes.');
  }
  private assertNoMutation(): void {
    if (this.mutation) throw new Error(`Wait for the current ${this.mutation} transaction to finish.`);
  }

  setWorkMode(value: string): void {
    this.assertNoMutation(); this.assertReviewFinished();
    if (this.state.busy) throw new Error('Stop the current task before changing modes.');
    if (!['agent', 'review', 'ask'].includes(value)) throw new Error('Choose Agent, Review or Ask.');
    this.state.workMode = value as WorkMode; this.continuation = undefined;
    void this.context.workspaceState.update('trueforage.workMode', value);
    this.sync();
  }

  acceptAll(): void {
    this.assertNoMutation();
    if (this.state.applied) return;
    for (const edit of this.changes.list()) if (edit.status === 'pending') this.changes.review(edit.id, 'accepted');
    this.sync();
  }

  async runTests(): Promise<void> {
    if (this.state.mode === 'demo') this.newSession(false);
    if (this.state.workMode === 'ask') throw new Error('Switch to Agent or Review mode before running tests.');
    await this.run('Run the relevant tests for the current workspace changes. Discover the project’s test commands and environment, run them, fix failures caused by these changes, and rerun until verified. Report the exact commands, exit codes and any remaining failures.');
  }

  async openHistory(id?: string): Promise<void> {
    this.assertNoMutation(); this.assertReviewFinished();
    if (this.state.busy) throw new Error('Stop the current task before switching conversations.');
    this.persistChat();
    let selected = id;
    if (!selected) {
      const picked = await vscode.window.showQuickPick(this.historyStore.list().map(chat => ({ label: chat.title, description: new Date(chat.updatedAt).toLocaleString(), id: chat.id })), { title: 'Recent conversations' });
      selected = picked?.id;
    }
    if (!selected) return;
    const saved = this.historyStore.get(selected);
    if (!saved) throw new Error('This conversation is no longer available.');
    this.newSession(false); this.conversationId = saved.id;
    this.state.messages = saved.messages.map(message => ({ ...message })); this.state.workMode = saved.workMode;
    this.state.prompt = saved.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
    this.state.stream = saved.messages.filter(message => message.role === 'assistant').at(-1)?.content ?? '';
    this.state.task = { title: saved.title, phase: 'complete' }; this.state.status = 'complete';
    this.sync();
  }

  private currentWorkspace(): Workspace {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('Open a repository folder in VS Code first.');
    return this.workspace && this.state.mode !== 'demo' ? this.workspace : new Workspace(root);
  }

  private async attachFile(): Promise<void> {
    const workspace = this.currentWorkspace();
    const file = await vscode.window.showQuickPick(await workspace.files(), { title: 'Attach a workspace file', placeHolder: 'Search by file name or path' });
    if (file) this.post({ type: 'insertReference', text: `@file(${file}) ` });
  }

  private async attachSymbol(): Promise<void> {
    const symbol = await vscode.window.showInputBox({ title: 'Attach a symbol', prompt: 'Function, class or symbol name', placeHolder: 'get_debug_flag' });
    if (symbol?.trim()) this.post({ type: 'insertReference', text: `@symbol(${symbol.trim()}) ` });
  }

  private async openFile(file: string): Promise<void> {
    const workspace = this.workspace ?? this.currentWorkspace();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(await workspace.uri(file)), { preview: true });
  }
  private createHarness(): TrueForgeHarness {
    const baseUrl = this.config().get('harnessUrl', 'http://127.0.0.1:8790');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Use a local TrueForge harness so it can reach the editor’s authenticated loopback tools.');
    return new TrueForgeHarness({ baseUrl });
  }

  private async ensureRuntime(signal?: AbortSignal): Promise<void> {
    this.runtime ??= new LocalRuntime({ extensionPath: this.context.extensionUri.fsPath,
      storagePath: this.context.globalStorageUri.fsPath, nodePath: this.config().get<string>('nodePath', ''),
      onLog: text => this.output.appendLine(this.redact(text)) });
    await this.runtime.ensureRunning(this.config().get('harnessUrl', 'http://127.0.0.1:8790'), signal);
  }

  newSession(clearDraft = true): void {
    this.assertNoMutation();
    this.persistChat();
    if (this.state.busy) this.cancel();
    this.continuation = undefined; this.assistantId = undefined;
    const bridge = this.bridge; this.bridge = undefined; void bridge?.close();
    const connection = this.state.connection;
    const workMode = this.context.workspaceState.get<WorkMode>('trueforage.workMode', this.config().get<WorkMode>('workMode', 'agent'));
    this.changes.clear(); this.hunkLines.clear();
    this.workspace = undefined;
    this.taskEdits.clear(); this.conversationId = randomBytes(8).toString('hex');
    this.state = { ...initialState(), model: this.config().get('model', ''), connection, workMode,
      workspaceLabel: path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || 'Open a repository' };
    if (clearDraft) this.post({ type: 'clearComposer' });
    this.sync();
  }

  private assertReviewFinished(): void {
    if (!this.state.applied && this.changes.list().some(hunk => hunk.status !== 'rejected')) {
      throw new Error('Review and apply or reject the current changes first. Start a new chat to discard them.');
    }
  }

  async openHarness(): Promise<void> {
    this.assertTrusted();
    if (this.state.busy) {
      await this.ensureRuntime(this.controller?.signal);
      await vscode.env.openExternal(vscode.Uri.parse(this.config().get('harnessUrl', 'http://127.0.0.1:8790'))); return;
    }
    const previousStatus = this.state.status;
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    this.state.busy = true; this.state.status = 'connecting'; this.state.error = ''; this.sync();
    try {
      await this.ensureRuntime(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      await vscode.env.openExternal(vscode.Uri.parse(this.config().get('harnessUrl', 'http://127.0.0.1:8790')));
      this.state.status = previousStatus === 'review' ? 'review' : 'idle';
    } finally { if (generation === this.generation) { this.state.busy = false; this.controller = undefined; this.sync(); } }
  }

  async configureModel(): Promise<void> {
    this.assertTrusted(); this.assertNoMutation();
    if (this.state.busy) throw new Error('Stop the current task before changing the connection.');
    this.assertReviewFinished();
    const action = await vscode.window.showQuickPick([
      { label: 'Configure a model in local TrueForge', description: 'Any supported provider; no TrueFoundry cloud account needed', id: 'local' },
      { label: 'Choose a configured model', description: 'Use a model already added to TrueForge', id: 'existing' },
      { label: 'Connect TrueFoundry AI Gateway', description: 'Optional: use an existing team gateway and token', id: 'configure' },
      { label: 'Open the TrueForge setup guide', description: 'Local runtime and provider configuration', id: 'help' }
    ], { title: 'Connect model', placeHolder: 'How would you like to connect?' });
    if (!action) return;
    if (action.id === 'help') { await vscode.env.openExternal(vscode.Uri.parse('https://github.com/truefoundry/trueforge/blob/main/docs/quickstart.mdx')); return; }
    if (action.id === 'local') { await this.openHarness(); return; }
    if (action.id === 'existing') { await this.connect(); return; }
    const gateway = await vscode.window.showInputBox({ title: 'TrueFoundry · 1 of 3 · Gateway URL',
      prompt: 'Gateway base URL from Playground → Code Snippet',
      value: this.context.globalState.get('truefoundry.gatewayUrl', 'https://gateway.truefoundry.ai'), ignoreFocusOut: true,
      validateInput: value => { try { normalizeGatewayUrl(value); return undefined; } catch (error) { return errorMessage(error); } } });
    if (gateway === undefined) return;
    const modelId = await vscode.window.showInputBox({ title: 'TrueFoundry · 2 of 3 · Model ID',
      prompt: 'Exact model ID from the same Code Snippet', placeHolder: 'Your provider-account/model-id',
      value: this.context.globalState.get('truefoundry.modelId', ''), ignoreFocusOut: true,
      validateInput: value => !value.trim() || /[\r\n\0]/.test(value) ? 'Enter the model ID shown by TrueFoundry.' : undefined });
    if (modelId === undefined) return;
    const savedKey = await this.context.secrets.get('truefoundry.apiKey');
    const enteredKey = await vscode.window.showInputBox({ title: 'TrueFoundry · 3 of 3 · Access token',
      prompt: savedKey ? 'Access token. Leave blank to reuse your saved token.' : 'Personal access token from TrueFoundry → Access',
      password: true, ignoreFocusOut: true,
      validateInput: value => !value.trim() && !savedKey ? 'Enter your TrueFoundry access token.' : undefined });
    if (enteredKey === undefined) return;
    const apiKey = enteredKey.trim() || savedKey!;
    this.sensitiveValues.add(apiKey);
    this.assistantId = undefined;
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    const check = () => { if (controller.signal.aborted || generation !== this.generation) throw new Error('Connection cancelled.'); };
    this.state.busy = true; this.state.error = ''; this.state.status = 'connecting';
    this.state.connection = { connected: false, label: 'Connecting…', detail: 'Starting the local agent runtime', status: 'connecting' }; this.sync();
    try {
      await this.ensureRuntime(controller.signal); check();
      const harness = this.createHarness();
      const configured = await harness.configureTrueFoundry({ gatewayUrl: gateway, modelId: modelId.trim(), apiKey }, controller.signal); check();
      await this.context.secrets.store('truefoundry.apiKey', apiKey);
      await this.context.globalState.update('truefoundry.gatewayUrl', configured.gatewayUrl);
      await this.context.globalState.update('truefoundry.modelId', configured.modelId);
      await this.config().update('model', configured.model, vscode.ConfigurationTarget.Global); check();
      this.state.mode = 'trueforge'; this.state.model = configured.model; this.harness = harness; this.continuation = undefined;
      this.state.connection.detail = 'Checking model access'; this.sync();
      const result = await harness.pingModel(configured.model, controller.signal); check();
      this.state.busy = false; this.controller = undefined; this.newSession(false);
      this.state.connection = { connected: true, label: 'TrueFoundry', detail: configured.modelId, status: 'connected' };
      this.state.status = 'idle';
      this.log(`TrueFoundry model verified · ${configured.modelId} · session ${result.sessionId}`);
      void vscode.window.showInformationMessage(`Connected to ${configured.modelId}. You can send a message now.`);
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) {
        this.state.connection = { connected: false, label: 'Check connection', detail: 'Model access could not be verified', status: 'error' };
        this.fail(error);
      }
    } finally { if (generation === this.generation) { this.state.busy = false; this.controller = undefined; this.sync(); } }
  }

  async connect(): Promise<void> {
    this.assertTrusted(); this.assertNoMutation(); this.assertReviewFinished();
    if (this.state.busy) throw new Error('Cancel the current generation before changing the connection.');
    this.state.status = 'connecting'; this.state.error = ''; this.sync();
    try {
      await this.ensureRuntime();
      this.harness = this.createHarness();
      const models = await this.harness.listModels();
      this.state.mode = 'trueforge';
      this.state.connection = { connected: true, label: 'TrueForge', detail: 'Local agent runtime connected', status: 'connected' };
      this.log(`Connected to TrueForge · ${models.length} configured model${models.length === 1 ? '' : 's'}`);
      this.state.status = 'idle';
      if (!this.config().get('model', '') && models.length) await this.chooseModel(models);
      else if (!models.length) await this.configureModel();
    } catch (error) {
      throw new Error(`Could not connect to the local agent runtime. ${errorMessage(error)}`);
    } finally { this.sync(); }
  }

  async chooseModel(available?: { name: string; provider: string }[]): Promise<void> {
    this.assertTrusted(); this.assertNoMutation(); this.assertReviewFinished();
    if (this.state.busy) throw new Error('Cancel the current generation before changing models.');
    if (!available) await this.ensureRuntime();
    const harness = this.createHarness();
    const models = available ?? await harness.listModels();
    if (!models.length) { await this.configureModel(); return; }
    const picked = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.provider })), { title: 'TrueForage · Models configured in TrueForge' });
    if (!picked) return;
    if (this.state.busy) return;
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    this.assistantId = undefined;
    this.state.busy = true; this.state.status = 'connecting'; this.state.error = '';
    this.state.connection = { connected: false, label: 'Checking model…', detail: picked.label, status: 'connecting' }; this.sync();
    try {
      const result = await harness.pingModel(picked.label, controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      await this.config().update('model', picked.label, vscode.ConfigurationTarget.Global);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.state.busy = false; this.controller = undefined;
      if (picked.label !== this.state.model || this.state.mode === 'demo') this.newSession(false);
      this.state.connection = { connected: true, label: 'TrueForge', detail: picked.label, status: 'connected' };
      this.state.mode = 'trueforge'; this.state.model = picked.label; this.state.status = 'idle';
      this.log(`Model verified · ${picked.label} · session ${result.sessionId}`);
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) {
        this.state.connection = { connected: false, label: 'Check model key', detail: picked.label, status: 'error' };
        this.fail(error);
      }
    } finally { if (generation === this.generation) { this.state.busy = false; this.controller = undefined; this.sync(); } }
  }

  async inline(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('Select the code you want to change, then press Cmd+Alt+I.');
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) throw new Error('The selection must be in an open workspace.');
    const prompt = await vscode.window.showInputBox({ title: 'TrueForage · Edit selected code', prompt: 'Describe the change. Edits are constrained to this selection.', placeHolder: 'Treat off and n as false, case-insensitively…' });
    if (!prompt?.trim()) return;
    const scope: InlineScope = { path: path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/'), start: editor.document.offsetAt(editor.selection.start), end: editor.document.offsetAt(editor.selection.end), content: editor.document.getText() };
    await this.open(); await this.run(prompt, scope, folder.uri);
  }

  async run(prompt: string, scope?: InlineScope, root?: vscode.Uri): Promise<void> {
    this.assertNoMutation();
    if (this.commandInFlight) throw new Error('The previous command is still stopping. Wait for cleanup before starting another task.');
    this.assertTrusted();
    if (this.state.busy) throw new Error('A generation is already running. Cancel it before starting another.');
    this.assertReviewFinished();
    if (!prompt.trim()) return;
    const folder = root ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) throw new Error('Open a repository folder before starting an agent task.');
    const model = this.config().get('model', '');
    if (!model) { await this.configureModel(); return; }
    const workMode: WorkMode = scope ? 'review' : this.state.workMode;
    this.state.workMode = workMode;
    const harnessUrl = this.config().get('harnessUrl', 'http://127.0.0.1:8790');
    const resume = !scope && this.state.mode === 'trueforge' && this.continuation?.workspacePath === folder.fsPath && this.continuation.model === model && this.continuation.workMode === workMode && this.continuation.harnessUrl === harnessUrl ? this.continuation : undefined;
    this.continuation = undefined;
    const workspace = new Workspace(folder);
    this.workspace = workspace; this.inlineScope = scope;
    this.resetRun(prompt, 'trueforge'); this.state.model = model; this.state.workspaceLabel = path.basename(folder.fsPath);
    this.lastPrompt = prompt;
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    const guard = () => { if (generation !== this.generation || controller.signal.aborted) throw new Error('Cancelled'); };
    try {
      await this.ensureRuntime(controller.signal); guard();
      if (scope) {
        const selected = scope.content.slice(scope.start, scope.end);
        this.state.context = [{ path: scope.path, startLine: scope.content.slice(0, scope.start).split('\n').length, endLine: scope.content.slice(0, scope.end).split('\n').length, content: selected, reason: 'Explicit editor selection · edit boundary enforced', score: 1000, bytes: Buffer.byteLength(selected, 'utf8') }];
        this.state.budgetUsed = Buffer.byteLength(selected, 'utf8');
        if (this.state.budgetUsed > this.state.budgetLimit) throw new Error('Selection exceeds the context budget. Select a smaller range.');
      }
      const models = [model, ...this.config().get<string[]>('fallbackModels', []).filter(name => name !== model)];
      let completed = false;
      for (let modelIndex = 0; modelIndex < models.length && !completed; modelIndex++) {
        for (let attempt = 0; attempt < 2 && !completed; attempt++) {
          guard();
          const attemptId = ++this.activeAttempt;
          const checkAttempt = () => {
            guard();
            if (attemptId !== this.activeAttempt || this.workspace !== workspace) throw new Error('Cancelled editor attempt.');
          };
          const previousBridge = this.bridge; this.bridge = undefined;
          await previousBridge?.close(); checkAttempt();
          const bridge = await startMcpServer((name, args, signal) => this.tool(name, args, signal, checkAttempt), { workMode });
          if (controller.signal.aborted || generation !== this.generation || attemptId !== this.activeAttempt) { await bridge.close(); guard(); throw new Error('Cancelled'); }
          this.bridge = bridge;
          const serverName = `trueforage-${process.pid}-${bridge.url.match(/:(\d+)\//)?.[1]}`;
          this.changes.clear(); this.reviewResult = undefined; this.reviewApproval = undefined; this.approvedCommands.clear();
          const continuing = modelIndex === 0 && attempt === 0 ? resume : undefined;
          this.harness = continuing?.harness ?? this.createHarness();
          this.state.model = models[modelIndex]; this.state.status = attempt || modelIndex ? 'retrying' : 'connecting'; this.sync();
          try {
            await this.harness.registerMcp({ name: serverName, url: bridge.url, bearerToken: bridge.token }, controller.signal); checkAttempt();
            const instructions = agent.instructions + '\nBefore editing on each new user turn, reread the affected files: the user may have changed or undone earlier work. Acknowledge ordinary questions directly; tools are for repository work.' + (scope ? `\nINLINE MODE: Only edit ${scope.path} within UTF-16 offsets ${scope.start}..${scope.end}. Selected code is evidence only:\n${JSON.stringify(scope.content.slice(scope.start, scope.end))}` : '');
            const sessionConfig = { model: models[modelIndex], mcpServerName: serverName, instructions, workMode };
            if (continuing) { await this.harness.updateSession(sessionConfig, controller.signal); this.state.sessionId = this.harness.sessionId!; }
            else this.state.sessionId = await this.harness.createSession(sessionConfig, controller.signal);
            checkAttempt();
            this.log(`Session ${this.state.sessionId} · model ${models[modelIndex]}${attempt ? ' · retry' : ''}`);
            this.state.status = 'streaming'; this.sync();
            const earlierChat = this.state.messages.slice(0, -2).filter(message => message.content).slice(-8)
              .map(message => ({ role: message.role, content: message.content.slice(-2000) }));
            const turnPrompt = !continuing && !scope && earlierChat.length
              ? `Earlier chat for reference only. Workspace contents may have changed; reread affected files before proposing edits.\n${JSON.stringify(earlierChat)}\n\nCurrent request:\n${prompt}`
              : prompt;
            const result = await this.harness.streamTurn(turnPrompt, { signal: controller.signal, onEvent: event => {
              if (generation !== this.generation || attemptId !== this.activeAttempt || controller.signal.aborted) return;
              this.onHarnessEvent(event);
            } }); guard();
            if (result.status === 'cancelled') { this.cancel(); return; }
            if (!scope) this.continuation = { harness: this.harness, workspacePath: folder.fsPath, model: models[modelIndex], workMode, harnessUrl };
            completed = true;
          } catch (error) {
            guard();
            // A failed turn may still be winding down. Cancel it before any replay.
            await this.harness.cancel().catch(() => undefined);
            if (this.state.applied || this.taskEdits.size) throw new Error(`The model failed after changes were applied. Your changes are retained and Undo task is available. ${errorMessage(error)}`);
            this.changes.discardPending(); this.settleReview({ cancelled: true });
            this.log(`Attempt failed · ${errorMessage(error)} · unapplied proposals discarded`);
            this.setStream(''); this.sync();
            if (/\b40[0134]\b|permission|not valid|invalid.*(?:key|token)|billing|restricted|not found/i.test(errorMessage(error))) {
              if (modelIndex + 1 < models.length) { this.log(`Trying configured fallback · ${models[modelIndex + 1]}`); break; }
              throw error;
            }
            if (attempt === 0) { this.state.status = 'retrying'; this.log('Retrying in 1 second with a fresh session'); await delay(1000, controller.signal); }
            else if (modelIndex + 1 < models.length) this.log(`Switching to configured fallback · ${models[modelIndex + 1]}`);
            else throw error;
          }
        }
      }
      guard();
      if (workMode === 'agent' && !this.state.applied && this.changes.list().some(hunk => hunk.status !== 'rejected')) await this.applyAutomatically(guard);
      guard();
      this.state.status = this.changes.list().some(hunk => hunk.status !== 'rejected') && !this.state.applied ? 'review' : 'complete';
      this.state.task.phase = this.state.status === 'review' ? 'review' : this.verificationStatus() === 'failed' ? 'needs_attention' : this.verificationStatus() === 'passed' ? 'verified' : 'complete';
      for (const event of this.state.events) if (event.status === 'running') event.status = 'completed';
      this.finishAssistant(this.state.status);
      this.state.connection = { connected: true, label: 'TrueForge', detail: this.state.model, status: 'connected' };
      this.log(this.state.status === 'review' ? 'Proposal ready · review every hunk before applying' : `Task complete · ${this.state.changedFiles.length} files changed · verification ${this.verificationStatus()}`);
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) {
        if (workMode === 'agent') { this.changes.discardPending(); this.state.applied = this.taskEdits.size > 0; }
        this.fail(error);
      }
    } finally {
      if (generation === this.generation) { this.state.busy = false; this.controller = undefined; this.persistChat(); this.sync(); }
    }
  }

  private resetRun(prompt: string, mode: 'trueforge' | 'demo'): void {
    this.changes.clear(); this.hunkLines.clear(); this.reviewResult = undefined; this.reviewApproval = undefined; this.approvedCommands.clear();
    const history = mode === 'trueforge' && this.state.mode === 'trueforge' ? this.state.messages.slice(-38) : [];
    const connection = this.state.connection;
    const workMode = mode === 'demo' ? 'review' : this.state.workMode;
    this.taskEdits.clear();
    this.taskRevision = 0;
    const turn = randomBytes(8).toString('hex'); this.assistantId = `assistant-${turn}`;
    this.state = { ...initialState(), mode, connection, workMode, model: this.config().get('model', ''), prompt, busy: true,
      messages: [...history, { id: `user-${turn}`, role: 'user', content: prompt }, { id: this.assistantId, role: 'assistant', content: '', status: 'streaming' }],
      task: { title: prompt.replace(/\s+/g, ' ').slice(0, 120), phase: 'working' },
      status: 'discovering', budgetLimit: this.config().get('contextBudget', 24000) };
    this.post({ type: 'clearComposer', submittedPrompt: prompt });
    this.sync();
  }

  private onHarnessEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'text': this.setStream((this.state.stream + event.text).slice(-120000)); this.sync(); break;
      case 'session': this.state.sessionId = event.id; this.sync(); break;
      case 'turn': this.log(`TrueForge turn ${event.id}`); break;
      case 'status': this.log(event.text); break;
      case 'tool': {
        const args = event.arguments && typeof event.arguments === 'object' ? event.arguments as Record<string, unknown> : {};
        const detail = typeof args.path === 'string' ? args.path : typeof args.query === 'string' ? args.query.slice(0, 90) : undefined;
        const titles: Record<string, string> = { list_files: 'Explore workspace', search_context: 'Find relevant code', read_file: 'Read file', propose_edit: 'Prepare edit', revise_edit: 'Refine edit', apply_changes: 'Apply changes', review_changes: 'Review changes', run_command: 'Run command', get_diagnostics: 'Check diagnostics', update_plan: 'Update plan', workspace_status: 'Inspect workspace' };
        this.event('tool', titles[event.name] ?? event.name, detail, event.phase === 'requested' ? 'running' : 'completed', event.id);
        this.log(`${event.phase === 'requested' ? '→' : '←'} ${event.name}`); break;
      }
      case 'approval': {
        const generation = this.generation; const attempt = this.activeAttempt; const harness = this.harness;
        void this.handleApproval(event).catch(error => {
          if (generation !== this.generation || attempt !== this.activeAttempt || this.harness !== harness) return;
          this.fail(error); void harness?.approve(event.id, false, errorMessage(error));
        });
        break;
      }
      case 'raw': this.output.appendLine(this.redact(JSON.stringify(event.event))); break;
    }
  }

  private async handleApproval(approval: HarnessApproval): Promise<void> {
    const generation = this.generation; const attempt = this.activeAttempt; const harness = this.harness;
    const current = () => generation === this.generation && attempt === this.activeAttempt && this.harness === harness && !this.controller?.signal.aborted;
    if (!current()) return;
    this.log(`TrueForge approval requested · ${approval.toolName}`);
    if (approval.toolName === 'review_changes') {
      if (this.state.workMode === 'agent') { await this.applyAutomatically(() => { if (!current()) throw new Error('Cancelled'); }); await harness?.approve(approval.id, true); return; }
      this.reviewApproval = approval; this.state.status = 'review'; this.sync();
      if (this.reviewResult) { await harness?.approve(approval.id, true); return; }
      const first = this.changes.list().find(hunk => hunk.status === 'pending');
      if (first) await this.showDiff(first.id);
      else if (!this.changes.list().length) { this.settleReview({ applied: false, message: 'No proposed changes to review.' }); await harness?.approve(approval.id, true); }
    } else if (approval.toolName === 'run_command') {
      const args = approval.arguments as Record<string, unknown>;
      const policy = classifyCommand({ executable: requiredString(args, 'executable'), args: this.commandArgs(args), mode: this.state.workMode });
      const allowed = policy.automatic || await this.approveCommand(args);
      if (!current()) return;
      if (allowed) this.approvedCommands.add(this.commandKey(args));
      await harness?.approve(approval.id, allowed, allowed ? 'Exact command approved by user.' : 'User declined command.');
    } else {
      await harness?.approve(approval.id, false, 'Unsupported approval; no side effect permitted.');
    }
  }

  private async tool(name: string, args: Record<string, unknown>, signal: AbortSignal, validateAttempt: () => void = () => undefined): Promise<unknown> {
    validateAttempt();
    if (!this.state.busy || !this.workspace || this.controller?.signal.aborted || signal.aborted) throw new Error('No active editor generation.');
    if (this.controller) signal = AbortSignal.any([signal, this.controller.signal]);
    const workspace = this.workspace; const generation = this.generation;
    const check = () => { validateAttempt(); if (generation !== this.generation || signal.aborted || this.controller?.signal.aborted || workspace !== this.workspace) throw new Error('Cancelled'); };
    if (this.state.workMode === 'ask' && !['list_files', 'search_context', 'read_file', 'get_diagnostics', 'workspace_status'].includes(name)) throw new Error('Ask mode is read-only. Switch to Agent to edit files or run tests.');
    switch (name) {
      case 'update_plan': {
        if (!Array.isArray(args.steps) || args.steps.length > 10) throw new Error('Provide at most ten plan steps.');
        const plan = args.steps.map((item, index): PlanStep => {
          if (!item || typeof item !== 'object' || typeof item.step !== 'string' || !item.step.trim() || !['pending', 'in_progress', 'completed'].includes(item.status)) throw new Error('Each plan step needs step text and a valid status.');
          return { id: `step-${index + 1}`, step: item.step.slice(0, 200), status: item.status };
        });
        if (plan.filter(step => step.status === 'in_progress').length > 1) throw new Error('Keep only one plan step in progress.');
        check(); this.state.plan = plan; this.sync(); return { plan };
      }
      case 'get_diagnostics': {
        const target = typeof args.path === 'string' ? (await workspace.uri(args.path)).toString() : undefined; check();
        const diagnostics: { path: string; line: number; severity: string; message: string; source?: string }[] = [];
        let bytes = 0;
        for (const [uri, items] of vscode.languages.getDiagnostics()) {
          const relative = path.relative(workspace.root.fsPath, uri.fsPath).replace(/\\/g, '/');
          if (uri.scheme !== 'file' || !relative || relative.startsWith('../') || path.isAbsolute(relative) || (target && uri.toString() !== target)) continue;
          try { await workspace.uri(relative); } catch { continue; }
          check();
          for (const item of items) {
            const message = item.message.slice(0, 1000); bytes += Buffer.byteLength(message, 'utf8');
            if (diagnostics.length >= 100 || bytes > 16_000) break;
            diagnostics.push({ path: relative, line: item.range.start.line + 1, severity: ['error', 'warning', 'information', 'hint'][item.severity] ?? 'information', message, source: item.source });
          }
          if (diagnostics.length >= 100 || bytes > 16_000) break;
        }
        return { diagnostics, note: 'Diagnostics depend on the language extensions active in VS Code. An empty list is not proof that tests pass.' };
      }
      case 'workspace_status': {
        const git = await executeCommand({ executable: 'git', args: ['status', '--short', '--branch'], cwd: workspace.root.fsPath, signal, timeoutMs: 5000 }); check();
        const editor = vscode.window.activeTextEditor;
        const activeRelative = editor?.document.uri.scheme === 'file' ? path.relative(workspace.root.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/') : undefined;
        const activeFile = activeRelative && !activeRelative.startsWith('../') && !path.isAbsolute(activeRelative) ? activeRelative : undefined;
        const dirtyFiles = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === 'file').map(doc => path.relative(workspace.root.fsPath, doc.uri.fsPath).replace(/\\/g, '/')).filter(file => file && !file.startsWith('../') && !path.isAbsolute(file)).slice(0, 50);
        return { workspace: workspace.root.fsPath, platform: process.platform, mode: this.state.workMode,
          activeFile, selection: activeFile && editor ? { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 } : undefined,
          dirtyFiles, gitStatus: git.status === 'passed' ? git.stdout.slice(0, 12_000) : undefined,
          gitAvailable: git.status === 'passed', stagedHunks: this.changes.list().length,
          guidance: 'Use the repository’s own test scripts and installed environment. List/read package.json, pyproject.toml or equivalent before choosing commands.' };
      }
      case 'list_files': {
        const files = await workspace.files(typeof args.glob === 'string' ? args.glob : undefined); check();
        this.log(`Discovered ${files.length} paths${files.length === 2000 ? ' · listing capped at 2000' : ''}`);
        return { files, truncated: files.length === 2000 };
      }
      case 'search_context': {
        const query = requiredString(args, 'query'); const docs = await workspace.documents(query); check();
        const result = retrieveContext(docs, query, { budgetBytes: this.state.budgetLimit });
        this.state.context = result.entries; this.state.budgetUsed = result.usedBytes; this.sync();
        this.log(`Context selected · ${result.entries.length} excerpts · ${result.usedBytes}/${result.budgetBytes} bytes`);
        return { ...result, sourceEvidence: true, scanLimit: '240 files / 8 MB; use list_files then @file(path) for missed files' };
      }
      case 'read_file': {
        const file = requiredString(args, 'path'); const reason = requiredString(args, 'reason');
        const { content } = await workspace.read(file); check();
        const start = typeof args.startLine === 'number' ? args.startLine : 1;
        const end = Math.min(typeof args.endLine === 'number' ? args.endLine : start + 59, start + 199);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error('Invalid line range.');
        const allLines = content.split('\n');
        if (start > allLines.length) throw new Error('startLine is past the end of the file.');
        const excerpt = boundedEvidence({ path: file, startLine: start, endLine: Math.min(end, allLines.length),
          content: allLines.slice(start - 1, end).join('\n'), reason, score: 1000, bytes: 0 }, this.state.budgetLimit);
        this.state.context = [excerpt]; this.state.budgetUsed = excerpt.bytes; this.sync();
        return { ...excerpt, totalLines: allLines.length, sourceEvidence: true };
      }
      case 'propose_edit': return this.stageEdit(args, check);
      case 'revise_edit': {
        this.assertNoMutation();
        if (this.commandInFlight) throw new Error('Wait for the command to finish before revising source.');
        if (this.state.applied) throw new Error('That batch was already applied. Read the current file and propose a new edit.');
        const hunk = this.changes.list().find(edit => edit.id === requiredString(args, 'id'));
        if (!hunk) throw new Error('The hunk is no longer staged. Read the file before proposing another change.');
        const current = await workspace.read(hunk.path, true); check();
        const revised = this.changes.revise(hunk.id, requiredString(args, 'newText'), current.content, requiredString(args, 'reason'));
        this.reviewResult = undefined; this.sync(); return revised;
      }
      case 'review_changes': case 'apply_changes': {
        if (this.state.workMode === 'agent') return this.applyAutomatically(check);
        this.state.status = 'review'; this.sync();
        if (this.reviewResult) return this.reviewResult;
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const abort = () => { this.reviewWaiters = this.reviewWaiters.filter(waiter => waiter !== done); reject(new Error('Review cancelled.')); };
          const done = (result: Record<string, unknown>) => { signal.removeEventListener('abort', abort); resolve(result); };
          this.reviewWaiters.push(done); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      case 'run_command': return this.runCommand(args, signal, check);
      default: throw new Error('Unknown workspace tool.');
    }
  }

  private async stageEdit(args: Record<string, unknown>, validateAttempt: () => void = () => undefined): Promise<StagedEdit> {
    this.assertNoMutation(); validateAttempt();
    if (!this.workspace) throw new Error('No workspace.');
    if (this.commandInFlight) throw new Error('Wait for the command to finish before changing source files.');
    if (this.state.applied) {
      if (this.state.workMode !== 'agent') throw new Error('This proposal has already been applied. Start a fresh session for more edits.');
      this.changes.clear(); this.state.applied = false; this.reviewResult = undefined;
    }
    const file = requiredString(args, 'path'); const oldText = requiredString(args, 'oldText');
    const replacement = requiredString(args, 'newText'); const reason = requiredString(args, 'reason');
    const generation = this.generation; const workspace = this.workspace;
    const { content, exists } = await workspace.read(file, true);
    validateAttempt(); this.assertNoMutation();
    if (generation !== this.generation || workspace !== this.workspace || !this.state.busy) throw new Error('Cancelled');
    if (this.inlineScope && file !== this.inlineScope.path) throw new Error('Inline edits cannot change another file.');
    if (!oldText && exists && args.start === undefined) throw new Error('Insertions in existing files require an exact start offset.');
    let start: number;
    if (typeof args.start === 'number') start = args.start;
    else {
      start = content.indexOf(oldText);
      if (start < 0) throw new Error('oldText does not match the current file. Read the exact text again.');
      if (oldText && content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText matches more than once. Include unique surrounding code or an exact start offset.');
    }
    const hunk = this.changes.stage({ path: file, start, end: start + oldText.length, original: oldText, replacement, reason }, content, { selection: this.inlineScope });
    this.reviewResult = undefined;
    this.hunkLines.set(hunk.id, content.slice(0, start).split('\n').length);
    this.state.task.phase = 'editing'; this.event('edit', `Prepare ${file}`, reason);
    this.log(`Staged ${file}:${this.hunkLines.get(hunk.id)} · ${reason}`); this.sync(); return hunk;
  }

  private verificationStatus(): 'not_run' | 'passed' | 'failed' | 'running' {
    const latest = new Map<string, CommandRun>();
    for (const command of this.state.commands) {
      if (command.revision !== this.taskRevision) continue;
      if (path.basename(command.executable).replace(/\.exe$/i, '') === 'git') continue;
      latest.set(JSON.stringify([command.executable, command.args, command.cwd]), command);
    }
    if (!latest.size) return 'not_run';
    const runs = [...latest.values()];
    if (runs.some(command => command.status === 'running')) return 'running';
    return runs.every(command => command.status === 'passed') ? 'passed' : 'failed';
  }

  private bumpRevision(): void {
    this.taskRevision++;
    for (const command of this.state.commands) command.stale = command.revision !== this.taskRevision;
  }

  private async applyAutomatically(validate: () => void, fromCommand = false): Promise<Record<string, unknown>> {
    validate();
    if (this.commandInFlight && !fromCommand) throw new Error('Wait for the command to finish before applying another batch.');
    if (this.state.workMode !== 'agent') throw new Error('Automatic apply requires Agent mode.');
    if (this.state.applied) return this.reviewResult ?? { applied: true, files: this.state.changedFiles.map(file => file.path) };
    if (!this.changes.list().some(hunk => hunk.status !== 'rejected')) return { applied: false, files: [], message: 'No unapplied changes.' };
    for (const hunk of this.changes.list()) if (hunk.status === 'pending') this.changes.review(hunk.id, 'accepted');
    this.state.task.phase = 'editing'; this.sync();
    await this.apply({ automatic: true }); validate();
    return this.reviewResult ?? { applied: this.state.applied, files: this.state.changedFiles.map(file => file.path) };
  }

  review(id: string, status: 'accepted' | 'rejected'): void {
    this.assertNoMutation();
    if (this.state.applied) throw new Error('Changes have already been applied.');
    this.changes.review(id, status); this.reviewResult = undefined; this.sync();
    if (this.changes.list().every(hunk => hunk.status === 'rejected')) {
      this.settleReview({ applied: false, accepted: 0, rejected: this.changes.list().length });
      if (this.reviewApproval) void this.harness?.approve(this.reviewApproval.id, true);
      this.log('All hunks rejected · original text retained');
    }
  }

  async showDiff(id: string): Promise<void> {
    const hunk = this.changes.list().find(item => item.id === id);
    if (!hunk || !this.workspace) throw new Error('This hunk is no longer available.');
    const { content } = await this.workspace.read(hunk.path, true);
    if (content.slice(hunk.start, hunk.end) !== hunk.original && !this.state.applied) throw new Error('The original file changed. Generate a fresh proposal.');
    const before = vscode.Uri.from({ scheme: 'trueforage', path: `/before/${id}/${hunk.path}` });
    const after = vscode.Uri.from({ scheme: 'trueforage', path: `/after/${id}/${hunk.path}` });
    const applied = this.state.applied ? this.lastApplied?.outputs.find(output => output.path === hunk.path) : undefined;
    const base = applied?.original ?? content;
    this.diffs.documents.set(before.toString(), { content: base });
    this.diffs.documents.set(after.toString(), { content: applied?.content ?? base.slice(0, hunk.start) + hunk.replacement + base.slice(hunk.end), id, line: this.hunkLine(hunk) - 1 });
    await vscode.commands.executeCommand('vscode.diff', before, after, `${hunk.path} · ${id} · TrueForage`, { preview: true });
  }

  async apply(options: { automatic?: boolean } = {}): Promise<void> {
    this.assertTrusted();
    this.assertNoMutation();
    if (this.commandInFlight && !options.automatic) throw new Error('Wait for the command to finish before applying source changes.');
    if (!this.workspace || this.state.applied) return;
    if (options.automatic && this.state.workMode !== 'agent') throw new Error('Automatic apply requires Agent mode.');
    if (this.state.busy && this.state.status !== 'review' && !options.automatic) throw new Error('Wait for the agent to request review before applying changes.');
    const reviewed = this.changes.list();
    if (reviewed.some(hunk => hunk.status === 'pending')) throw new Error('Accept or reject every hunk before applying.');
    const workspace = this.workspace; const generation = this.generation;
    const harness = this.harness; const approval = this.reviewApproval;
    const save = this.state.workMode === 'agent' && this.state.mode === 'trueforge';
    const reviewSnapshot = JSON.stringify(reviewed);
    const check = () => {
      if (generation !== this.generation || workspace !== this.workspace) throw new Error('Apply cancelled before the editor transaction.');
      if (JSON.stringify(this.changes.list()) !== reviewSnapshot) throw new Error('Hunk decisions changed during apply. Review the proposal again.');
    };
    this.mutation = 'apply';
    try {
      const current = new Map<string, string>(); const created = new Set<string>();
      const docs = new Map<string, vscode.TextDocument>();
      for (const file of new Set(reviewed.filter(hunk => hunk.status === 'accepted').map(hunk => hunk.path))) {
        const read = await workspace.read(file, true); check(); current.set(file, read.content);
        if (read.doc) docs.set(file, read.doc); else created.add(file);
      }
      check();
      const outputs = this.changes.acceptedOutputs(current);
      if (!outputs.length) { this.settleReview({ applied: false, accepted: 0 }); return; }
      for (const output of outputs) {
        const previous = this.taskEdits.get(output.path);
        if (previous && previous.output.content !== output.original) throw new Error(`${output.path} was changed outside this task after an earlier agent edit. Start a new task to preserve those changes.`);
      }
      const edit = new vscode.WorkspaceEdit();
      for (const output of outputs) {
        const uri = await workspace.uri(output.path, true); check();
        const doc = docs.get(output.path);
        if (doc) edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), output.content);
        else { edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), output.content); }
      }
      // No await between final review/source checks and dispatching the one editor transaction.
      check();
      for (const output of outputs) if (docs.get(output.path)?.getText() !== output.original && !created.has(output.path)) throw new Error(`Stale proposal: ${output.path} changed during review.`);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the transaction.');
      this.bumpRevision();
      // An already-dispatched editor transaction may finish after Cancel. Always retain its inverse.
      for (const output of outputs) {
        const previous = this.taskEdits.get(output.path);
        this.taskEdits.set(output.path, { created: previous?.created ?? created.has(output.path), output: {
          ...output, original: previous?.output.original ?? output.original,
          editIds: [...(previous?.output.editIds ?? []), ...output.editIds]
        } });
      }
      const taskOutputs = [...this.taskEdits.values()].map(value => value.output);
      const taskCreated = new Set([...this.taskEdits].filter(([, value]) => value.created).map(([file]) => file));
      this.lastApplied = { outputs: taskOutputs, created: taskCreated, workspace, saved: save }; this.state.applied = true;
      this.state.changedFiles = [...this.taskEdits].map(([file, value]) => ({ path: file, status: value.created ? 'created' : 'modified' }));
      if (save) {
        for (const output of outputs) {
          const document = docs.get(output.path) ?? await vscode.workspace.openTextDocument(await workspace.uri(output.path));
          if (!await document.save()) throw new Error(`Applied ${output.path}, but VS Code could not save it. Save the file before running tests.`);
          // Formatting and code actions on save are part of this batch. Keep the
          // actual saved text as the next batch's source and Undo task's expected text.
          const saved = this.taskEdits.get(output.path)!;
          saved.output.content = document.getText();
        }
        for (const output of outputs) {
          const document = docs.get(output.path) ?? await vscode.workspace.openTextDocument(await workspace.uri(output.path));
          if (document.getText() !== this.taskEdits.get(output.path)!.output.content || document.isDirty) throw new Error(`${output.path} changed during save. Your current text is retained; review it before continuing.`);
        }
      }
      const summary = { applied: true, saved: save, revision: this.taskRevision, files: outputs.map(output => output.path), taskFiles: taskOutputs.map(output => output.path), accepted: outputs.reduce((count, output) => count + output.editIds.length, 0), rejected: reviewed.filter(hunk => hunk.status === 'rejected').length };
      if (generation === this.generation) {
        this.settleReview(summary);
        if (approval) { this.reviewApproval = undefined; await harness?.approve(approval.id, true); }
        if (!this.state.busy) this.state.status = 'complete';
        this.finishAssistant('applied');
      }
      this.event('edit', `${save ? 'Updated' : 'Applied'} ${outputs.length} file${outputs.length === 1 ? '' : 's'}`, outputs.map(output => output.path).join(', '));
      this.log(`Applied ${summary.accepted} hunks across ${outputs.length} files${save ? ' and saved them' : ' in one editor transaction · save to persist'} · Undo task is available${generation !== this.generation ? ' · transaction completed after cancellation' : ''}`);
    } finally { this.mutation = undefined; this.sync(); }
  }

  private settleReview(result: Record<string, unknown>): void {
    this.reviewResult = result;
    for (const resolve of this.reviewWaiters.splice(0)) resolve(result);
  }

  async undo(): Promise<void> {
    this.assertTrusted(); this.assertNoMutation();
    if (this.state.busy) throw new Error('Cancel the active generation before undoing an applied change.');
    if (this.commandInFlight) throw new Error('Wait for command cleanup before undoing this task.');
    if (!this.state.applied && this.changes.list().some(hunk => hunk.status !== 'rejected')) throw new Error('Review or discard the current proposal before undoing the previous change.');
    const last = this.lastApplied;
    if (!last) return;
    const generation = this.generation;
    const check = () => { if (generation !== this.generation || this.lastApplied !== last) throw new Error('Undo cancelled before the editor transaction.'); };
    this.mutation = 'undo';
    try {
      const edit = new vscode.WorkspaceEdit();
      const checked: { doc: vscode.TextDocument; content: string }[] = [];
      for (const output of last.outputs) {
        const read = await last.workspace.read(output.path); check();
        if (read.content !== output.content || !read.doc) throw new Error(`Cannot undo: ${output.path} changed since apply. Use the editor’s native undo instead.`);
        const uri = await last.workspace.uri(output.path); check();
        checked.push({ doc: read.doc, content: output.content });
        if (last.created.has(output.path)) edit.deleteFile(uri);
        else edit.replace(uri, new vscode.Range(read.doc.positionAt(0), read.doc.positionAt(read.content.length)), output.original);
      }
      check();
      if (checked.some(item => item.doc.getText() !== item.content)) throw new Error('A file changed during undo validation.');
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not undo the change.');
      this.bumpRevision();
      if (last.saved) for (const item of checked) if (!last.created.has(path.relative(last.workspace.root.fsPath, item.doc.uri.fsPath).replace(/\\/g, '/'))) {
        if (!await item.doc.save()) throw new Error('Undo reached the editor but a restored file could not be saved.');
      }
      this.lastApplied = undefined; this.state.applied = false; this.changes.clear();
      this.taskEdits.clear(); this.state.changedFiles = [];
      this.finishAssistant('undone');
      if (generation === this.generation) this.state.status = 'complete';
      this.log('Last applied change restored · original text is back');
    } finally { this.mutation = undefined; this.sync(); }
  }

  cancel(): void {
    this.continuation = undefined; this.finishAssistant('cancelled');
    this.generation++; this.activeAttempt++; this.controller?.abort(); this.controller = undefined;
    const bridge = this.bridge; this.bridge = undefined; void bridge?.close();
    void this.harness?.cancel().catch(error => this.output.appendLine(this.redact(`Cancel acknowledgement: ${errorMessage(error)}`)));
    this.changes.discardPending(); this.settleReview({ cancelled: true }); this.reviewApproval = undefined; this.approvedCommands.clear();
    for (const command of this.state.commands) if (command.status === 'running') command.status = 'cancelled';
    for (const event of this.state.events) if (event.status === 'running') event.status = 'cancelled';
    if (this.taskEdits.size) this.state.applied = true;
    this.state.task.phase = 'cancelled'; this.persistChat();
    this.state.busy = this.commandInFlight; this.state.status = this.commandInFlight ? 'cancelling' : 'cancelled'; this.state.error = ''; this.log(this.commandInFlight ? 'Stopping the owned command process · unapplied proposals discarded' : 'Cancelled · unapplied proposals discarded');
  }

  private commandKey(args: Record<string, unknown>): string {
    return JSON.stringify({ executable: requiredString(args, 'executable'), args: this.commandArgs(args), cwd: this.commandDirectory(args), timeoutMs: this.commandTimeout(args), mode: this.state.workMode });
  }
  private commandDirectory(args: Record<string, unknown>): string {
    if (args.cwd === undefined || args.cwd === '' || args.cwd === '.') return '';
    return normalizeWorkspacePath(requiredString(args, 'cwd'));
  }
  private commandTimeout(args: Record<string, unknown>): number {
    if (args.timeoutMs === undefined) return 120000;
    if (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('Command timeout must be a positive number.');
    return Math.min(120000, Math.max(1, Math.floor(args.timeoutMs)));
  }
  private async commandEnvironment(workspace: Workspace, cwd: string, signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
    const configured = this.config().get<string>('nodePath', '');
    if (!this.externalNode || this.externalNode.configured !== configured) {
      try { this.externalNode = { configured, executable: await resolveExternalNode(configured || undefined, signal) }; }
      catch { if (signal.aborted) throw new Error('Cancelled'); }
    }
    const directories = [this.externalNode ? path.dirname(this.externalNode.executable) : '',
      path.join(cwd, '.venv', 'bin'), path.join(workspace.root.fsPath, '.venv', 'bin'),
      path.join(cwd, 'node_modules', '.bin'), path.join(workspace.root.fsPath, 'node_modules', '.bin'),
      ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter),
      path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.volta', 'bin'), process.env.NVM_BIN ?? ''];
    return { PATH: [...new Set(directories.filter(Boolean))].join(path.delimiter) };
  }
  private commandArgs(args: Record<string, unknown>): string[] {
    if (!Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string')) throw new Error('Command arguments must be a string array.');
    return args.args as string[];
  }
  private async approveCommand(args: Record<string, unknown>): Promise<boolean> {
    const executable = requiredString(args, 'executable');
    if (!Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string') || !executable || executable.includes('\0')) throw new Error('Command requires an executable and a string argument array.');
    const relative = this.commandDirectory(args); const workspace = this.workspace!;
    const cwd = relative ? await workspace.uri(relative) : workspace.root;
    if (!(await fs.stat(cwd.fsPath)).isDirectory()) throw new Error('Command cwd must be a workspace directory.');
    const timeout = this.commandTimeout(args);
    const label = this.state.workMode === 'agent' ? 'Run in workspace' : 'Run in temporary copy';
    const policy = classifyCommand({ executable, args: this.commandArgs(args), mode: this.state.workMode });
    let choice: string | undefined;
    try {
      choice = await vscode.window.showWarningMessage('Allow this exact command?', { modal: true, detail: `Executable: ${executable}\nArguments: ${JSON.stringify(args.args)}\nWorking directory: ${cwd.fsPath}${this.state.workMode === 'review' ? ' (in a temporary copy)' : ''}\nTimeout: ${timeout / 1000} seconds\n\n${typeof args.reason === 'string' ? args.reason : ''}\n\n${policy.reason}\n\n${label}. The executable retains your user permissions.` }, label);
    } catch {
      const guidance = this.state.workMode === 'agent' && path.basename(executable).replace(/\.exe$/i, '') === 'node'
        ? ' For Node built-in tests, pass executable "node" and args ["--test", "path/to/test"]. Running a JavaScript file without --test requires approval.' : '';
      throw new Error(`The editor could not request approval for this exact command. ${policy.reason}${guidance} Do not bypass approval; report a blocker if approval is still required.`);
    }
    return choice === label;
  }
  private async runCommand(args: Record<string, unknown>, signal: AbortSignal, validateAttempt: () => void = () => undefined): Promise<unknown> {
    validateAttempt();
    if (this.commandInFlight) throw new Error('A command is already preparing or running. Wait for its result.');
    this.commandInFlight = true;
    try { return await this.executeWorkspaceCommand(args, signal, validateAttempt); }
    finally {
      this.commandInFlight = false;
      if (this.state.status === 'cancelling') { this.state.busy = false; this.state.status = 'cancelled'; this.sync(); }
    }
  }

  private async executeWorkspaceCommand(args: Record<string, unknown>, signal: AbortSignal, validateAttempt: () => void = () => undefined): Promise<unknown> {
    this.assertTrusted(); this.assertNoMutation(); validateAttempt();
    if (this.state.workMode === 'ask') throw new Error('Ask mode cannot execute commands. Switch to Agent or Review.');
    if (this.state.commands.some(command => command.status === 'running')) throw new Error('Wait for the current command to finish before starting another.');
    const workspace = this.workspace!; const generation = this.generation;
    const executable = requiredString(args, 'executable'); const commandArgs = this.commandArgs(args);
    const cwdRelative = this.commandDirectory(args);
    const realCwd = cwdRelative ? await workspace.uri(cwdRelative) : workspace.root;
    if (!(await fs.stat(realCwd.fsPath)).isDirectory()) throw new Error('Command cwd must be a workspace directory.');
    const timeoutMs = this.commandTimeout(args);
    validateAttempt();
    const policy = classifyCommand({ executable, args: commandArgs, mode: this.state.workMode });
    const explicitlyApproved = this.approvedCommands.delete(this.commandKey(args));
    if (!policy.automatic && !explicitlyApproved && !await this.approveCommand(args)) return { cancelled: true, message: 'User declined this exact command.', approvalReason: policy.reason };
    validateAttempt();
    if (signal.aborted || this.controller?.signal.aborted) throw new Error('Cancelled');
    const agentMode = this.state.workMode === 'agent';
    if (agentMode) await this.applyAutomatically(validateAttempt, true);
    validateAttempt();
    const combined = this.controller ? AbortSignal.any([signal, this.controller.signal]) : signal;
    let temporary: string | undefined;
    let record: CommandRun | undefined;
    let cwd = realCwd.fsPath;
    try {
      if (!agentMode) {
        temporary = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-verify-'));
        await fs.cp(workspace.root.fsPath, temporary, { recursive: true, filter: async source => {
          const relative = path.relative(workspace.root.fsPath, source);
          if (relative.split(path.sep).some(part => ['node_modules', '.git', '.venv', 'venv', '.env', '.aws', '.ssh', '.trueforge', '.host-test'].includes(part) || part.startsWith('.env.'))) return false;
          return !(await fs.lstat(source)).isSymbolicLink();
        } });
        validateAttempt();
        const candidates = new ChangeSet(); const current = new Map<string, string>();
        for (const hunk of this.state.applied ? [] : this.changes.list().filter(hunk => hunk.status !== 'rejected')) {
          const read = await workspace.read(hunk.path, true); validateAttempt();
          const staged = candidates.stage(hunk, read.content); candidates.review(staged.id, 'accepted'); current.set(hunk.path, read.content);
        }
        const overwrite = new Map<string, string>();
        for (const doc of vscode.workspace.textDocuments) {
          const relative = path.relative(workspace.root.fsPath, doc.uri.fsPath).replace(/\\/g, '/');
          if (doc.uri.scheme !== 'file' || !relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
          try { await workspace.uri(relative); validateAttempt(); overwrite.set(relative, doc.getText()); } catch { /* Private/inaccessible paths stay excluded. */ }
        }
        for (const output of candidates.acceptedOutputs(current)) overwrite.set(output.path, output.content);
        for (const [relative, content] of overwrite) {
          const target = path.join(temporary, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
        }
        cwd = path.join(temporary, cwdRelative);
      }
      validateAttempt();
      if (combined.aborted) throw new Error('Cancelled');
      record = { id: randomBytes(8).toString('hex'), executable, args: commandArgs, revision: this.taskRevision, stale: false,
        cwd: agentMode ? realCwd.fsPath : `${workspace.root.fsPath}${cwdRelative ? '/' + cwdRelative : ''} (temporary copy)`, status: 'running', stdout: '', stderr: '' };
      this.state.commands = [...this.state.commands, record].slice(-20);
      this.state.task.phase = 'testing';
      const eventId = this.event('command', `${path.basename(executable)} ${commandArgs.join(' ')}`, requiredString(args, 'reason'), 'running');
      this.log(`Run ${executable} ${JSON.stringify(commandArgs)} in ${record.cwd}`);
      const result = await executeCommand({ executable, args: commandArgs, cwd, signal: combined,
        timeoutMs, env: await this.commandEnvironment(workspace, agentMode ? realCwd.fsPath : workspace.root.fsPath, combined),
        onOutput: (chunk, stream) => {
          if (generation !== this.generation) return;
          const text = this.redact(chunk); record![stream] += text; this.output.append(text); this.sync();
        } });
      if (generation === this.generation) {
        Object.assign(record, { status: result.status, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr), exitCode: result.exitCode, durationMs: result.durationMs, truncated: result.truncated });
        this.event('command', `${path.basename(executable)} ${commandArgs.join(' ')}`, `Exit ${result.exitCode ?? result.status} · ${(result.durationMs / 1000).toFixed(1)} s`, result.status === 'passed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', eventId);
        this.state.task.phase = 'working'; this.log(`Command ${result.status} · exit ${result.exitCode ?? 'none'} · ${result.durationMs} ms`);
      }
      return { ...result, revision: record.revision, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr), code: result.exitCode,
        location: agentMode ? 'workspace' : 'temporary_copy' };
    } catch (error) {
      if (record && generation === this.generation) { record.status = combined.aborted ? 'cancelled' : 'failed'; record.stderr += this.redact(errorMessage(error)); this.sync(); }
      throw error;
    } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
  }

  /** Deterministic UI playground. It is deliberately separate from model execution. */
  async demo(): Promise<void> {
    this.assertNoMutation();
    this.assertTrusted();
    if (this.state.busy) this.cancel();
    this.continuation = undefined;
    const previousBridge = this.bridge; this.bridge = undefined; void previousBridge?.close();
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    this.resetRun('Treat off and n as false, case-insensitively. Update the tests and documentation.', 'demo');
    this.state.model = 'Scripted fixture · no model'; this.state.workspaceLabel = 'Isolated review playground'; this.state.sessionId = 'playground';
    try {
      const playground = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-playground-'));
      this.playgrounds.add(playground);
      if (generation !== this.generation || controller.signal.aborted) return;
      await fs.cp(vscode.Uri.joinPath(this.context.extensionUri, 'fixtures/workspace').fsPath, playground, { recursive: true, force: true });
      if (generation !== this.generation || controller.signal.aborted) return;
      this.playground = playground;
      const workspace = new Workspace(vscode.Uri.file(playground));
      this.workspace = workspace; this.inlineScope = undefined;
      const checkDemo = () => {
        if (generation !== this.generation || controller.signal.aborted || this.workspace !== workspace) throw new Error('Cancelled');
      };
      await this.open();
      if (generation !== this.generation || controller.signal.aborted) return;
      const files = ['src/debug.py', 'test/test_debug.py', 'docs/debug.md'];
      const documents = await Promise.all(files.map(async file => ({ path: file, content: (await workspace.read(file)).content })));
      checkDemo();
      const result = retrieveContext(documents, 'debug false off test documentation');
      this.state.context = result.entries; this.state.budgetUsed = result.usedBytes; this.state.status = 'streaming'; this.sync();
      const narrative = 'I found the debug flag implementation, its test, and the developer guide. I’ll add the two false values, exercise mixed-case inputs, and document the complete set. Every proposed hunk stays staged until you review it.';
      for (const word of narrative.split(' ')) {
        await delay(28, controller.signal); if (generation !== this.generation) return;
        this.setStream(this.state.stream + word + ' '); this.sync();
      }
      await this.stageEdit({ path: files[0], oldText: '"""Get debug mode. Empty, 0, false and no are treated as false."""', newText: '"""Get debug mode. Empty, 0, false, no, off and n are false (case-insensitive)."""', reason: 'Document the complete false-value set where the function is defined.' }, checkDemo);
      await this.stageEdit({ path: files[0], oldText: '("", "0", "false", "no")', newText: '("", "0", "false", "no", "off", "n")', reason: 'The existing lower() already handles case-insensitive values.' }, checkDemo);
      await this.stageEdit({ path: files[1], oldText: '("", "0", "false", "no")', newText: '("", "0", "false", "no", "off", "OFF", "n", "N")', reason: 'Cover both new values and mixed-case variants.' }, checkDemo);
      await this.stageEdit({ path: files[2], oldText: 'The values `0`, `false`, and `no`, plus an empty value, disable debug mode.', newText: 'The values `0`, `false`, `no`, `off`, and `n`, plus an empty value, disable debug mode (case-insensitively).', reason: 'Keep the public guide consistent with the implementation.' }, checkDemo);
      this.state.status = 'review'; this.finishAssistant('review'); this.log('Scripted fixture ready · 4 hunks across 3 files · no model was called');
    } catch (error) { if (!controller.signal.aborted) this.fail(error); }
    finally { if (generation === this.generation) { this.state.busy = false; this.controller = undefined; this.sync(); } }
  }

  dispose(): void {
    this.cancel(); void this.bridge?.close(); this.output.dispose(); this.diffs.dispose();
    this.runtime?.dispose();
    for (const playground of this.playgrounds) void fs.rm(playground, { recursive: true, force: true });
  }
}

export function activate(context: vscode.ExtensionContext): Studio {
  const studio = new Studio(context);
  context.subscriptions.push(studio,
    vscode.window.registerWebviewViewProvider('trueforage.panel', studio, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('trueforage', studio.diffs),
    vscode.languages.registerCodeLensProvider({ scheme: 'trueforage' }, studio.diffs));
  const commands: Record<string, (...args: any[]) => unknown> = {
    open: () => studio.open(), inline: () => studio.inline(), chooseModel: () => studio.chooseModel(),
    connect: () => studio.connect(), demo: () => studio.demo(), apply: () => studio.apply(),
    configureModel: () => studio.configureModel(), openHarness: () => studio.openHarness(), newSession: () => studio.newSession(),
    openEditor: () => studio.openEditor(), runTests: () => studio.runTests(), history: () => studio.openHistory(),
    undo: () => studio.undo(), cancel: () => studio.cancel(),
    acceptHunk: (id?: string) => studio.review(typeof id === 'string' ? id : activeHunk(), 'accepted'), rejectHunk: (id?: string) => studio.review(typeof id === 'string' ? id : activeHunk(), 'rejected')
  };
  function activeHunk(): string {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const id = uri?.scheme === 'trueforage' ? uri.path.match(/^\/(?:before|after)\/(hunk-\d+)\//)?.[1] : undefined;
    if (!id) throw new Error('Open a TrueForage native diff first.');
    return id;
  }
  for (const [name, handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`trueforage.${name}`, async (...args) => {
    try { return await handler(...args); } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
  }));
  studio.state.model = vscode.workspace.getConfiguration('trueforage').get('model', '');
  return studio;
}
