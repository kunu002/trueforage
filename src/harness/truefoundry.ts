import { createHash } from 'node:crypto';

export interface TrueFoundryConfig {
  /** Copy the complete OpenAI-compatible Base URL from the Gateway Code Snippet. */
  gatewayUrl: string;
  /** TrueFoundry PAT or VAT. This must never be stored in VS Code settings. */
  apiKey: string;
  /** Exact upstream ID from TrueFoundry, including any provider-account prefix. */
  modelId: string;
  /** Omit for the native truefoundry provider; another name creates an isolated custom provider. */
  providerName?: string;
}

export interface ConfiguredTrueFoundry {
  /** Fully qualified model name to use when creating a TrueForge session. */
  model: string;
  provider: string;
  modelId: string;
  gatewayUrl: string;
}

const resourceName = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function normalizeGatewayUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new Error('Enter the Gateway Base URL from the TrueFoundry Playground Code Snippet.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('A remote TrueFoundry Gateway must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The Gateway Base URL must not include credentials, a query string, or a fragment.');
  }
  if (/\/(?:chat\/completions|models|responses)\/?$/.test(url.pathname)) {
    throw new Error('Enter the Gateway Base URL, without a /chat/completions, /models, or /responses endpoint.');
  }
  // Preserve tenant and reverse-proxy paths exactly. Different Gateway versions
  // use different roots; adding /api/llm or /v1 here can break a valid endpoint.
  return url.toString().replace(/\/+$/, '');
}

export function validateTrueFoundryConfig(config: TrueFoundryConfig): Required<TrueFoundryConfig> {
  const gatewayUrl = normalizeGatewayUrl(config.gatewayUrl);
  const apiKey = config.apiKey.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Enter a valid TrueFoundry API key (PAT or VAT).');
  const modelId = config.modelId.trim();
  if (!modelId || /\s/.test(modelId) || modelId.length > 512) {
    throw new Error('Enter the exact model ID from the TrueFoundry Code Snippet, including its provider-account prefix.');
  }
  const providerName = config.providerName?.trim() || 'truefoundry';
  if (!resourceName.test(providerName)) {
    throw new Error('The TrueForge provider name must be 2–64 lowercase letters, digits, or hyphens, starting with a letter.');
  }
  return { gatewayUrl, apiKey, modelId, providerName };
}

/** Upstream model IDs may contain slashes/dots; TrueForge local names cannot. */
export function trueFoundryModelAlias(modelId: string): string {
  let slug = modelId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(slug)) slug = `model-${slug}`;
  slug = slug.slice(0, 54).replace(/-+$/, '') || 'model';
  const suffix = createHash('sha256').update(modelId).digest('hex').slice(0, 8);
  return `${slug}-${suffix}`;
}
