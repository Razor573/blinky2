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
  apiKey: string,
  model?: string,
  customUrl?: string
): Promise<PingResult> {
  const t0 = Date.now();
  const prov = (provider || 'gemini').toLowerCase().trim();

  try {
    // 1. Google Gemini
    if (prov === 'gemini' || prov === 'google') {
      const activeModel = model || 'gemini-3.8-flash';
      if (!apiKey?.trim()) {
        return {
          ok: false,
          provider: prov,
          model: activeModel,
          latency_ms: 0,
          status_code: 401,
          error: 'Missing Gemini API Key',
          details: 'Please enter your Google Gemini API key in Settings.',
        };
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0.0 },
        }),
      });

      const latency = Date.now() - t0;
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          ok: true,
          provider: prov,
          model: activeModel,
          latency_ms: latency,
          status_code: 200,
          details: `Online (${latency}ms)`,
        };
      }

      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      return {
        ok: false,
        provider: prov,
        model: activeModel,
        latency_ms: latency,
        status_code: res.status,
        error: errMsg,
        details: res.status === 404 ? `Model not found or retired (${activeModel})` : errMsg,
      };
    }

    // 2. OpenAI
    if (prov === 'openai') {
      const activeModel = model || 'gpt-4o-mini';
      if (!apiKey?.trim()) {
        return {
          ok: false,
          provider: prov,
          model: activeModel,
          latency_ms: 0,
          status_code: 401,
          error: 'Missing OpenAI API Key',
          details: 'Please enter your OpenAI API key in Settings.',
        };
      }

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: activeModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });

      const latency = Date.now() - t0;
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          ok: true,
          provider: prov,
          model: activeModel,
          latency_ms: latency,
          status_code: 200,
          details: `Online (${latency}ms)`,
        };
      }

      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      return {
        ok: false,
        provider: prov,
        model: activeModel,
        latency_ms: latency,
        status_code: res.status,
        error: errMsg,
        details: res.status === 404 ? `Model not found (${activeModel})` : errMsg,
      };
    }

    // 3. Anthropic
    if (prov === 'anthropic') {
      const activeModel = model || 'claude-haiku-4-5-20251001';
      if (!apiKey?.trim()) {
        return {
          ok: false,
          provider: prov,
          model: activeModel,
          latency_ms: 0,
          status_code: 401,
          error: 'Missing Anthropic API Key',
          details: 'Please enter your Anthropic API key in Settings.',
        };
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey.trim(),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: activeModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });

      const latency = Date.now() - t0;
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          ok: true,
          provider: prov,
          model: activeModel,
          latency_ms: latency,
          status_code: 200,
          details: `Online (${latency}ms)`,
        };
      }

      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      return {
        ok: false,
        provider: prov,
        model: activeModel,
        latency_ms: latency,
        status_code: res.status,
        error: errMsg,
        details: errMsg,
      };
    }

    // 4. Ollama
    if (prov === 'ollama') {
      const activeModel = model || 'qwen2.5:7b';
      const base = (customUrl || 'http://localhost:11434').replace(/\/+$/, '');
      const res = await fetch(`${base}/api/tags`);
      const latency = Date.now() - t0;
      if (res.ok) {
        return {
          ok: true,
          provider: prov,
          model: activeModel,
          latency_ms: latency,
          status_code: 200,
          details: `Online (${latency}ms) • Local daemon`,
        };
      }
      return {
        ok: false,
        provider: prov,
        model: activeModel,
        latency_ms: latency,
        status_code: res.status,
        error: `Ollama HTTP ${res.status}`,
        details: 'Ollama local daemon did not respond.',
      };
    }

    // 5. Custom OpenAI-compatible
    if (prov === 'custom') {
      const activeModel = model || 'default';
      const base = (customUrl || '').replace(/\/+$/, '');
      if (!base) {
        return {
          ok: false,
          provider: prov,
          model: activeModel,
          latency_ms: 0,
          status_code: 400,
          error: 'Missing Custom URL',
          details: 'Please enter custom endpoint URL.',
        };
      }

      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey?.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: activeModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });

      const latency = Date.now() - t0;
      if (res.ok) {
        return {
          ok: true,
          provider: prov,
          model: activeModel,
          latency_ms: latency,
          status_code: 200,
          details: `Online (${latency}ms)`,
        };
      }

      return {
        ok: false,
        provider: prov,
        model: activeModel,
        latency_ms: latency,
        status_code: res.status,
        error: `HTTP ${res.status}`,
        details: `Endpoint returned HTTP ${res.status}`,
      };
    }

    // 6. Vertex, Antigravity, Codex (System / OAuth managed environments)
    if (prov === 'vertex' || prov === 'antigravity' || prov === 'codex') {
      const latency = Date.now() - t0;
      return {
        ok: true,
        provider: prov,
        model: model || 'default',
        latency_ms: latency,
        status_code: 200,
        details: `Configured (${prov})`,
      };
    }

    return {
      ok: false,
      provider: prov,
      model: model || 'unknown',
      latency_ms: 0,
      status_code: 400,
      error: `Unsupported provider: ${provider}`,
      details: 'Supported: gemini, vertex, antigravity, codex, openai, anthropic, custom, ollama',
    };
  } catch (err: any) {
    return {
      ok: false,
      provider: prov,
      model: model || 'unknown',
      latency_ms: Date.now() - t0,
      status_code: 0,
      error: err?.message || 'Network error',
      details: `Failed to connect: ${err?.message || 'Check network connection'}`,
    };
  }
}
