import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk' with { 'resolution-mode': 'import' };
import { normalizeGatewayUrl, trueFoundryModelAlias, validateTrueFoundryConfig, type TrueFoundryConfig, type ConfiguredTrueFoundry } from './truefoundry';
import { READ_ONLY_TOOLS, checkedWorkMode, workModeInstructions, type WorkMode } from './modes';
export { normalizeGatewayUrl, trueFoundryModelAlias, validateTrueFoundryConfig } from './truefoundry';
export type { TrueFoundryConfig, ConfiguredTrueFoundry } from './truefoundry';
export { workModeInstructions } from './modes';
export type { WorkMode } from './modes';

/** The exact server/SDK pair whose legacy approval lifecycle this adapter implements. */
export const TRUEFORGE_VERSIONS = { server: '0.183.1', sdk: '0.183.0' } as const;

export interface HarnessConfig {
  baseUrl: string;
  /** TrueForge login token, never a model-provider API key. */
  token?: string;
  timeoutSeconds?: number;
}

export interface HarnessApproval {
  type: 'approval';
  id: string;
  toolName: string;
  arguments: unknown;
  threadId: string;
  toolCallId: string;
}

export type HarnessEvent =
  | { type: 'raw'; event: TrueForgeApi.TurnStreamingEvent }
  | { type: 'text'; text: string }
  | { type: 'status'; text: string }
  | { type: 'session'; id: string }
  | { type: 'turn'; id: string }
  | HarnessApproval
  | { type: 'tool'; id: string; name: string; arguments: unknown; phase: 'requested' | 'result'; content?: string }
  | { type: 'done'; status: 'done' | 'cancelled' };

export interface HarnessSessionConfig {
  model: string;
  mcpServerName: string;
  instructions: string;
  iterationLimit?: number;
  /** Defaults to Review so existing inline/competition workflows retain human review. */
  workMode?: WorkMode;
}

export interface HarnessTurnOptions {
  onEvent: (event: HarnessEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface HarnessTurnResult {
  status: 'done' | 'cancelled';
  sessionId: string;
  turnId: string | undefined;
}

export interface ModelPingResult {
  model: string;
  text: string;
  sessionId: string;
  turnId: string | undefined;
}

export interface HarnessAvailability {
  status: 'ready' | 'no_models' | 'unreachable' | 'unauthorized';
  models: { name: string; modelId: string; provider: string }[];
  message: string;
}

function agentSpec(config: HarnessSessionConfig): TrueForgeApi.AgentSpec {
  if (!config.model.trim()) throw new Error('Choose a configured model in TrueForge first.');
  const mode = checkedWorkMode(config.workMode);
  return {
    model: { name: config.model },
    instructions: `${workModeInstructions(mode)}\n\n${config.instructions}`,
    mcpServers: [{
      name: config.mcpServerName,
      enableTools: mode === 'ask' ? [...READ_ONLY_TOOLS] : ['@all'],
      requireApprovalForTools: mode === 'review' ? ['review_changes', 'run_command'] : [],
      preload: false,
      preloadTools: mode === 'agent'
        ? ['list_files', 'search_context', 'read_file', 'propose_edit', 'apply_changes', 'revise_edit', 'run_command']
        : ['list_files', 'search_context'],
    }],
    config: {
      iterationLimit: config.iterationLimit ?? 50,
      sandbox: { enabled: false }, generativeUi: { enabled: false },
      dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false },
      contextManagement: { compaction: { enabled: true }, largeToolResponse: { enabled: false } },
    },
  };
}

type ApprovalDecision = TrueForgeApi.UserToolApprovalInputEvent;
interface PendingApproval {
  event: HarnessApproval;
  decision?: ApprovalDecision;
  resolve?: (decision: ApprovalDecision) => void;
}

function abortError(): Error {
  return Object.assign(new Error('TrueForge generation cancelled.'), { name: 'AbortError' });
}

function parseArguments(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Safe actionable categories; provider responses can contain echoed credentials. */
function modelFailure(model: string, message: string): string {
  const google = model.startsWith('google-gemini/') || /generativelanguage|google.*gemini/i.test(message);
  if (google && /\b403\b|PERMISSION_DENIED/i.test(message)) {
    if (/project.*denied access|project.*access.*denied/i.test(message)) {
      return 'Google Gemini denied access to this project (HTTP 403). Check the project status and access notices in Google AI Studio and Google Cloud, then follow Google’s support or appeal instructions.';
    }
    if (/SERVICE_DISABLED|has not been used|api.*disabled|service.*disabled/i.test(message)) {
      return 'Google Gemini reports that the required API is disabled for this project (HTTP 403). Enable the Generative Language API for the key’s project, then retry.';
    }
    return 'Google Gemini denied permission (HTTP 403). Check the key’s API restrictions, project access and permission to invoke the selected model in Google AI Studio.';
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(?:key|token)|(?:key|token).*not valid/i.test(message)) {
    return 'The model provider rejected the connection. Check your API key and permission to use the exact model ID in TrueForge Settings → Models.';
  }
  if (/\b404\b|unknown model|model.*not found/i.test(message)) {
    return 'The provider endpoint or model ID was not found. Verify the selected provider in TrueForge Settings → Models.';
  }
  if (/\b429\b|quota|rate.?limit|credit|budget/i.test(message)) {
    return 'The model provider reported a rate or quota limit. Check your account access and credits.';
  }
  if (/\b(502|503|504)\b|overloaded|service unavailable/i.test(message)) {
    return 'The model provider is temporarily unavailable. Retry after the provider recovers or choose another configured model.';
  }
  return 'The model request failed. Verify the provider endpoint, API key and model ID in TrueForge Settings → Models, and inspect the TrueForge session for details.';
}

/** Resolve the actual MCP operation when TrueForge uses its deferred call_tool wrapper. */
export function describeToolCall(call: TrueForgeApi.ToolCall): { name: string; arguments: unknown } {
  const args = parseArguments(call.function.arguments);
  const name = call.toolInfo?.name ?? call.function.name;
  const wrapper = object(args);
  if (name === 'call_tool' && wrapper && typeof wrapper.tool_name === 'string') {
    return { name: wrapper.tool_name, arguments: wrapper.input ?? {} };
  }
  return { name, arguments: args };
}

/**
 * Genuine TrueForge transport. All model/tool execution belongs to the harness.
 * This class deliberately does not replay failed turns: the caller must first
 * discard staged changes before retrying or falling back to another model.
 */
export class TrueForgeHarness {
  private clientPromise: Promise<TrueForge> | undefined;
  private readonly config: HarnessConfig;
  private currentSessionId: string | undefined;
  private currentTurnId: string | undefined;
  private currentModel = '';
  private activeController: AbortController | undefined;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(config: HarnessConfig, client?: TrueForge) {
    const parsed = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('TrueForge URL must be HTTP(S), without embedded credentials.');
    }
    this.config = config;
    this.clientPromise = client ? Promise.resolve(client) : undefined;
  }

  get sessionId(): string | undefined { return this.currentSessionId; }
  get turnId(): string | undefined { return this.currentTurnId; }

  private getClient(): Promise<TrueForge> {
    // The pinned SDK's CommonJS export has inconsistent package metadata.
    // Import its official ESM entry; esbuild also bundles this correctly for VS Code.
    this.clientPromise ??= import('@truefoundry/trueforge-sdk').then(({ TrueForge }) => new TrueForge({
      baseUrl: this.config.baseUrl.replace(/\/$/, ''),
      token: this.config.token,
      timeoutInSeconds: this.config.timeoutSeconds ?? 600,
      // Replaying a turn POST can execute the same tools twice. The extension
      // must clear its staged proposal before retrying in a fresh session.
      maxRetries: 0,
    }));
    return this.clientPromise;
  }

  async listModels(signal?: AbortSignal): Promise<{ name: string; modelId: string; provider: string }[]> {
    const client = await this.getClient();
    const result = await client.models.list({ abortSignal: signal, timeoutInSeconds: 15 });
    return result.data.map(model => ({ name: model.name, modelId: model.modelId, provider: model.provider.name }));
  }

  /** Checks the actual local API and configured catalog; it does not spend model tokens. */
  async getAvailability(signal?: AbortSignal): Promise<HarnessAvailability> {
    try {
      const models = await this.listModels(signal);
      return models.length
        ? { status: 'ready', models, message: `${models.length} configured model${models.length === 1 ? '' : 's'} available. Select one and run a connection check before starting work.` }
        : { status: 'no_models', models, message: 'TrueForge is running, but no model is configured. Open its local Settings → Models and add a provider you can access, then choose that model in TrueForage.' };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const code = object(error)?.statusCode;
      if (code === 401 || code === 403) return { status: 'unauthorized', models: [], message: 'The TrueForge API denied access. Check the harness login or use the local standalone server.' };
      return { status: 'unreachable', models: [], message: 'The TrueForge model API is not reachable. Start the local runtime or run npm run trueforge, then retry the configured local harness URL.' };
    }
  }

  /** Register credentials and exact upstream model ID in TrueForge, never at a direct provider client. */
  async configureTrueFoundry(config: TrueFoundryConfig, signal?: AbortSignal): Promise<ConfiguredTrueFoundry> {
    const value = validateTrueFoundryConfig(config);
    const harnessUrl = new URL(this.config.baseUrl);
    if (harnessUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(harnessUrl.hostname)) {
      throw new Error('Sending Gateway credentials requires HTTPS or a loopback TrueForge harness.');
    }
    const client = await this.getClient();
    let providers: TrueForgeApi.ConfiguredModelProvider[];
    try {
      providers = (await client.settings.modelProviders.list({ abortSignal: signal, timeoutInSeconds: 15 })).data;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw this.providerSetupError(error, 'read the configured model providers');
    }
    const existing = providers.find(provider => provider.name === value.providerName);
    const expectedType = value.providerName === 'truefoundry' ? 'truefoundry' : 'custom';
    if (existing && (existing.manifest.type !== expectedType || normalizeGatewayUrl(existing.manifest.baseUrl ?? '') !== value.gatewayUrl)) {
      throw new Error(`TrueForge provider ${value.providerName} already uses another gateway or provider type. Choose another provider name to preserve it.`);
    }
    const previousModels = existing?.manifest.models ?? [];
    const previousModel = previousModels.find(model => model.modelId === value.modelId);
    const alias = previousModel?.name ?? trueFoundryModelAlias(value.modelId);
    const models = previousModel ? previousModels : [...previousModels, { name: alias, modelId: value.modelId, properties: {} }];
    const manifest: TrueForgeApi.ModelProviderManifest = value.providerName === 'truefoundry'
      ? { type: 'truefoundry', baseUrl: value.gatewayUrl, auth: { apiKey: value.apiKey }, models }
      : { type: 'custom', name: value.providerName, baseUrl: value.gatewayUrl, auth: { apiKey: value.apiKey }, models };
    try {
      await client.settings.modelProviders.createOrUpdate({ manifest }, { abortSignal: signal, timeoutInSeconds: 20 });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw this.providerSetupError(error, 'save the TrueFoundry connection');
    }
    return { model: `${value.providerName}/${alias}`, provider: value.providerName, modelId: value.modelId, gatewayUrl: value.gatewayUrl };
  }

  /** A small real model request through a separate, tool-free TrueForge session. */
  async pingModel(model: string, signal?: AbortSignal): Promise<ModelPingResult> {
    if (!model.trim()) throw new Error('Choose a configured TrueForge model before testing the connection.');
    const client = await this.getClient();
    const timeout = AbortSignal.timeout(90_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let sessionId: string | undefined;
    let turnId: string | undefined;
    let text = '';
    let terminal: TrueForgeApi.TurnDoneEventState | undefined;
    const cancel = () => {
      if (sessionId) void client.sessions.cancel(sessionId, {}, { timeoutInSeconds: 5, maxRetries: 0 }).catch(() => undefined);
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      const { data: session } = await client.sessions.create({ agent: { spec: {
        model: { name: model },
        instructions: 'This is a connection check. Reply with exactly: TrueForage connected. Do not use any tools.',
        mcpServers: [],
        config: { iterationLimit: 1, sandbox: { enabled: false }, dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false }, askUserQuestions: { enabled: false },
          contextManagement: { compaction: { enabled: false }, largeToolResponse: { enabled: false } } },
      } } }, { abortSignal: combined, timeoutInSeconds: 15 });
      sessionId = session.id;
      const stream = await client.sessions.createTurnStream(session.id, {
        input: [{ type: 'user.message', content: 'Reply with exactly: TrueForage connected.' }],
      }, { abortSignal: combined, timeoutInSeconds: 90, maxRetries: 0 });
      for await (const event of stream) {
        if (event.type === 'turn.created') turnId = event.turnId;
        if (event.type === 'model.message.delta' && event.threadId === 'main' && event.content) text += event.content;
        if (event.type === 'turn.done') terminal = event.state;
      }
      if (combined.aborted) throw abortError();
      if (!terminal) throw new Error('The model stream closed before its result arrived.');
      if (terminal.status === 'error') throw new Error(terminal.message);
      if (terminal.status === 'cancelled') throw abortError();
      if (terminal.requiredActions.length) throw new Error('The connection check unexpectedly requested a tool.');
      if (!text && typeof terminal.output?.content === 'string') text = terminal.output.content;
      if (!text.trim()) throw new Error('The model returned no text.');
      return { model, text: text.trim(), sessionId: session.id, turnId };
    } catch (error) {
      if (combined.aborted) throw Object.assign(new Error(signal?.aborted ? 'Connection test cancelled.' : 'Model connection test timed out.'), { name: 'AbortError' });
      const message = error instanceof Error ? error.message : '';
      throw new Error(modelFailure(model, message));
    } finally {
      combined.removeEventListener('abort', cancel);
    }
  }

  async registerMcp(config: { name: string; url: string; bearerToken: string }, signal?: AbortSignal): Promise<void> {
    const endpoint = new URL(config.url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('TrueForage MCP must use a loopback HTTP address.');
    }
    if (!config.bearerToken) throw new Error('A per-host MCP bearer token is required.');
    const client = await this.getClient();
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: config.name,
        description: 'TrueForage editor workspace, context retrieval, staged diffs and verification.',
        url: config.url,
        auth: { type: 'header', headers: { Authorization: `Bearer ${config.bearerToken}` } },
      },
    }, { abortSignal: signal, timeoutInSeconds: 20 });
  }

  async createSession(config: HarnessSessionConfig, signal?: AbortSignal): Promise<string> {
    if (this.activeController) throw new Error('Cancel the active TrueForge turn before starting a session.');
    const client = await this.getClient();
    const { data } = await client.sessions.create({
      agent: { spec: agentSpec(config) },
    }, { abortSignal: signal, timeoutInSeconds: 30 });
    this.currentSessionId = data.id;
    this.currentModel = config.model;
    this.currentTurnId = undefined;
    this.pending.clear();
    return data.id;
  }

  /** Rotate the workspace bridge for a completed inline session without discarding its conversation. */
  async updateSession(config: HarnessSessionConfig, signal?: AbortSignal): Promise<string> {
    if (this.activeController) throw new Error('Finish or cancel the active TrueForge turn before updating its session.');
    if (!this.currentSessionId) throw new Error('Create a TrueForge session before updating it.');
    const client = await this.getClient();
    const { data } = await client.sessions.update(this.currentSessionId, { agent: { spec: agentSpec(config) } },
      { abortSignal: signal, timeoutInSeconds: 20, maxRetries: 0 });
    this.currentSessionId = data.id;
    this.currentModel = config.model;
    return data.id;
  }

  /**
   * Includes approval resumes. For 0.183.1 a gated call ends turn.done with
   * requiredActions. We wait for exact user decisions, then create a new turn
   * containing only user.tool_approval input. Do not use createTurnEvent here:
   * that generated method is a stub on this pinned server release.
   */
  async streamTurn(prompt: string, options: HarnessTurnOptions): Promise<HarnessTurnResult> {
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error('Create a TrueForge session before sending a turn.');
    if (this.activeController) throw new Error('A TrueForge turn is already active.');
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    this.activeController = controller;
    this.pending.clear();
    const onAbort = () => { void this.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const emit = options.onEvent;
    const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
    const reportedCalls = new Set<string>();
    let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: prompt }];
    try {
      const client = await this.getClient();
      const { isEventDelta, mergeEventDelta } = await import('@truefoundry/trueforge-sdk');
      await emit({ type: 'session', id: sessionId });
      for (;;) {
        if (controller.signal.aborted) throw abortError();
        let terminal: TrueForgeApi.TurnDoneEventState | undefined;
        const stream = await client.sessions.createTurnStream(sessionId, { input }, { abortSignal: controller.signal });
        for await (const event of stream) {
          if (controller.signal.aborted) throw abortError();
          if (isEventDelta(event)) {
            // The SDK merges content and fragmented tool-call arguments by index.
            const base = events.get(event.id);
            if (base) mergeEventDelta(base, event);
          } else {
            events.set(event.id, event);
          }
          await emit({ type: 'raw', event });
          if (event.type === 'turn.created') {
            this.currentTurnId = event.turnId;
            await emit({ type: 'turn', id: event.turnId });
          } else if (event.type === 'model.message.delta') {
            if (event.threadId === 'main' && event.content) await emit({ type: 'text', text: event.content });
            const base = events.get(event.id);
            if (event.finishReason && base?.type === 'model.message') {
              await this.reportCalls(base, emit, reportedCalls);
            }
          } else if (event.type === 'model.message') {
            if (event.threadId === 'main' && typeof event.content === 'string' && event.content) {
              await emit({ type: 'text', text: event.content });
            }
            await this.reportCalls(event, emit, reportedCalls);
          } else if (event.type === 'tool.approval_required') {
            for (const ref of event.toolCalls) {
              const source = events.get(ref.sourceEventId);
              const call = source?.type === 'model.message' ? source.toolCalls?.find(item => item.id === ref.id) : undefined;
              if (!call) throw new Error(`TrueForge approval ${ref.id} has no matching tool call. No action was approved.`);
              const described = describeToolCall(call);
              const approval: HarnessApproval = {
                type: 'approval', id: ref.id, toolCallId: ref.id,
                threadId: event.threadId, toolName: described.name, arguments: described.arguments,
              };
              this.pending.set(ref.id, { event: approval });
              await emit(approval);
            }
          } else if (event.type === 'tool.response') {
            const call = this.findCall(events, event.toolCallId);
            const described = call ? describeToolCall(call) : { name: event.toolCallId, arguments: {} };
            await emit({ type: 'tool', id: event.toolCallId, ...described, phase: 'result', content: event.content });
          } else if (event.type === 'mcp.auth_required') {
            throw new Error('TrueForge needs MCP authorization. Reconnect the local TrueForage bridge and retry.');
          } else if (event.type === 'tool.response_required') {
            throw new Error('This agent requested an unsupported client-side tool response. Disable ask-user tools in its configuration.');
          } else if (event.type === 'thread.context_compaction_started') {
            await emit({ type: 'status', text: 'TrueForge is compacting the session context.' });
          } else if (event.type === 'thread.context_compaction_finished') {
            await emit({ type: 'status', text: 'TrueForge context compaction completed.' });
          } else if (event.type === 'turn.done') {
            terminal = event.state;
          }
        }
        if (controller.signal.aborted) throw abortError();
        if (!terminal) throw new Error('TrueForge stream disconnected before turn.done. Discard staged changes before retrying.');
        if (terminal.status === 'error') throw new Error(modelFailure(this.currentModel, terminal.message));
        if (terminal.status === 'cancelled') {
          await emit({ type: 'done', status: 'cancelled' });
          return { status: 'cancelled', sessionId, turnId: this.currentTurnId };
        }
        if (terminal.requiredActions.length === 0) {
          await emit({ type: 'done', status: 'done' });
          return { status: 'done', sessionId, turnId: this.currentTurnId };
        }
        const approvalRefs = terminal.requiredActions.flatMap(action => action.type === 'tool.approval_required' ? action.toolCalls : []);
        if (!approvalRefs.length) throw new Error('TrueForge paused for an unsupported action. Review its session in the harness UI.');
        await emit({ type: 'status', text: 'Waiting for your review in TrueForage.' });
        input = await Promise.all(approvalRefs.map(ref => this.waitForDecision(ref.id, controller.signal)));
        for (const ref of approvalRefs) this.pending.delete(ref.id);
        await emit({ type: 'status', text: 'Sending review decisions to TrueForge.' });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await emit({ type: 'done', status: 'cancelled' });
        return { status: 'cancelled', sessionId, turnId: this.currentTurnId };
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.pending.clear();
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  /** Queues one exact user decision; streamTurn sends it in an approval-only resume. */
  async approve(id: string, allow: boolean, reason?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('That TrueForge approval is no longer pending.');
    if (pending.decision) throw new Error('That TrueForge approval already has a decision.');
    const decision: ApprovalDecision = {
      type: 'user.tool_approval',
      threadId: pending.event.threadId,
      toolCallId: pending.event.toolCallId,
      approval: allow ? { status: 'allow' } : { status: 'deny', reason: reason ?? 'Rejected in TrueForage review.' },
    };
    pending.decision = decision;
    pending.resolve?.(decision);
  }

  /** The local stream stops immediately; server cancellation is separately bounded. */
  async cancel(): Promise<void> {
    const wasActive = Boolean(this.activeController);
    const sessionId = this.currentSessionId;
    this.activeController?.abort();
    if (!wasActive || !sessionId) return;
    try {
      const client = await this.getClient();
      await client.sessions.cancel(sessionId, {}, { timeoutInSeconds: 10, maxRetries: 0 });
    } catch (error) {
      // A legacy approval pause already completed the last turn on the server.
      const status = object(error)?.statusCode;
      if (status !== 412 && status !== 404) throw error;
    }
  }

  private waitForDecision(id: string, signal: AbortSignal): Promise<ApprovalDecision> {
    const pending = this.pending.get(id);
    if (!pending) return Promise.reject(new Error(`Missing TrueForge approval ${id}.`));
    if (signal.aborted) return Promise.reject(abortError());
    if (pending.decision) return Promise.resolve(pending.decision);
    return new Promise((resolve, reject) => {
      const onAbort = () => { pending.resolve = undefined; reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.resolve = decision => {
        signal.removeEventListener('abort', onAbort);
        pending.resolve = undefined;
        resolve(decision);
      };
    });
  }

  private providerSetupError(error: unknown, action: string): Error {
    const status = object(error)?.statusCode;
    if (status === 401 || status === 403) return new Error(`TrueForge denied permission to ${action}. Check the harness login and admin access.`);
    const body = object(object(error)?.body);
    const serverMessage = object(body?.error)?.message;
    const message = `${error instanceof Error ? error.message : ''} ${typeof serverMessage === 'string' ? serverMessage : ''}`;
    if (/outbound url blocked/i.test(message)) return new Error('TrueForge blocked the Gateway host. If your Gateway is private, add its exact host to the local harness outbound allowlist.');
    return new Error(`TrueForge could not ${action}${typeof status === 'number' ? ` (HTTP ${status})` : ''}. Check that the local harness is running and reachable.`);
  }

  private findCall(events: Map<string, TrueForgeApi.TurnStreamingEvent>, id: string): TrueForgeApi.ToolCall | undefined {
    for (const event of events.values()) {
      if (event.type === 'model.message') {
        const call = event.toolCalls?.find(item => item.id === id);
        if (call) return call;
      }
    }
    return undefined;
  }

  private async reportCalls(message: TrueForgeApi.ModelMessageEvent, emit: HarnessTurnOptions['onEvent'], reported: Set<string>): Promise<void> {
    for (const call of message.toolCalls ?? []) {
      if (!call.id || reported.has(call.id)) continue;
      // Empty initial fragments are not a complete tool invocation.
      if (!call.function?.name || !call.function.arguments) continue;
      reported.add(call.id);
      await emit({ type: 'tool', id: call.id, ...describeToolCall(call), phase: 'requested' });
    }
  }
}
