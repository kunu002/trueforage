# TrueForge connection

TrueForage is a client of a local TrueForge harness. The extension never calls a model provider directly. TrueForge owns model calls, MCP discovery and routing, context compaction, turn history and tool approval policy.

The implementation pins **TrueForge 0.183.1** with **@truefoundry/trueforge-sdk 0.183.0**. Use Node.js 22.14 or later. Start the local harness with the repository's `npm run trueforge` command, open its local UI, and configure at least one provider and model under Settings → Models. Keep provider credentials in TrueForge. Set the extension's harness URL to `http://localhost:8790` unless the launcher reports another local port. Choose a model by its exact configured fully qualified name.

## No TrueFoundry account required

TrueForge is the open-source agent harness running on your computer. You can use it without a TrueFoundry cloud account or a work email. The local server has no login by default, and model providers are configured separately. The [official local quickstart](https://github.com/truefoundry/trueforge/blob/main/docs/quickstart.mdx) documents this route.

1. Start the repository's pinned harness with `npm run trueforge`, or use the extension's local runtime setup. Node.js 22.14 or later is required.
2. Open the local TrueForge page at `http://127.0.0.1:8790` and go to **Settings → Models**.
3. Configure a provider you have access to from the catalog, such as OpenAI, Anthropic or Google Gemini. Alternatively add an OpenAI-compatible endpoint using the custom-provider form. Enter that provider's credentials in TrueForge.
4. Return to TrueForage, choose **Use a model already in TrueForge**, select the configured model and verify the connection.

The [official model setup guide](https://github.com/truefoundry/trueforge/blob/main/docs/models.mdx) describes catalog and custom providers. Provider accounts, available models, quotas and costs depend on the provider you select; no free access or specific model is assumed. Model calls still pass through TrueForge, which owns the agent loop, tools, approvals and session history. You do not need to complete the optional Gateway setup below to use this route.

## Optional: connect a TrueFoundry Gateway model

Get a TrueFoundry account through your team or [TrueFoundry signup](https://www.truefoundry.com/). Your account needs a model and permission to invoke it; signup by itself does not establish that a particular model or credits are available. The [official setup guide](https://www.truefoundry.com/docs/ai-gateway/quick-start) explains adding a provider account and models. Ask the hackathon organizers whether they supply a team Gateway and credits before adding a separately billed provider.

In **AI Gateway → Playground → Code Snippet**, copy these three values: **Gateway Base URL**, **TrueFoundry API Key**, and **Model ID**. The key is a TrueFoundry PAT or VAT, rather than the underlying OpenAI/Anthropic provider key. [TrueFoundry authentication documentation](https://www.truefoundry.com/docs/ai-gateway/authentication) describes access tokens and model permissions.

Use the extension's TrueFoundry setup command and enter the key in its password input. The editor stores it in SecretStorage and sends it to the local TrueForge provider settings; TrueForge then retains the provider credential for model calls. Do not put it in source files, VS Code settings JSON, chat prompts, recordings or the repository. The adapter only sends credentials to a loopback or HTTPS TrueForge server. A remote Gateway URL must also use HTTPS.

The exact Base URL matters. Current public SaaS documentation uses `https://gateway.truefoundry.ai`; a team deployment may instead provide a tenant path or an older `/api/llm` endpoint. **Copy the Code Snippet value unchanged.** TrueForge's pinned OpenAI-compatible adapter appends `/chat/completions`; TrueForage does not append `/v1`, `/api/llm` or a tenant name. It rejects a full `/chat/completions` endpoint in place of a base URL.

The upstream model ID, for example an account-prefixed ID copied from your Gateway, is passed unchanged to TrueFoundry. TrueForge requires its own short local names to contain only lowercase letters, numbers and hyphens, so the extension creates a stable local alias with a hash suffix and selects its returned fully qualified name. The alias does not change the upstream ID. No model availability is assumed or hardcoded.

`configureTrueFoundry({gatewayUrl, apiKey, modelId, providerName?})` uses the pinned SDK's native `type: "truefoundry"` provider by default. It preserves previously configured models when the Gateway matches. It refuses to replace an existing provider pointing to a different Gateway. An explicitly supplied alternative provider name creates an isolated `custom` OpenAI-compatible provider. Saving a configuration proves only that the local harness accepted it.

`pingModel(model)` makes a small, real request through a separate tool-free TrueForge session. A successful response proves that the selected Gateway/model was callable at that time. It returns the real response and session/turn IDs without replacing the editor's conversation. This request may incur the selected model's normal cost. The editor reports authentication, unknown-model and quota failures without copying upstream error bodies into notifications. No genuine TrueFoundry account or model request has been observed in the development environment yet; complete this step with the team's authorized credentials.

## Agent, Review and Ask

**Agent** completes the implementation and runs requested verification itself. It discovers source, stages exact edits, applies and saves coherent batches, runs relevant commands, uses actual failures to revise the implementation, and repeats verification. The `update_plan`, `get_diagnostics` and `workspace_status` tools keep progress and evidence visible. `revise_edit` replaces an unapplied hunk; after a batch is applied, another proposal uses the current saved source. `review_changes` is an apply alias in Agent mode. TrueForge does not impose a generic edit/test approval gate in this mode; the extension still enforces its command policy and prompts for commands that need explicit approval.

**Review** preserves competition and inline behavior. `review_changes` and `run_command` are gated by TrueForge. `apply_changes` routes to human hunk review, accepted changes apply as an editor transaction, and verification uses a temporary staged copy after exact-command approval. The harness API defaults to Review when a caller omits its work mode, so older inline callers retain their review boundary.

**Ask** answers questions using only `list_files`, `search_context`, `read_file`, `get_diagnostics` and `workspace_status`. Both the agent spec and the authenticated MCP bridge exclude edit, apply, plan-mutation and command tools in Ask mode. Direct calls to a hidden mutation tool fail before dispatch to the extension handler.

At runtime the extension opens a loopback MCP server with the active work mode, generates a random bearer token, and registers it using `client.settings.mcpServers.createOrUpdate({ manifest })`. The manifest is a remote connector with a loopback URL and header authentication. The registered connector name and mode policy are attached to an inline agent spec when the extension creates or updates a session. All modes retain TrueForge's execution loop; no model-provider SDK is called from the extension.

TrueForge blocks private outbound hosts by default. The local launcher must set `OUTBOUND_URL_ALLOWED_HOSTS` to a JSON array containing the loopback bridge host, for example `["127.0.0.1","localhost","::1"]`. This is the harness's supported host allowlist; it preserves outbound protections for other private hosts. Bind the harness itself with `HOST=127.0.0.1`. `SQLITE_PATH` can place its local state inside the project.

The adapter streams `sessions.createTurnStream`, merges fragmented model messages using the official SDK helpers, and reports model text, tools, approvals and raw events to the panel. The raw session and turn IDs remain available for inspection in the TrueForge UI. Agent mode preloads seven essential discovery, read, edit, apply and command schemas so the model can invoke them immediately. Secondary tools remain deferred. Review and Ask preload `list_files` and `search_context`. Compaction is enabled. A tool schema being deferred or compaction being enabled does not prove either happened in a particular run; only claim observed events.

Command inputs split the executable from its argument array. For example, Node built-in tests use `{"executable":"node","args":["--test","app.test.cjs"],"reason":"Verify the fix"}`. A plain `node app.test.cjs` invocation is an arbitrary script and requires approval. If the editor cannot show an approval prompt, the tool returns the policy reason so the model can correct an accidental invocation without broadening execution permissions.

## Version-specific approval lifecycle

The published 0.183.1 runtime exits its turn on a gated tool and emits `turn.done` with pending `required_actions`. After the user reviews, the adapter creates the next turn in the same session with `user.tool_approval` input only. It never mixes approval responses with a new user message. The stream operation stays pending in the extension while waiting for that decision, so cancellation also works during review.

The 0.183.0 generated SDK also exposes `createTurnEvent`, but that server release's handler only constructs a response and does not enqueue it into the running agent. Therefore this adapter deliberately does not use that method. Current online documentation describes a newer same-turn pause/resume lifecycle for 0.185.0+, which must not be copied into this pinned integration without updating and exercising the actual server.

The SDK's automatic retries are disabled for turn POSTs. Replaying a partially completed turn can duplicate tool calls. The extension must discard its staged proposal and start a fresh session before a retry or model fallback. The adapter throws explicit provider and premature-disconnect errors, stops its stream immediately on cancellation, and sends a separately bounded server cancel request. A server 412 during cancellation of an already-ended legacy approval turn is harmless.

`getAvailability()` queries the actual configured-model API without invoking a model. It distinguishes a running harness with no models, a reachable configured catalog, denied API access, and an unreachable local API. A configured catalog does not prove that its provider accepts generation requests; `pingModel` performs that separate check. Google Gemini HTTP 403 project-access denials and disabled-service responses are reported separately from invalid-key errors. Follow the project's notices in Google AI Studio/Google Cloud or enable the required API when that is the actual reported cause. [Google's API error reference](https://ai.google.dev/gemini-api/docs/generate-content/api-errors) and [AI Studio troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshoot-ai-studio) describe permissions and project access.

## Verification status

This adapter was written against the actual published package declarations and runtime source for the pinned versions. Sixteen transport/configuration regression tests run the official SDK against deterministic HTTP responses. They cover the streaming and Review lifecycle, Gateway configuration, isolated pings, session updates, mode policies, credential-safe Google project/disabled-API failures and model-API availability. Eight real HTTP MCP tests cover authenticated tool discovery, request boundaries, cancellation, argument dispatch, Agent tools and Ask-mode mutation denial.

`scripts/test-trueforge.mjs` additionally passed against the **actual local TrueForge 0.183.1 server**, the authenticated MCP bridge and a deterministic local provider fixture. Its 22 provider requests cover native Gateway configuration, an unchanged upstream model ID and tenant API path, a model ping, deferred tool loading, the real Review gate and approval-only resume, and conversation continuity after rotating its bridge. A separate Agent run writes a real temporary fixture file, runs an actual Node test that fails, sends the assertion failure back through TrueForge, revises and applies the correction, and reruns the test successfully. The observed command exit codes are `1` then `0`, with no generic Agent review approvals. This uses a simple fixture edit/command handler to isolate harness behavior; it does not prove the production VS Code handler or a genuine model made these choices. Temporary files and SQLite state are removed afterward. Run it after `tsc -p tsconfig.test.json`; local listener permission is needed. No paid or external model call is made.

These fixture results are distinct from the native editor and genuine external-model checks recorded in `VALIDATION.md`. They establish transport behavior, not general model coding quality.

## Primary references

- [TrueForge source and MIT licence](https://github.com/truefoundry/trueforge)
- [Official SDK quickstart](https://github.com/truefoundry/trueforge/blob/main/docs/api/quickstart.mdx)
- [Official agent and MCP configuration](https://github.com/truefoundry/trueforge/blob/main/docs/create-agent/overview.mdx)
- [Current SDK lifecycle documentation](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx) — consult the version warning.
- Published npm packages `@truefoundry/trueforge@0.183.1`, `@truefoundry/trueforge-core@0.183.1`, and `@truefoundry/trueforge-sdk@0.183.0`: the implementation's source of truth for approval behavior.
