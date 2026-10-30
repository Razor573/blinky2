import { invoke } from '@tauri-apps/api/core';

export interface PingResult {
  ok: boolean;
  provider: string;
  model: string;
  latency_ms: number;
  status_code: number;
  error?: string;
  details?: string;
}

export async function pingModel(
  provider: string,
  apiKey?: string,
  model?: string,
  customUrl?: string,
  projectId?: string
): Promise<PingResult> {
  const prov = (provider || 'gemini').toLowerCase().trim();
  const activeModel = model || (prov === 'codex' ? 'gpt-5.5' : prov === 'openai' ? 'gpt-4o-mini' : 'gemini-3.8-flash');

  try {
    const result = await invoke<PingResult>('ping_ai_model', {
      provider: prov,
      model: activeModel,
      apiKey: apiKey?.trim() || null,
      projectId: projectId?.trim() || null,
      customUrl: customUrl?.trim() || null,
    });
    return result;
  } catch (err: any) {
    return {
      ok: false,
      provider: prov,
      model: activeModel,
      latency_ms: 0,
      status_code: 500,
      error: String(err?.message || err || 'Ping failed'),
      details: String(err?.message || err || 'Failed to invoke native ping_ai_model'),
    };
  }
}
