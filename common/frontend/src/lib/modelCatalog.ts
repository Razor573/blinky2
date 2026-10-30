import { invoke } from '@tauri-apps/api/core';

export interface DynamicModelItem {
  id: string;
  name: string;
  desc?: string;
  badge?: string;
  tier?: 'fast' | 'smart';
  isCustom?: boolean;
}

export const AUTO_MODEL_ITEM: DynamicModelItem = {
  id: 'auto',
  name: 'Auto (Intelligent Routing)',
  badge: 'Auto',
  desc: 'Dynamically routes between fast and deep reasoning models based on query complexity',
  tier: 'smart',
};

export const CUE_GEMINI_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', badge: 'Default Fast', desc: 'Current generation Flash model (Aug 2026)', tier: 'fast' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', badge: 'Fast', desc: 'High-speed multimodal reasoning', tier: 'fast' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', badge: 'Fast', desc: 'Fast multimodal', tier: 'fast' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', badge: 'Fast', desc: 'Balanced accuracy & speed', tier: 'fast' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', badge: 'Ultra-Fast', desc: 'Quota-friendly low latency', tier: 'fast' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', badge: 'Lite', desc: 'Lightweight model', tier: 'fast' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', badge: 'Smart', desc: 'Advanced reasoning model', tier: 'smart' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', badge: 'Flagship', desc: 'Deep intelligence & long context', tier: 'smart' },
];

export const CUE_VERTEX_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', badge: 'Default Fast', desc: 'Vertex enterprise fast model', tier: 'fast' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', badge: 'Smart', desc: 'Vertex enterprise deep reasoning', tier: 'smart' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', badge: 'Pro', desc: 'Vertex enterprise preview', tier: 'smart' },
];

export const CUE_ANTIGRAVITY_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', badge: 'Default Fast', desc: 'Google Antigravity fast tier', tier: 'fast' },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', badge: 'Smart', desc: 'Google Antigravity high-reasoning tier', tier: 'smart' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', badge: 'Flash', desc: 'Fast inference', tier: 'fast' },
];

export const CUE_CODEX_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'gpt-5.5', name: 'GPT-5.5', badge: 'Fast', desc: 'Codex fast completion', tier: 'fast' },
  { id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', badge: 'Default Smart', desc: 'Codex full reasoning', tier: 'smart' },
  { id: 'gpt-5.4-codex', name: 'GPT-5.4 Codex', badge: 'Smart', desc: 'High capability code model', tier: 'smart' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', badge: 'Codex', desc: 'Stable code intelligence', tier: 'smart' },
];

export const CUE_OPENAI_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', badge: 'Default Fast', desc: 'Fast multimodal chat', tier: 'fast' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', badge: 'Fast', desc: 'Next-gen mini reasoning', tier: 'fast' },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', badge: 'Ultra-Fast', desc: 'Lowest latency completion', tier: 'fast' },
  { id: 'gpt-4o', name: 'GPT-4o', badge: 'Smart', desc: 'High capability flagship', tier: 'smart' },
  { id: 'gpt-4.1', name: 'GPT-4.1', badge: 'Smart', desc: 'Advanced flagship reasoning', tier: 'smart' },
  { id: 'o3-mini', name: 'o3-mini', badge: 'Reasoning', desc: 'Deep math and code reasoning', tier: 'smart' },
];

export const CUE_ANTHROPIC_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', badge: 'Default Fast', desc: 'Ultra-fast Claude 4.5', tier: 'fast' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', badge: 'Default Smart', desc: 'Top-tier code and vision reasoning', tier: 'smart' },
];

export const DEFAULT_OLLAMA_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', badge: 'Recommended', desc: 'Local instruction-following model', tier: 'fast' },
  { id: 'llama3.2:latest', name: 'Llama 3.2', badge: 'Fast Local', desc: 'Lightweight local model', tier: 'fast' },
  { id: 'deepseek-r1:8b', name: 'DeepSeek R1 8B', badge: 'Local Reasoning', desc: 'Local reasoning model', tier: 'smart' },
];

export const DEFAULT_GROQ_CATALOG: DynamicModelItem[] = [
  AUTO_MODEL_ITEM,
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', badge: 'Fast', desc: 'Low-latency Groq inference', tier: 'fast' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', badge: 'Smart', desc: '70B versatile reasoning', tier: 'smart' },
  { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', badge: 'Actuator', desc: 'Vision actuator', tier: 'fast' },
];

export function getCuratedCatalog(provider: string): DynamicModelItem[] {
  const prov = (provider || 'gemini').toLowerCase().trim();
  switch (prov) {
    case 'gemini':
    case 'google':
      return CUE_GEMINI_CATALOG;
    case 'vertex':
      return CUE_VERTEX_CATALOG;
    case 'antigravity':
      return CUE_ANTIGRAVITY_CATALOG;
    case 'codex':
      return CUE_CODEX_CATALOG;
    case 'openai':
      return CUE_OPENAI_CATALOG;
    case 'anthropic':
      return CUE_ANTHROPIC_CATALOG;
    case 'ollama':
      return DEFAULT_OLLAMA_CATALOG;
    case 'groq':
      return DEFAULT_GROQ_CATALOG;
    case 'custom':
    default:
      return [{ id: 'default', name: 'Custom Default', badge: 'Custom', desc: 'Custom OpenAI-compatible model' }];
  }
}

export async function fetchDynamicModels(
  provider: string,
  apiKey?: string,
  customUrl?: string
): Promise<{ models: DynamicModelItem[]; error?: string; isLive: boolean }> {
  const prov = (provider || 'gemini').toLowerCase().trim();
  const fallback = getCuratedCatalog(prov);

  try {
    const fetched = await invoke<DynamicModelItem[]>('fetch_provider_models', {
      provider: prov,
      apiKey: apiKey?.trim() || null,
      customUrl: customUrl?.trim() || null,
    });
    if (Array.isArray(fetched) && fetched.length > 0) {
      return { models: fetched, isLive: true };
    }
  } catch (err: any) {
    console.warn(`[modelCatalog] Native fetch_provider_models failed for ${prov}, falling back to Cue catalog:`, err);
    return { models: fallback, error: String(err?.message || err), isLive: false };
  }

  return { models: fallback, isLive: false };
}
