import { emit, listen } from '@tauri-apps/api/event';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowUp, Bot, Loader2, Minus, Sparkles, X, Settings, Check, Mic, Volume2, Globe, Square, QrCode, Paperclip, Film, Image as ImageIcon, Music, FileVideo, BookOpen, Cpu, Zap, Brain, Cloud, Wrench, Key, Smartphone, MessageSquare, Command, Palette, Info, Clock, Trash2, Plus, Search, ChevronDown, Edit3, RefreshCw, Sliders } from 'lucide-react';
import { AnchorHTMLAttributes, FormEvent, useEffect, useRef, useState, cloneElement, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import QRCode from 'qrcode';
import { runAutopilotLoop, extractTextToType, shouldPressEnterAfterTyping, isScrollAction, getScrollDirection, isClickInstruction, isSingleActionQuery, createEmptyTutorResult, getPhysicalClickablePoint } from './lib/autopilot';
import {
  getCurrentGuideSteps,
  getDisplaySteps,
  getHighlightSteps,
  mergeGuideHistory,
  shouldCompleteStepOnHighlightClick,
  shouldShowSummaryBubble,
} from './lib/guidance';
import { runTutor, cancelTutor, showOverlay, hideOverlay, resizeCommandWindow, setCommandWindowSize, getSettings, saveSettings, resizeAndMoveCommandWindow, clickElement, clickScreenPoint, openUrl, openFolder, typeText, scrollAtPoint, pauseWakeWord, resumeWakeWord, logDebugMessage, confirmRecipeSave, setAgentCursorVisibility, getSecureTransportInfo, getMobilePairingPayload, regenerateRemoteToken, openNotebookWindow } from './lib/tauri';

import { linkCitationMarkers, preprocessMarkdown } from './lib/citations';
import {
  fetchDynamicModels,
  getCuratedCatalog,
  CUE_GEMINI_CATALOG,
  type DynamicModelItem,
} from './lib/modelCatalog';
import { getSarvamErrorMessage } from './lib/tts';
import { SarvamSpeechToTextStream, SarvamTextToSpeechStream } from './lib/sarvamStream';
import {
  AssemblyAIVoiceAgent,
  AssemblyAIRealtimeSTT,
  transcribeAudioWithAssemblyAI,
  floatTo16BitPCM,
  playPCM16Audio
} from './lib/assemblyaiVoice';
import { AdaptiveTransportManager } from './lib/adaptiveTransport';
import type { TutorConversationMessage, TutorProgress, TutorResult } from './lib/types';
import type { SecureTransportInfo, MobilePairingPayload } from './lib/tauri';
import { pingModel, type PingResult } from './lib/modelPing';
import {
  listPcChatSessions,
  getActivePcSession,
  savePcChatSession,
  createPcChatSession,
  deletePcChatSession,
  clearAllPcChatSessions,
  switchPcChatSession,
  generatePcSessionTitle,
  type PcChatSession,
} from './lib/sessionStorage';


interface AttachedMedia {
  path: string;
  name: string;
  type: 'video' | 'image' | 'audio' | 'other';
  previewUrl?: string;
}

function getMediaType(filePath: string): 'video' | 'image' | 'audio' | 'other' {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma'].includes(ext)) return 'audio';
  return 'other';
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

interface TargetClickedPayload {
  step?: number;
  target_text?: string;
  instruction?: string;
}

interface TutorRunOptions {
  resetProgress?: boolean;
  preserveStepsDuringRun?: boolean;
}

function getLinkText(children: AnchorHTMLAttributes<HTMLAnchorElement>['children']): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(getLinkText).join('');
  }

  return '';
}

function ExternalMarkdownLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const linkText = getLinkText(children);
  const isCitation = /^\d+$/.test(linkText);

  return (
    <a
      href={href}
      className={isCitation ? 'citation-link' : 'markdown-link'}
      title={isCitation ? `Open source [${linkText}]` : href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (href) {
          void openUrl(href);
        }
      }}
    >
      {isCitation ? `[${linkText}]` : children}
    </a>
  );
}


interface MaskedKeyInputProps {
  label: string;
  icon: React.ReactNode;
  envName: string;
  isConfigured: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
  description: string;
  testAction?: () => void;
  testDisabled?: boolean;
}

function MaskedKeyInput({
  label,
  icon,
  envName,
  isConfigured,
  onSave,
  onClear,
  description,
  testAction,
  testDisabled,
}: MaskedKeyInputProps) {
  const [draft, setDraft] = useState('');

  const handleCommit = () => {
    if (draft.trim()) {
      onSave(draft.trim());
      setDraft('');
    }
  };

  return (
    <div className="settings-section-card settings-key-card">
      <div className="settings-input-header">
        <label className="settings-label">
          {icon}
          <span>{label}</span>
          {isConfigured ? (
            <span className="key-badge-configured">
              <Check size={10} /> Configured
            </span>
          ) : (
            <span className="key-badge-unconfigured">Not set</span>
          )}
        </label>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {testAction && (
            <button
              type="button"
              className="settings-btn-action"
              style={{ padding: '2px 8px', fontSize: '10px' }}
              onClick={testAction}
              disabled={testDisabled || !isConfigured}
            >
              Test ⚡
            </button>
          )}
          {isConfigured && (
            <button
              type="button"
              className="key-btn-clear"
              onClick={() => {
                setDraft('');
                onClear();
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          type="password"
          className="settings-text-input"
          placeholder={isConfigured ? '•••••••••••••••• (Enter new key to replace)' : `Enter ${envName}...`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCommit();
            }
          }}
          onBlur={handleCommit}
          autoComplete="new-password"
          spellCheck={false}
        />
        {draft.trim().length > 0 && (
          <button
            type="button"
            className="key-btn-save"
            onClick={handleCommit}
          >
            Save
          </button>
        )}
      </div>
      <p className="settings-help-text">{description}</p>
    </div>
  );
}

/** Renders the desktop command bar and coordinates its interactive workflows. */
export function CommandBar() {
  const [question, setQuestion] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedMedia[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addAttachedFiles = (paths: string[]) => {
    setAttachedFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      const newItems: AttachedMedia[] = [];
      for (const p of paths) {
        if (!existing.has(p) && p.trim()) {
          const type = getMediaType(p);
          let previewUrl: string | undefined = undefined;
          try {
            if (type === 'image') {
              previewUrl = convertFileSrc(p);
            }
          } catch {
            // ignore
          }
          newItems.push({
            path: p,
            name: getFileName(p),
            type,
            previewUrl,
          });
          existing.add(p);
        }
      }
      return [...prev, ...newItems];
    });
  };

  const removeAttachedFile = (pathToRemove: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.path !== pathToRemove));
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const nativePath = (file as any).path || (file as any).webkitRelativePath || file.name;
      if (nativePath) paths.push(nativePath);
    }
    addAttachedFiles(paths);
    e.target.value = '';
  };

  const [isRunning, setIsRunning] = useState(false);
  const [isTaskCompleted, setIsTaskCompleted] = useState(false);
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [agentModeEnabled, setAgentModeEnabled] = useState(false);
  const defaultStatus = 'Ask anything on your screen';


  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    startX: number;
    initialWidth: number;
    initialHeight: number;

    initialX: number;
    initialY: number;
    scaleFactor: number;
    side: 'left' | 'right';
  } | null>(null);

  const startResize = async (event: React.PointerEvent<HTMLDivElement>, side: 'left' | 'right') => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const appWindow = getCurrentWindow();
    const size = await appWindow.innerSize();
    const position = await appWindow.outerPosition();
    const scaleFactor = await appWindow.scaleFactor();

    resizeRef.current = {
      startX: event.screenX,
      initialWidth: size.width / scaleFactor,
      initialHeight: size.height / scaleFactor,
      initialX: position.x / scaleFactor,
      initialY: position.y / scaleFactor,
      scaleFactor,
      side
    };
    setIsResizing(true);
  };

  const handleResize = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || !resizeRef.current) return;

    const { startX, initialWidth, initialHeight, initialX, initialY, scaleFactor, side } = resizeRef.current;
    const dx = (event.screenX - startX) / scaleFactor;

    if (side === 'right') {
      const newWidth = Math.max(560, initialWidth + dx);
      await resizeAndMoveCommandWindow(initialX, initialY, newWidth, initialHeight);
    } else if (side === 'left') {
      const newWidth = Math.max(560, initialWidth - dx);
      const newX = initialX + (initialWidth - newWidth);
      await resizeAndMoveCommandWindow(newX, initialY, newWidth, initialHeight);
    }
  };

  const stopResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsResizing(false);
    resizeRef.current = null;
  };
  const [status, setStatus] = useState(defaultStatus);
  const statusRef = useRef(defaultStatus);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const [spokenStatus, setSpokenStatus] = useState<string>('');
  const [isTtsActive, setIsTtsActive] = useState<boolean>(false);
  const [steps, setSteps] = useState<any[]>([]);
  const [showGuideCompletionSummary, setShowGuideCompletionSummary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    if (showSettings) {
      void checkOAuthStatus('antigravity');
      void checkOAuthStatus('codex');
    }
  }, [showSettings]);
  const [showHistory, setShowHistory] = useState(false);
  const [pcSessions, setPcSessions] = useState<PcChatSession[]>([]);
  const [activePcSession, setActivePcSession] = useState<PcChatSession | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);
  const historyToggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const initial = getActivePcSession();
    setActivePcSession(initial);
    setPcSessions(listPcChatSessions());
    if (initial.messages.length > 0) {
      conversationHistoryRef.current = initial.messages.slice(-8).map((m) => ({
        role: m.role === 'user' ? 'student' : 'blinky',
        content: m.text,
      }));
    }
  }, []);
  const [provider, setProvider] = useState('gemini');
  const [vertexProjectId, setVertexProjectId] = useState<string>(() => {
    return localStorage.getItem('clinky_vertex_project_id') || '';
  });
  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => {
    return localStorage.getItem('clinky_openai_api_key') || '';
  });
  const [anthropicApiKey, setAnthropicApiKey] = useState<string>(() => {
    return localStorage.getItem('clinky_anthropic_api_key') || '';
  });

  const updateAnthropicApiKey = (val: string) => {
    const clean = val.trim();
    setAnthropicApiKey(clean);
    if (clean) {
      localStorage.setItem('clinky_anthropic_api_key', clean);
    } else {
      localStorage.removeItem('clinky_anthropic_api_key');
    }
    void persistAllSettings({ anthropicApiKey: clean });
  };

  const updateVertexProjectId = (val: string) => {
    const clean = val.trim();
    setVertexProjectId(clean);
    if (clean) {
      localStorage.setItem('clinky_vertex_project_id', clean);
    } else {
      localStorage.removeItem('clinky_vertex_project_id');
    }
  };

  const updateOpenaiApiKey = (val: string) => {
    const clean = val.trim();
    setOpenaiApiKey(clean);
    if (clean) {
      localStorage.setItem('clinky_openai_api_key', clean);
    } else {
      localStorage.removeItem('clinky_openai_api_key');
    }
  };
  const [shortcut, setShortcut] = useState('Enter');
  const defaultAaiKey = (import.meta as any).env?.VITE_ASSEMBLY_AI_API_KEY || '';
  const [sarvamApiKey, setSarvamApiKey] = useState('');
  const [assemblyaiApiKey, setAssemblyaiApiKey] = useState(defaultAaiKey);
  const assemblyaiApiKeyRef = useRef(defaultAaiKey);
  const [voiceProvider, setVoiceProvider] = useState<'assemblyai' | 'sarvam'>('assemblyai');
  const voiceProviderRef = useRef<'assemblyai' | 'sarvam'>('assemblyai');
  // Always realtime agent (thinks while you speak) — no mode toggle.
  const [assemblyaiVoiceMode] = useState<'agent' | 'realtime_stt'>('agent');
  const assemblyaiAgentRef = useRef<AssemblyAIVoiceAgent | null>(null);
  const assemblyaiSttRef = useRef<AssemblyAIRealtimeSTT | null>(null);
  const assemblyaiAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [groqApiKey, setGroqApiKey] = useState('');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [transportInfo, setTransportInfo] = useState<SecureTransportInfo | null>(null);
  const [pingTesting, setPingTesting] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);

  // Agent 1: Computer-Use / Actuator
  const [agent1Model, setAgent1Model] = useState<string>(() => {
    return localStorage.getItem('blinky_agent1_model') || 'gemini-3.8-flash';
  });
  const [agent1SearchQuery, setAgent1SearchQuery] = useState<string>('');
  const [isAgent1SearchOpen, setIsAgent1SearchOpen] = useState<boolean>(false);
  const [showAgent1Config, setShowAgent1Config] = useState<boolean>(false);
  const [agent1ModelsList, setAgent1ModelsList] = useState<DynamicModelItem[]>(getCuratedCatalog('gemini'));
  const [agent1ModelsLoading, setAgent1ModelsLoading] = useState<boolean>(false);
  const agent1FetchSeqRef = useRef<number>(0);

  const getProviderKey = (prov: string) => {
    switch (prov.toLowerCase().trim()) {
      case 'gemini':
      case 'google':
        return geminiApiKey;
      case 'openai':
        return openaiApiKey;
      case 'anthropic':
        return anthropicApiKey;
      case 'custom':
        return customApiKey;
      case 'groq':
        return groqApiKey;
      case 'deepseek':
        return deepseekApiKey;
      default:
        return '';
    }
  };

  const updateAgent1Model = (newModel: string) => {
    const clean = newModel.trim();
    if (!clean) return;
    setAgent1Model(clean);
    localStorage.setItem('blinky_agent1_model', clean);
    void persistAllSettings({ modelName: clean });
    if (provider.toLowerCase().trim() === 'custom') {
      void updateCustomModel(clean);
    }
  };

  const refreshAgent1Models = async (
    prov = provider,
    overrideKey?: string,
    overrideUrl = customUrl
  ) => {
    const seq = ++agent1FetchSeqRef.current;
    setAgent1ModelsLoading(true);
    const key = overrideKey !== undefined ? overrideKey : getProviderKey(prov);
    try {
      const res = await fetchDynamicModels(prov, key, overrideUrl);
      if (seq === agent1FetchSeqRef.current && res.models && res.models.length > 0) {
        setAgent1ModelsList(res.models);
      }
    } catch (e) {
      console.warn('Failed to fetch Agent 1 models dynamically:', e);
    } finally {
      if (seq === agent1FetchSeqRef.current) {
        setAgent1ModelsLoading(false);
      }
    }
  };

  // Location and STT Configuration
  const [vertexLocation, setVertexLocation] = useState<string>(() => {
    return localStorage.getItem('clinky_vertex_location') || 'global';
  });
  const updateVertexLocation = (val: string) => {
    setVertexLocation(val);
    localStorage.setItem('clinky_vertex_location', val);
  };

  // Reasoning & Thinking Level
  const [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high'>(() => {
    return (localStorage.getItem('blinky_thinking_level') as any) || 'medium';
  });
  const updateThinkingLevel = (level: 'off' | 'low' | 'medium' | 'high') => {
    setThinkingLevel(level);
    localStorage.setItem('blinky_thinking_level', level);
  };

  // STT & Voice Models Configuration
  const [primarySttModel, setPrimarySttModel] = useState<string>(() => {
    return localStorage.getItem('blinky_primary_stt_model') || localStorage.getItem('blinky_stt_provider') || 'gemini-3.5-transcribe';
  });
  const updatePrimarySttModel = (val: string) => {
    setPrimarySttModel(val);
    setSttProvider(val);
    localStorage.setItem('blinky_primary_stt_model', val);
    localStorage.setItem('blinky_stt_provider', val);
  };

  const [fallbackSttModel, setFallbackSttModel] = useState<string>(() => {
    return localStorage.getItem('blinky_fallback_stt_model') || 'gemini-3.5-flash-lite';
  });
  const updateFallbackSttModel = (val: string) => {
    setFallbackSttModel(val);
    localStorage.setItem('blinky_fallback_stt_model', val);
  };

  const [primaryLiveModel, setPrimaryLiveModel] = useState<string>(() => {
    return localStorage.getItem('blinky_primary_live_model') || 'gemini-3.5-transcribe-live';
  });
  const updatePrimaryLiveModel = (val: string) => {
    setPrimaryLiveModel(val);
    localStorage.setItem('blinky_primary_live_model', val);
  };

  const [fallbackLiveModel, setFallbackLiveModel] = useState<string>(() => {
    return localStorage.getItem('blinky_fallback_live_model') || 'gemini-3.5-flash-lite';
  });
  const updateFallbackLiveModel = (val: string) => {
    setFallbackLiveModel(val);
    localStorage.setItem('blinky_fallback_live_model', val);
  };

  const [autoRateLimitFallback, setAutoRateLimitFallback] = useState<boolean>(() => {
    const saved = localStorage.getItem('blinky_auto_rate_limit_fallback');
    return saved === null ? true : saved === 'true';
  });
  const updateAutoRateLimitFallback = (val: boolean) => {
    setAutoRateLimitFallback(val);
    localStorage.setItem('blinky_auto_rate_limit_fallback', String(val));
  };

  const [sttProvider, setSttProvider] = useState<string>(() => {
    return localStorage.getItem('blinky_primary_stt_model') || localStorage.getItem('blinky_stt_provider') || 'gemini-3.5-transcribe';
  });
  const updateSttProvider = (val: string) => {
    updatePrimarySttModel(val);
  };

  // Vertex AI Service Account JSON
  const [showVertexSaKey, setShowVertexSaKey] = useState<boolean>(false);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [appLogsContent, setAppLogsContent] = useState<string>('');
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);

  const handleViewLogs = async () => {
    setLoadingLogs(true);
    try {
      const logs = await invoke<string>('get_application_logs', { limit: 250 });
      setAppLogsContent(logs);
      setShowLogsModal(true);
    } catch (e: any) {
      setAppLogsContent(String(e?.message || e || 'Failed to read logs'));
      setShowLogsModal(true);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleOpenLogsFolder = async () => {
    try {
      await invoke('open_logs_folder');
    } catch (e: any) {
      console.error('Failed to open logs folder:', e);
    }
  };

  const handleClearLogs = async () => {
    try {
      await invoke('clear_application_logs');
      setAppLogsContent('');
    } catch (e: any) {
      console.error('Failed to clear logs:', e);
    }
  };

  const [vertexServiceAccountJson, setVertexServiceAccountJson] = useState<string>(() => {
    return localStorage.getItem('clinky_vertex_service_account_json') || '';
  });
  const [vertexParsedSa, setVertexParsedSa] = useState<{ projectId?: string; clientEmail?: string; valid: boolean } | null>(() => {
    const raw = localStorage.getItem('clinky_vertex_service_account_json') || '';
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email) {
        return { projectId: parsed.project_id, clientEmail: parsed.client_email, valid: true };
      }
    } catch {}
    return { valid: false };
  });

  const updateVertexServiceAccountJson = (raw: string) => {
    setVertexServiceAccountJson(raw);
    if (raw.trim()) {
      localStorage.setItem('clinky_vertex_service_account_json', raw);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.project_id && parsed.client_email) {
          setVertexParsedSa({ projectId: parsed.project_id, clientEmail: parsed.client_email, valid: true });
          if (!vertexProjectId.trim()) {
            updateVertexProjectId(parsed.project_id);
          }
          return;
        }
      } catch {}
      setVertexParsedSa({ valid: false });
    } else {
      localStorage.removeItem('clinky_vertex_service_account_json');
      setVertexParsedSa(null);
    }
  };

  // Audio helper utilities: Base64 conversion, Gemini STT with fallback, Whisper STT
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = reject;
    });
  };

  const transcribeWithGemini = async (blob: Blob, requestedModel?: string): Promise<string> => {
    const key = geminiApiKey || (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
    const base64Audio = await blobToBase64(blob);
    const targetModel = requestedModel || primarySttModel || 'gemini-3.5-transcribe';
    try {
      const transcript = await invoke<string>('transcribe_audio_native', {
        engine: 'gemini',
        model: targetModel,
        audioBase64: base64Audio,
        mimeType: blob.type || 'audio/webm',
        apiKey: key || null,
        fallbackModel: autoRateLimitFallback && fallbackSttModel !== 'none' ? fallbackSttModel : null,
      });
      return transcript;
    } catch (err: any) {
      console.error('Native Gemini STT error:', err);
      throw err;
    }
  };

  const transcribeWithWhisper = async (blob: Blob, key: string, model = 'whisper-1'): Promise<string> => {
    const base64Audio = await blobToBase64(blob);
    try {
      const transcript = await invoke<string>('transcribe_audio_native', {
        engine: 'whisper',
        model,
        audioBase64: base64Audio,
        mimeType: blob.type || 'audio/webm',
        apiKey: key,
        fallbackModel: null,
      });
      return transcript;
    } catch (err: any) {
      console.error('Native Whisper STT error:', err);
      throw err;
    }
  };

  const resolveAutoModel = (query: string, currentProv: string, _targetAgent: 'agent1' | 'agent2'): string => {
    const q = query.toLowerCase();
    const isComplex =
      q.length > 80 ||
      q.includes('code') ||
      q.includes('debug') ||
      q.includes('why') ||
      q.includes('how to') ||
      q.includes('architecture') ||
      q.includes('create a') ||
      q.includes('write a') ||
      q.includes('analyze') ||
      q.includes('script') ||
      thinkingLevel === 'high';

    if (thinkingLevel === 'off') {
      if (currentProv === 'openai' || currentProv === 'codex') return 'gpt-4o-mini';
      return 'gemini-3.8-flash';
    }

    if (isComplex) {
      if (currentProv === 'openai' || currentProv === 'codex') return 'gpt-5.5-codex';
      if (currentProv === 'anthropic') return 'claude-sonnet-4-5-20250929';
      return 'gemini-3.1-pro-preview';
    } else {
      if (currentProv === 'openai' || currentProv === 'codex') return 'gpt-4o-mini';
      if (currentProv === 'anthropic') return 'claude-haiku-4-5-20251001';
      return 'gemini-3.8-flash';
    }
  };

  // OAuth State & Actions
  interface OAuthStatusState {
    connected: boolean;
    provider: string;
    email?: string;
    project_id?: string;
    expires_at?: number;
  }
  const [antigravityOAuth, setAntigravityOAuth] = useState<OAuthStatusState>({
    connected: false,
    provider: 'antigravity',
  });
  const [codexOAuth, setCodexOAuth] = useState<OAuthStatusState>({
    connected: false,
    provider: 'codex',
  });
  const [oauthLoading, setOauthLoading] = useState<Record<string, boolean>>({});

  const checkOAuthStatus = async (prov: string) => {
    try {
      const status = await invoke<OAuthStatusState>('get_oauth_status', { provider: prov });
      if (prov === 'antigravity') setAntigravityOAuth(status);
      if (prov === 'codex') setCodexOAuth(status);
    } catch (e) {
      console.warn(`Failed to check OAuth status for ${prov}:`, e);
    }
  };

  const handleOAuthLogin = async (prov: 'antigravity' | 'codex') => {
    setOauthLoading((prev) => ({ ...prev, [prov]: true }));
    try {
      if (prov === 'antigravity') {
        await invoke('start_antigravity_login');
      } else {
        await invoke('start_codex_login');
      }
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const s = await invoke<OAuthStatusState>('get_oauth_status', { provider: prov });
          if (s.connected || attempts > 25) {
            clearInterval(interval);
            if (prov === 'antigravity') setAntigravityOAuth(s);
            if (prov === 'codex') setCodexOAuth(s);
            setOauthLoading((prev) => ({ ...prev, [prov]: false }));
          }
        } catch {
          if (attempts > 25) {
            clearInterval(interval);
            setOauthLoading((prev) => ({ ...prev, [prov]: false }));
          }
        }
      }, 2000);
    } catch (err: any) {
      console.error(`OAuth login error for ${prov}:`, err);
      setOauthLoading((prev) => ({ ...prev, [prov]: false }));
    }
  };

  const handleOAuthSignOut = async (prov: 'antigravity' | 'codex') => {
    setOauthLoading((prev) => ({ ...prev, [prov]: true }));
    try {
      await invoke('sign_out_oauth', { provider: prov });
      if (prov === 'antigravity') {
        setAntigravityOAuth({ connected: false, provider: 'antigravity' });
      } else {
        setCodexOAuth({ connected: false, provider: 'codex' });
      }
    } catch (e) {
      console.error(`Failed to sign out ${prov}:`, e);
    } finally {
      setOauthLoading((prev) => ({ ...prev, [prov]: false }));
    }
  };

  const handleTestAudioPlayback = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.32);
    } catch (e) {
      console.error('Audio playback test error:', e);
    }
  };

  // Agent 2: Knowledge & RAG Model Configuration & Search
  const [agent2Provider, setAgent2Provider] = useState<string>(() => {
    return localStorage.getItem('blinky_agent2_provider') || 'gemini';
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    const saved = localStorage.getItem('blinky_gemini_model');
    return (saved && !saved.includes('2.0') && !saved.includes('2.5')) ? saved : 'gemini-3.8-flash';
  });
  const [agent2Model, setAgent2Model] = useState<string>(() => {
    const saved = localStorage.getItem('blinky_agent2_model');
    return saved || 'gemini-3.8-flash';
  });
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => {
    return localStorage.getItem('blinky_gemini_api_key') || '';
  });
  const [agent2SearchQuery, setAgent2SearchQuery] = useState<string>('');
  const [isAgent2SearchOpen, setIsAgent2SearchOpen] = useState<boolean>(false);
  const [agent2ModelsList, setAgent2ModelsList] = useState<DynamicModelItem[]>(CUE_GEMINI_CATALOG);
  const [agent2ModelsLoading, setAgent2ModelsLoading] = useState<boolean>(false);
  const agent2FetchSeqRef = useRef<number>(0);

  const [geminiSearchQuery, setGeminiSearchQuery] = useState<string>('');
  const [isGeminiSearchOpen, setIsGeminiSearchOpen] = useState<boolean>(false);
  const [showGeminiConfig, setShowGeminiConfig] = useState<boolean>(false);
  const [geminiModelsList, setGeminiModelsList] = useState<DynamicModelItem[]>(CUE_GEMINI_CATALOG);
  const [geminiModelsLoading, setGeminiModelsLoading] = useState<boolean>(false);
  const geminiFetchSeqRef = useRef<number>(0);
  const [settingsTab, setSettingsTab] = useState<'agent1' | 'agent2' | 'voice' | 'keys' | 'mobile' | 'about'>('agent1');

  const updateAgent2Provider = (prov: string) => {
    setAgent2Provider(prov);
    localStorage.setItem('blinky_agent2_provider', prov);
    const catalog = getCuratedCatalog(prov);
    if (catalog.length > 0) {
      setAgent2Model(catalog[0].id);
      localStorage.setItem('blinky_agent2_model', catalog[0].id);
      if (prov === 'gemini') {
        setGeminiModel(catalog[0].id);
        localStorage.setItem('blinky_gemini_model', catalog[0].id);
      }
    }
    void refreshAgent2Models(prov);
  };

  const updateAgent2Model = (newModel: string) => {
    const clean = newModel.trim();
    if (!clean) return;
    setAgent2Model(clean);
    localStorage.setItem('blinky_agent2_model', clean);
    if (agent2Provider === 'gemini') {
      setGeminiModel(clean);
      localStorage.setItem('blinky_gemini_model', clean);
    }
  };

  const refreshAgent2Models = async (prov = agent2Provider) => {
    const seq = ++agent2FetchSeqRef.current;
    setAgent2ModelsLoading(true);
    const key = getProviderKey(prov);
    try {
      const res = await fetchDynamicModels(prov, key, customUrl);
      if (seq === agent2FetchSeqRef.current && res.models && res.models.length > 0) {
        setAgent2ModelsList(res.models);
      }
    } catch (e) {
      console.warn('Failed to fetch Agent 2 models dynamically:', e);
    } finally {
      if (seq === agent2FetchSeqRef.current) {
        setAgent2ModelsLoading(false);
      }
    }
  };

  const updateGeminiModel = (newModel: string) => {
    const clean = newModel.trim();
    if (!clean) return;
    setGeminiModel(clean);
    localStorage.setItem('blinky_gemini_model', clean);
  };

  const updateGeminiApiKey = (newKey: string) => {
    const clean = newKey.trim();
    setGeminiApiKey(clean);
    localStorage.setItem('blinky_gemini_api_key', clean);
    if (clean.length > 10) {
      void refreshGeminiModels(clean);
    }
    void persistAllSettings({ geminiApiKey: clean });
  };

  const refreshGeminiModels = async (key = geminiApiKey) => {
    const seq = ++geminiFetchSeqRef.current;
    setGeminiModelsLoading(true);
    try {
      const res = await fetchDynamicModels('gemini', key);
      if (seq === geminiFetchSeqRef.current && res.models && res.models.length > 0) {
        setGeminiModelsList(res.models);
      }
    } catch (e) {
      console.warn('Failed to fetch Gemini models dynamically:', e);
    } finally {
      if (seq === geminiFetchSeqRef.current) {
        setGeminiModelsLoading(false);
      }
    }
  };

  const handleTestPing = async (
    prov: string,
    key: string,
    model?: string,
    url?: string,
    projId?: string,
    saJson?: string
  ) => {
    setPingTesting(true);
    setPingResult(null);
    try {
      const res = await pingModel(
        prov,
        key,
        model,
        url,
        projId || (prov === 'vertex' ? vertexProjectId : undefined),
        saJson || (prov === 'vertex' ? vertexServiceAccountJson : undefined)
      );
      setPingResult(res);
    } catch (e: any) {
      setPingResult({
        ok: false,
        provider: prov,
        model: model || 'unknown',
        latency_ms: 0,
        status_code: 0,
        error: e?.message || 'Ping failed',
      });
    } finally {
      setPingTesting(false);
    }
  };
  const sarvamApiKeyRef = useRef('');

  useEffect(() => {
    sarvamApiKeyRef.current = sarvamApiKey;
  }, [sarvamApiKey]);

  useEffect(() => {
    assemblyaiApiKeyRef.current = assemblyaiApiKey;
  }, [assemblyaiApiKey]);

  useEffect(() => {
    voiceProviderRef.current = voiceProvider;
  }, [voiceProvider]);

  useEffect(() => {
    async function loadInitialSettings() {
      try {
        const s = await getSettings();
        if (s.provider) setProvider(s.provider);
        if (s.shortcut) setShortcut(s.shortcut);
        if (s.voice_provider === 'sarvam' || s.voice_provider === 'assemblyai') {
          setVoiceProvider(s.voice_provider);
          voiceProviderRef.current = s.voice_provider;
        } else {
          const cached = localStorage.getItem('blinky_voice_provider') as 'assemblyai' | 'sarvam' | null;
          if (cached === 'sarvam' || cached === 'assemblyai') {
            setVoiceProvider(cached);
            voiceProviderRef.current = cached;
          }
        }
        if (s.sarvam_api_key) {
          setSarvamApiKey(s.sarvam_api_key);
          sarvamApiKeyRef.current = s.sarvam_api_key;
        }
        if (s.assemblyai_api_key) {
          setAssemblyaiApiKey(s.assemblyai_api_key);
          assemblyaiApiKeyRef.current = s.assemblyai_api_key;
        } else if (defaultAaiKey) {
          setAssemblyaiApiKey(defaultAaiKey);
          assemblyaiApiKeyRef.current = defaultAaiKey;
        }
        if (s.groq_api_key) setGroqApiKey(s.groq_api_key);
        if (s.deepseek_api_key) setDeepseekApiKey(s.deepseek_api_key);
        if (s.custom_url) setCustomUrl(s.custom_url);
        if (s.custom_model) {
          setCustomModel(s.custom_model);
          if (s.provider === 'custom') setAgent1Model(s.custom_model);
        }
        if (s.custom_api_key) setCustomApiKey(s.custom_api_key);

        const prov = s.provider || 'gemini';
        if (s.gemini_api_key) {
          setGeminiApiKey(s.gemini_api_key);
          localStorage.setItem('blinky_gemini_api_key', s.gemini_api_key);
        }
        if (s.openai_api_key) {
          setOpenaiApiKey(s.openai_api_key);
          localStorage.setItem('clinky_openai_api_key', s.openai_api_key);
        }
        if (s.anthropic_api_key) {
          setAnthropicApiKey(s.anthropic_api_key);
          localStorage.setItem('clinky_anthropic_api_key', s.anthropic_api_key);
        }
        if (s.vertex_project_id) {
          setVertexProjectId(s.vertex_project_id);
          localStorage.setItem('clinky_vertex_project_id', s.vertex_project_id);
        }
        if (s.assemblyai_api_key) {
          setAssemblyaiApiKey(s.assemblyai_api_key);
          assemblyaiApiKeyRef.current = s.assemblyai_api_key;
        }
        if (s.voice_provider === 'sarvam' || s.voice_provider === 'assemblyai') {
          setVoiceProvider(s.voice_provider);
          voiceProviderRef.current = s.voice_provider;
          localStorage.setItem('blinky_voice_provider', s.voice_provider);
        }
        if (s.model_name) {
          setAgent1Model(s.model_name);
          localStorage.setItem('blinky_agent1_model', s.model_name);
        }
        void refreshAgent1Models(prov);
        void refreshGeminiModels(s.gemini_api_key || geminiApiKey);
      } catch (err) {
        console.error('Failed to load initial settings in CommandBar:', err);
      }
    }
    void loadInitialSettings();
  }, []);

  useEffect(() => {
    void getSecureTransportInfo()
      .then(setTransportInfo)
      .catch(() => setTransportInfo(null));
  }, []);

  // Workflow-save prompt (emitted by the agent loop after a successful task)

  const [recipePrompt, setRecipePrompt] = useState<{ recipe_id: string; preview: string[]; intent: string } | null>(null);
  const [recipeBusy, setRecipeBusy] = useState(false);

  // WhatsApp connection states
  const [waBackendUrl, setWaBackendUrl] = useState('http://localhost:3000');
  const [waStatus, setWaStatus] = useState<'loading' | 'disconnected' | 'qr' | 'connected' | 'error'>('loading');
  const [waQr, setWaQr] = useState('');
  const [waError, setWaError] = useState('');
  const [isWaActionLoading, setIsWaActionLoading] = useState(false);
  const [showWaModal, setShowWaModal] = useState(false);
  const waCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Mobile pairing (QR) states
  const [showMobileModal, setShowMobileModal] = useState(false);
  const [pairingPayload, setPairingPayload] = useState<MobilePairingPayload | null>(null);
  const [pairingIp, setPairingIp] = useState('');
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState('');
  const mobileCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const SESSION_ID = 'blinky-default-session';
  const PORTS_TO_SCAN = [3000, 3001, 3002, 3003, 3004, 3005];

  const findWaBackendUrl = async (): Promise<string> => {
    for (const port of PORTS_TO_SCAN) {
      const url = `http://localhost:${port}`;
      try {
        const res = await fetch(`${url}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: SESSION_ID })
        });
        if (res.ok || res.status === 400) {
          return url;
        }
      } catch (e) {
        // ignore
      }
    }
    return 'http://localhost:3000';
  };

  const connectWhatsApp = async (backendUrl = waBackendUrl) => {
    setIsWaActionLoading(true);
    setWaError('');
    try {
      const res = await fetch(`${backendUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID })
      });
      if (res.ok) {
        const statusRes = await fetch(`${backendUrl}/api/status`, {
          headers: { 'X-Session-Id': SESSION_ID }
        });
        if (statusRes.ok) {
          const data = await statusRes.json();
          setWaStatus(data.status);
          setWaQr(data.qr || '');
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setWaError(data.error || 'Failed to initialize session');
        setWaStatus('error');
      }
    } catch (err) {
      setWaError('Server communication error');
      setWaStatus('error');
    } finally {
      setIsWaActionLoading(false);
    }
  };

  const logoutWhatsApp = async () => {
    setIsWaActionLoading(true);
    setWaError('');
    try {
      const res = await fetch(`${waBackendUrl}/api/logout`, {
        method: 'POST',
        headers: {
          'X-Session-Id': SESSION_ID,
          'Content-Type': 'application/json'
        }
      });
      if (res.ok) {
        setWaStatus('loading');
        setWaQr('');
      } else {
        const data = await res.json().catch(() => ({}));
        setWaError(data.error || 'Failed to logout');
      }
    } catch (err) {
      setWaError('Server communication error');
    } finally {
      setIsWaActionLoading(false);
    }
  };

  // Discover WhatsApp backend port on mount
  useEffect(() => {
    let active = true;

    async function discover() {
      const url = await findWaBackendUrl();
      if (!active) return;
      setWaBackendUrl(url);
      void connectWhatsApp(url);
    }

    void discover();
    return () => {
      active = false;
    };
  }, []);

  // Mobile pairing: load payload (LAN IPs + token) for the Connect-Mobile QR.
  const loadPairingPayload = async () => {
    setPairingLoading(true);
    setPairingError('');
    try {
      const payload = await getMobilePairingPayload();
      setPairingPayload(payload);
      setPairingIp((current) => (
        current && payload.ips.includes(current) ? current : (payload.ips[0] ?? '')
      ));
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Could not load pairing info. Is the desktop backend running?');
    } finally {
      setPairingLoading(false);
    }
  };

  const openMobileModal = () => {
    setShowMobileModal(true);
    void loadPairingPayload();
  };

  const handleRegenerateToken = async () => {
    setPairingLoading(true);
    setPairingError('');
    try {
      await regenerateRemoteToken();
      await loadPairingPayload();
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Could not regenerate token.');
    } finally {
      setPairingLoading(false);
    }
  };

  // Compact JSON the mobile app scans: full credentials for one-scan connect.
  const pairingQrText = pairingPayload && pairingIp
    ? JSON.stringify({
      v: 1,
      ip: pairingIp,
      ws: pairingPayload.ws_port,
      disc: pairingPayload.discovery_port,
      token: pairingPayload.token,
      pin: pairingPayload.certificate_pin,
      mode: pairingPayload.mode,
    })
    : '';

  // Keep WhatsApp status fresh so startup state and logout state update without user interaction.
  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${waBackendUrl}/api/status`, {
          headers: { 'X-Session-Id': SESSION_ID }
        });
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setWaStatus(data.status);
          setWaQr(data.qr || '');
          setWaError('');
        } else {
          if (res.status === 404) {
            setWaStatus('disconnected');
          } else {
            const data = await res.json().catch(() => ({}));
            setWaError(data.error || `HTTP error ${res.status}`);
            setWaStatus('error');
          }
        }
      } catch (err) {
        if (!active) return;
        setWaStatus('disconnected');
      }
    };

    void fetchStatus();
    const interval = setInterval(fetchStatus, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [showSettings, showWaModal, waBackendUrl]);

  // Draw QR code to canvas
  useEffect(() => {
    if (waStatus === 'qr' && waQr && waCanvasRef.current) {
      QRCode.toCanvas(
        waCanvasRef.current,
        waQr,
        {
          width: 180,
          margin: 2,
          color: {
            dark: '#140f13',
            light: '#ffffff'
          }
        },
        (error) => {
          if (error) console.error('Failed to render QR Code:', error);
        }
      );
    }
  }, [waStatus, waQr]);

  // Draw mobile-pairing QR code to canvas
  useEffect(() => {
    if ((showMobileModal || (showSettings && settingsTab === 'mobile')) && pairingQrText && mobileCanvasRef.current) {
      QRCode.toCanvas(
        mobileCanvasRef.current,
        pairingQrText,
        {
          width: 180,
          margin: 2,
          color: {
            dark: '#140f13',
            light: '#ffffff'
          }
        },
        (error) => {
          if (error) console.error('Failed to render pairing QR Code:', error);
        }
      );
    }
  }, [showMobileModal, showSettings, settingsTab, pairingQrText]);

  useEffect(() => {
    if (showSettings && settingsTab === 'mobile' && !pairingPayload && !pairingLoading) {
      void loadPairingPayload();
    }
  }, [showSettings, settingsTab, pairingPayload, pairingLoading]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastQueryRef = useRef<string>('');
  const completedTargetsRef = useRef<string[]>([]);
  const completedInstructionsRef = useRef<string[]>([]);
  const failedTargetsRef = useRef<string[]>([]);
  const failedRefsRef = useRef<string[]>([]);
  const currentGuideStepsRef = useRef<any[]>([]);
  const lastTutorResultRef = useRef<any>(null);
  const workflowStartedWithReadbackRef = useRef(false);
  const conversationHistoryRef = useRef<TutorConversationMessage[]>([]);
  const runIdRef = useRef(0);
  const cancelledRunIdsRef = useRef<Set<number>>(new Set());
  const activeWorkerRunIdRef = useRef<string | null>(null);
  const latestTranscriptRef = useRef<string>('');
  const isStartingRecordingRef = useRef(false);

  // WebTransport and WebSocket streaming refs
  const sttStreamRef = useRef<SarvamSpeechToTextStream | null>(null);
  const ttsStreamRef = useRef<SarvamTextToSpeechStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const transportManagerRef = useRef<AdaptiveTransportManager | null>(null);
  const transportStateRef = useRef<'WEBTRANSPORT' | 'WEBSOCKET'>('WEBTRANSPORT');
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);

  // TTS Streaming state
  const speechBufferRef = useRef<string>('');
  const ttsTextQueueRef = useRef<{ text: string, isHidden?: boolean, startWordIdx?: number, wordsCount?: number }[]>([]);
  const ttsAudioQueueRef = useRef<string[]>([]);
  const isFetchingTtsRef = useRef<boolean>(false);
  const isPlayingTtsRef = useRef<boolean>(false);
  const hasStreamedTtsRef = useRef<boolean>(false);

  const [activeWordIndex, setActiveWordIndex] = useState<number>(-1);
  const wordTimersRef = useRef<number[]>([]);
  const spokenWordsAccumulatorRef = useRef<number>(0);

  const pushToTtsQueue = (text: string, isHidden?: boolean) => {
    const cleanSentence = text.trim();
    if (!cleanSentence) return;

    const wordsCount = cleanSentence.split(/\s+/).filter(Boolean).length;
    const startWordIdx = spokenWordsAccumulatorRef.current;
    spokenWordsAccumulatorRef.current += wordsCount;

    ttsTextQueueRef.current.push({
      text: cleanSentence,
      isHidden,
      startWordIdx,
      wordsCount
    });
  };

  const rememberCompletedStep = (targetText?: string, instruction?: string, plannedTarget?: string) => {
    const cleanTarget = targetText?.trim();
    const cleanInstruction = instruction?.trim();
    const cleanPlanned = plannedTarget?.trim();

    if (cleanTarget && !completedTargetsRef.current.includes(cleanTarget)) {
      completedTargetsRef.current = [...completedTargetsRef.current, cleanTarget];
    }
    if (cleanPlanned && !completedTargetsRef.current.includes(cleanPlanned)) {
      completedTargetsRef.current = [...completedTargetsRef.current, cleanPlanned];
    }

    if (cleanInstruction && !completedInstructionsRef.current.includes(cleanInstruction)) {
      completedInstructionsRef.current = [...completedInstructionsRef.current, cleanInstruction];
    }
  };

  const rememberFailedStep = (targetText?: string, ref?: string) => {
    const cleanTarget = targetText?.trim();
    const cleanRef = ref?.trim();

    if (cleanTarget && !failedTargetsRef.current.includes(cleanTarget)) {
      failedTargetsRef.current = [...failedTargetsRef.current, cleanTarget];
    }

    if (cleanRef && !failedRefsRef.current.includes(cleanRef)) {
      failedRefsRef.current = [...failedRefsRef.current, cleanRef];
    }
  };

  const stopSpeaking = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (assemblyaiAudioSourceRef.current) {
      try {
        assemblyaiAudioSourceRef.current.stop();
      } catch { }
      assemblyaiAudioSourceRef.current = null;
    }
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch { }
    });
    activeSourcesRef.current = [];
    if (ttsStreamRef.current) {
      ttsStreamRef.current.disconnect();
      ttsStreamRef.current = null;
    }

    // Clear word highlight timers
    wordTimersRef.current.forEach((timerId) => clearTimeout(timerId));
    wordTimersRef.current = [];
    setActiveWordIndex(-1);
    spokenWordsAccumulatorRef.current = 0;

    ttsTextQueueRef.current = [];
    ttsAudioQueueRef.current = [];
    isFetchingTtsRef.current = false;
    isPlayingTtsRef.current = false;
    speechBufferRef.current = '';
    nextPlayTimeRef.current = 0;

    setIsSpeaking(false);
    setIsTtsActive(false);
  };

  // Initialize Adaptive Transport Manager when API key is loaded
  useEffect(() => {
    if (sarvamApiKey) {
      const wtUrl = import.meta.env.VITE_SARVAM_GATEWAY_WT_URL || 'wt://gateway.blinky.internal/sarvam-stream';
      const wsUrl = `wss://api.sarvam.ai/speech-to-text-stream?api-subscription-key=${encodeURIComponent(sarvamApiKey)}`;

      transportManagerRef.current = new AdaptiveTransportManager(
        wtUrl,
        wsUrl,
        sarvamApiKey,
        (state) => {
          transportStateRef.current = state;
          console.log(`Adaptive network engine transitioned to: ${state}`);
        }
      );
      void transportManagerRef.current.reEvaluateConnection();
    }
  }, [sarvamApiKey]);

  // Cleanup audio and streams on unmount
  useEffect(() => {
    return () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
      }
      activeSourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch { }
      });
      if (ttsStreamRef.current) {
        ttsStreamRef.current.disconnect();
      }
      if (sttStreamRef.current) {
        sttStreamRef.current.disconnect();
      }
    };
  }, []);

  // Use a ref to avoid stale closure for the fetch queue function
  const processTtsFetchQueueRef = useRef<() => void>(() => { });

  // Listen for real-time status and streaming chunks from python worker
  useEffect(() => {
    let unlistenStatus: Promise<any>;
    let unlistenChunk: Promise<any>;

    unlistenStatus = listen<{ phase: string; message: string }>('blinky://tutor-status', (event) => {
      setStatus(event.payload.message);
    });

    // Workflow-save prompt from the agent loop
    const unlistenRecipe = listen<{ recipe_id: string; preview: string[]; intent: string }>(
      'blinky://recipe-prompt',
      (event) => {
        setRecipePrompt(event.payload);
      }
    );

    unlistenChunk = listen<{ message: string }>('blinky://tutor-chunk', (event) => {
      const msg = event.payload.message;
      setStatus((prev) => {
        if (
          prev === 'Thinking...' ||
          prev === 'Reading the screen...' ||
          prev === 'Synthesizing streamed answer...' ||
          prev === 'Answering directly from your pre-trained knowledge base...' ||
          prev.startsWith('Searching SearXNG') ||
          prev.startsWith('Fetching content') ||
          prev.startsWith('Cleaning and filtering')
        ) {
          return msg;
        }
        return prev + msg;
      });
    });

    return () => {
      void unlistenStatus.then((dispose) => dispose());
      void unlistenChunk.then((dispose) => dispose());
      void unlistenRecipe.then((dispose) => dispose());
    };
  }, []);

  // Callbacks refs to avoid stale closures in WebSockets
  const onTranscriptRef = useRef<(transcript: string, isFinal: boolean) => void>(() => { });
  const onAudioChunkRef = useRef<(base64Audio: string) => void>(() => { });

  // Update refs on every render
  onTranscriptRef.current = (transcript, isFinal) => {
    const cleanText = (transcript || '').trim();
    if (cleanText) {
      setQuestion(cleanText);
      latestTranscriptRef.current = cleanText;
      if (isFinal) {
        setStatus(`Searching for: "${cleanText}"`);
        stopRecording();
        void executeTutor(cleanText, true);
      }
    }
  };

  onAudioChunkRef.current = async (base64Audio) => {
    if (!audioCtxRef.current) return;
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    try {
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await audioCtxRef.current.decodeAudioData(bytes.buffer.slice(0));
      } catch (decodeErr) {
        const isMp3 = bytes.length >= 3 && (
          (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
          (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)
        );
        if (isMp3) {
          throw new Error('Failed to decode MP3 data: ' + (decodeErr instanceof Error ? decodeErr.message : String(decodeErr)));
        }
        const validByteLength = bytes.buffer.byteLength - (bytes.buffer.byteLength % 2);
        const int16Array = new Int16Array(bytes.buffer, 0, validByteLength / 2);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
          float32Array[i] = int16Array[i] / 32768.0;
        }
        audioBuffer = audioCtxRef.current.createBuffer(1, float32Array.length, 16000);
        audioBuffer.getChannelData(0).set(float32Array);
      }

      const source = audioCtxRef.current.createBufferSource();
      source.buffer = audioBuffer;
      if (!ttsAnalyserRef.current) {
        ttsAnalyserRef.current = audioCtxRef.current.createAnalyser();
        ttsAnalyserRef.current.connect(audioCtxRef.current.destination);
      }
      source.connect(ttsAnalyserRef.current);

      const startTime = Math.max(audioCtxRef.current.currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
      activeSourcesRef.current.push(source);

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
        if (activeSourcesRef.current.length === 0) {
          setIsSpeaking(false);
        }
      };
    } catch (e) {
      console.error('Failed to decode incoming voice buffer:', e);
    }
  };

  const processTtsFetchQueue = async () => {
  };

  // Update ref so useEffect closure always uses the latest state
  processTtsFetchQueueRef.current = processTtsFetchQueue;

  const processTtsPlayQueue = async () => {
  };

  const speakText = async (summaryText: string, stepsList: any[], options: { includeSteps?: boolean } = {}) => {
  };

  const speakResponse = () => {
  };

  useEffect(() => {
    let rafId: number;
    const loop = () => {
      if (isSpeaking && ttsAnalyserRef.current && glowContainerRef.current) {
        const dataArray = new Uint8Array(ttsAnalyserRef.current.frequencyBinCount);
        ttsAnalyserRef.current.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const normalizedVolume = Math.min(1, rms * 8); // Multiplier tunes glow sensitivity to TTS

        void emit('blinky://vad-update', { volume: normalizedVolume });

        rafId = requestAnimationFrame(loop);
      } else if (!isSpeaking && !isRecording) {
        void emit('blinky://vad-update', { volume: 0 });
      }
    };

    if (isSpeaking) {
      rafId = requestAnimationFrame(loop);
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isSpeaking, isRecording]);

function looksLikeHallucination(raw: string): boolean {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

  const handleAudioTranscription = async (blob: Blob) => {
    if (!blob || blob.size < 4000) {
      setStatus('Could not hear anything clearly. Please speak louder and try again.');
      void resumeWakeWord();
      return;
    }

    const hasGemini = Boolean(geminiApiKey && geminiApiKey.trim());
    const hasOpenAI = Boolean(openaiApiKey && openaiApiKey.trim());
    const hasAssemblyAI = Boolean((assemblyaiApiKey && assemblyaiApiKey.trim()) || (assemblyaiApiKeyRef.current && assemblyaiApiKeyRef.current.trim()));
    const hasSarvam = Boolean((sarvamApiKey && sarvamApiKey.trim()) || (sarvamApiKeyRef.current && sarvamApiKeyRef.current.trim()));
    const hasGroq = Boolean((groqApiKey && groqApiKey.trim()) || (import.meta as any).env?.VITE_GROQ_API_KEY);

    // Determine target STT engine based on user selection or auto-detect based on available keys
    let targetEngine = primarySttModel;
    if (targetEngine.startsWith('gemini') && !hasGemini) {
      if (hasOpenAI) targetEngine = 'whisper-1';
      else if (hasAssemblyAI) targetEngine = 'assemblyai';
      else if (hasSarvam) targetEngine = 'sarvam';
      else if (hasGroq) targetEngine = 'groq-whisper';
    } else if (targetEngine.includes('whisper') && !hasOpenAI && !hasGroq) {
      if (hasGemini) targetEngine = 'gemini-3.5-transcribe';
      else if (hasAssemblyAI) targetEngine = 'assemblyai';
      else if (hasSarvam) targetEngine = 'sarvam';
    }

    let transcribedText = '';

    // Route 1: Gemini STT
    if (targetEngine.startsWith('gemini') && hasGemini) {
      setStatus(`Transcribing with ${targetEngine}...`);
      try {
        transcribedText = await transcribeWithGemini(blob, targetEngine);
      } catch (err: any) {
        console.error('Gemini STT error:', err);
        if (hasOpenAI) {
          setStatus('Gemini STT unavailable. Falling back to Whisper...');
          try {
            transcribedText = await transcribeWithWhisper(blob, openaiApiKey);
          } catch (oErr) {
            console.error('Whisper fallback error:', oErr);
          }
        }
      }
    }

    // Route 2: OpenAI Whisper
    if (!transcribedText && (targetEngine === 'whisper-1' || targetEngine === 'whisper') && hasOpenAI) {
      setStatus('Transcribing with OpenAI Whisper...');
      try {
        transcribedText = await transcribeWithWhisper(blob, openaiApiKey, 'whisper-1');
      } catch (err: any) {
        console.error('OpenAI Whisper STT error:', err);
      }
    }

    // Route 3: Groq Whisper
    if (!transcribedText && (targetEngine === 'groq-whisper' || hasGroq) && hasGroq) {
      const gKey = groqApiKey || (import.meta as any).env?.VITE_GROQ_API_KEY;
      if (gKey) {
        setStatus('Transcribing with Groq Whisper...');
        try {
          const groqFormData = new FormData();
          groqFormData.append('file', blob, 'query.webm');
          groqFormData.append('model', 'whisper-large-v3');
          groqFormData.append('response_format', 'json');

          const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${gKey}` },
            body: groqFormData,
          });

          if (groqRes.ok) {
            const gData = await groqRes.json();
            transcribedText = gData.text?.trim() || '';
          }
        } catch (gErr: any) {
          console.error('Groq Whisper STT connection error:', gErr);
        }
      }
    }

    // Route 4: AssemblyAI
    if (!transcribedText && (targetEngine === 'assemblyai' || hasAssemblyAI)) {
      let aaiKey = assemblyaiApiKey || assemblyaiApiKeyRef.current || (import.meta as any).env?.VITE_ASSEMBLY_AI_API_KEY || '';
      if (!aaiKey) {
        try {
          const s = await getSettings();
          if (s.assemblyai_api_key) aaiKey = s.assemblyai_api_key;
        } catch {}
      }
      if (aaiKey) {
        setStatus('Transcribing with AssemblyAI Universal-3 Pro...');
        try {
          transcribedText = await transcribeAudioWithAssemblyAI(blob, aaiKey);
        } catch (err: any) {
          console.error('AssemblyAI transcription error:', err);
        }
      }
    }

    // Route 5: Sarvam AI
    if (!transcribedText && (targetEngine === 'sarvam' || hasSarvam)) {
      const key = sarvamApiKey || sarvamApiKeyRef.current;
      if (key) {
        try {
          const formData = new FormData();
          formData.append('file', blob, 'query.webm');
          formData.append('model', 'saaras:v3');
          formData.append('language_code', 'en-IN');

          const res = await fetch('https://api.sarvam.ai/speech-to-text', {
            method: 'POST',
            headers: { 'api-subscription-key': key },
            body: formData,
          });

          if (res.ok) {
            const data = await res.json();
            transcribedText = data.transcript?.trim() || '';
          }
        } catch (err: any) {
          console.warn('Sarvam STT connection error:', err);
        }
      }
    }

    setIsTranscribing(false);
    if (transcribedText && !looksLikeHallucination(transcribedText)) {
      setQuestion(transcribedText);
      setStatus('');
      void executeTutor(transcribedText, true);
    } else {
      if (!hasGemini && !hasOpenAI && !hasAssemblyAI && !hasSarvam && !hasGroq) {
        setStatus('Please configure your Gemini, OpenAI, AssemblyAI, or Sarvam API Key in Settings to enable voice transcription.');
      } else {
        setStatus('Could not hear anything clearly. Please check your mic and try again.');
      }
      void resumeWakeWord();
    }
  };

  const startRecording = async () => {
    if (isStartingRecordingRef.current) return;
    isStartingRecordingRef.current = true;

    const currentVP = voiceProviderRef.current;
    let aaiKey = assemblyaiApiKey || assemblyaiApiKeyRef.current;
    let key = sarvamApiKey || sarvamApiKeyRef.current;
    let gKey = groqApiKey || (import.meta as any).env?.VITE_GROQ_API_KEY || '';

    // Ensure we check ANY configured key: Gemini, OpenAI, Vertex, Antigravity OAuth, Codex OAuth, AssemblyAI, Sarvam, Groq, Ollama
    let anyKeyPresent =
      Boolean(geminiApiKey && geminiApiKey.trim()) ||
      Boolean(openaiApiKey && openaiApiKey.trim()) ||
      Boolean(vertexProjectId && vertexProjectId.trim()) ||
      antigravityOAuth.connected ||
      codexOAuth.connected ||
      provider === 'ollama' ||
      Boolean(aaiKey && aaiKey.trim()) ||
      Boolean(key && key.trim()) ||
      Boolean(gKey && gKey.trim()) ||
      Boolean((import.meta as any).env?.VITE_GEMINI_API_KEY) ||
      Boolean((import.meta as any).env?.VITE_ASSEMBLY_AI_API_KEY);

    if (!anyKeyPresent) {
      try {
        const s = await getSettings();
        if (s.gemini_api_key) {
          setGeminiApiKey(s.gemini_api_key);
          anyKeyPresent = true;
        }
        if (s.openai_api_key) {
          setOpenaiApiKey(s.openai_api_key);
          anyKeyPresent = true;
        }
        if (s.vertex_project_id) {
          setVertexProjectId(s.vertex_project_id);
          anyKeyPresent = true;
        }
        if (s.provider === 'ollama') {
          anyKeyPresent = true;
        }
        if (s.assemblyai_api_key) {
          setAssemblyaiApiKey(s.assemblyai_api_key);
          assemblyaiApiKeyRef.current = s.assemblyai_api_key;
          aaiKey = s.assemblyai_api_key;
          anyKeyPresent = true;
        }
        if (s.sarvam_api_key) {
          setSarvamApiKey(s.sarvam_api_key);
          sarvamApiKeyRef.current = s.sarvam_api_key;
          key = s.sarvam_api_key;
          anyKeyPresent = true;
        }
        if (s.groq_api_key) {
          setGroqApiKey(s.groq_api_key);
          gKey = s.groq_api_key;
          anyKeyPresent = true;
        }
      } catch { }
    }

    if (!anyKeyPresent) {
      setStatus('Please configure your Gemini, OpenAI, AssemblyAI, or Sarvam API Key in Settings to enable voice transcription.');
      isStartingRecordingRef.current = false;
      return;
    }

    await pauseWakeWord();
    await new Promise(resolve => setTimeout(resolve, 300));
    void showOverlay();

    // Ensure AudioContext is initialized before starting recording (e.g. on hotkey first start)
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      } else if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
    } catch (ctxErr) {
      console.warn('AudioContext initialization note:', ctxErr);
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      (mediaRecorderRef as any).current = mediaRecorder;

      const audioChunks: BlobPart[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      // Setup VAD using AudioContext
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      const audioCtx = audioCtxRef.current;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      // Always use the realtime voice agent (thinks while you speak).
      if (currentVP === 'assemblyai' && aaiKey) {
        const agent = new AssemblyAIVoiceAgent({
          apiKey: aaiKey,
          onAgentAudio: (base64Audio) => {
            if (assemblyaiAudioSourceRef.current) {
              try { assemblyaiAudioSourceRef.current.stop(); } catch { }
            }
            setIsSpeaking(true);
            if (audioCtxRef.current) {
              const src = playPCM16Audio(audioCtxRef.current, base64Audio, 24000, ttsAnalyserRef.current || undefined);
              assemblyaiAudioSourceRef.current = src;
              src.onended = () => {
                setIsSpeaking(false);
              };
            }
          },
          onAgentTranscript: (text) => {
            setStatus(text);
            setSpokenStatus(text);
          },
          onUserTranscript: (text, isFinal) => {
            setQuestion(text);
            if (isFinal) {
              setStatus(`Heard: "${text}"`);
            }
          },
          onToolCall: async (callId, name, args) => {
            console.log(`AssemblyAI Voice Agent invoked tool: ${name}`, args);
            if (name === 'control_desktop') {
              const action = args.action || '';
              setStatus(`Clinky executing: "${action}"`);
              try {
                await executeTutor(action, false);
                return { status: 'success', message: `Completed desktop action: ${action}` };
              } catch (e: any) {
                return { status: 'error', message: e?.message || String(e) };
              }
            } else if (name === 'cancel_desktop_action') {
              stopCurrentRun();
              return { status: 'success', message: 'Cancelled desktop action.' };
            }
            return { status: 'unknown_tool' };
          },
          onTurnChange: (turn) => {
            if (turn === 'user') {
              if (assemblyaiAudioSourceRef.current) {
                try { assemblyaiAudioSourceRef.current.stop(); } catch { }
                assemblyaiAudioSourceRef.current = null;
              }
              setIsSpeaking(false);
            }
          },
          onError: (err) => {
            console.error('AssemblyAI Voice Agent error:', err);
          }
        });
        agent.connect();
        assemblyaiAgentRef.current = agent;
      }

      let hasSpoken = false;
      let silenceStartTime = 0;
      let silenceTimeoutTriggered = false;
      const SILENCE_THRESHOLD = 0.015;
      const SPEECH_THRESHOLD = 0.035;
      const SILENCE_DURATION_MS = 800;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);

        // Stream PCM16 chunk to active AssemblyAI connection
        const pcmChunk = floatTo16BitPCM(inputData);
        if (assemblyaiAgentRef.current?.isConnected) {
          assemblyaiAgentRef.current.sendAudioChunk(pcmChunk);
        } else if (assemblyaiSttRef.current?.isConnected) {
          assemblyaiSttRef.current.sendAudioChunk(pcmChunk);
        }

        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);

        const normalizedVolume = Math.min(1, rms * 15);
        void emit('blinky://vad-update', { volume: normalizedVolume });

        if (rms > SPEECH_THRESHOLD) {
          if (!hasSpoken) {
            hasSpoken = true;
          }
          silenceStartTime = 0;
        } else if (hasSpoken && rms < SILENCE_THRESHOLD) {
          const now = Date.now();
          if (silenceStartTime === 0) {
            silenceStartTime = now;
          } else if (now - silenceStartTime > SILENCE_DURATION_MS) {
            if (!silenceTimeoutTriggered) {
              silenceTimeoutTriggered = true;
              console.log("VAD: Local silence timeout reached. Stopping recording and submitting query.");

              if ((mediaRecorderRef as any).current?.state === 'recording') {
                stopRecording();
              }
            }
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      mediaRecorder.onstop = () => {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
        try { processor.disconnect(); source.disconnect(); } catch { }
        // If real-time stream did not execute, run audio transcription.
        // Skip the REST fallback when VAD never heard speech — this is what
        // previously produced "language_detection cannot be performed on
        // files with no spoken audio."
        if (!assemblyaiAgentRef.current?.isConnected && !assemblyaiSttRef.current?.isConnected) {
          if (!hasSpoken || audioChunks.length === 0) {
            setStatus('No speech detected. Please speak clearly into the mic and try again.');
            void resumeWakeWord();
            return;
          }
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          setIsTranscribing(true);
          void handleAudioTranscription(audioBlob);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      const listeningStatus = primarySttModel.startsWith('gemini')
        ? `🎙️ Gemini STT Listening (${primarySttModel})... Click mic to stop.`
        : primarySttModel.includes('whisper')
        ? '🎙️ Whisper STT Listening... Click mic to stop.'
        : currentVP === 'assemblyai'
        ? assemblyaiVoiceMode === 'agent'
          ? '⚡ AssemblyAI Voice Agent Listening (Universal-3 Pro)...'
          : '🎙️ AssemblyAI Realtime STT Listening...'
        : '🎙️ Sarvam AI Listening... Click mic to stop.';
      setStatus(listeningStatus);

      // Auto-stop after 12 seconds as a fallback
      setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
          stopRecording();
        }
      }, 12000);

    } catch (err) {
      console.error('Error starting audio recording:', err);
      setStatus('Microphone access failed or was denied.');
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      void resumeWakeWord();
    } finally {
      isStartingRecordingRef.current = false;
    }
  };

  const stopRecording = () => {
    if (assemblyaiAgentRef.current) {
      assemblyaiAgentRef.current.disconnect();
      assemblyaiAgentRef.current = null;
    }
    if (assemblyaiSttRef.current) {
      assemblyaiSttRef.current.disconnect();
      assemblyaiSttRef.current = null;
    }
    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch { }
      mediaRecorderRef.current = null;
      setIsRecording(false);

      void emit('blinky://vad-update', { volume: 0 });
    }
  };

  const toggleRecording = () => {
    setIsTaskCompleted(false);
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    } else if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }

    if (isRecording) {
      stopRecording();
    } else {
      stopSpeaking();
      void startRecording();
    }
  };

  function currentProgress(): TutorProgress {
    return {
      completed_targets: completedTargetsRef.current,
      completed_instructions: completedInstructionsRef.current,
      failed_targets: failedTargetsRef.current,
      failed_refs: failedRefsRef.current,
    };
  }

  async function executeTutor(
    queryText: string,
    shouldSpeakAfter: boolean,
    options: TutorRunOptions = {},
  ) {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    let effectiveQuery = queryText.trim().replace(/^(hey\s+)?(blinky|clinky)[\s,.:;!?]*/i, '').trim();

    // Auto Mode intelligent model routing
    if (agent1Model === 'auto') {
      const resolvedModel = resolveAutoModel(effectiveQuery, provider, 'agent1');
      void persistAllSettings({ modelName: resolvedModel });
    }
    if (agent2Model === 'auto') {
      const resolvedAgent2 = resolveAutoModel(effectiveQuery, agent2Provider, 'agent2');
      if (agent2Provider === 'gemini') {
        setGeminiModel(resolvedAgent2);
      }
    }
    if (attachedFiles.length > 0) {
      const pathsStr = attachedFiles.map((f) => f.path).join(', ');
      const prefix = `[Referenced Files: ${pathsStr}]`;
      if (!effectiveQuery.includes('[Referenced Files:')) {
        effectiveQuery = effectiveQuery ? `${prefix} ${effectiveQuery}` : `${prefix} merge these videos`;
      }
      setAttachedFiles([]);
    }
    if (!effectiveQuery) return;

    // Friendly response for pending actions check
    const normalizedCheck = effectiveQuery.toLowerCase().replace(/[?.,!]/g, '').trim();
    if (
      normalizedCheck === 'are there any pending actions' ||
      normalizedCheck === 'confirm action' ||
      normalizedCheck === 'is there any pending action' ||
      normalizedCheck === 'any pending actions' ||
      normalizedCheck === 'pending actions'
    ) {
      const friendlyMsg = 'Nothing awaiting confirmation.';
      setStatus(friendlyMsg);
      setSpokenStatus(friendlyMsg);
      setIsRunning(false);
      isRunningRef.current = false;
      const newHistoryEntries: TutorConversationMessage[] = [
        { role: 'student', content: effectiveQuery },
        { role: 'blinky', content: friendlyMsg },
      ];
      conversationHistoryRef.current = [
        ...conversationHistoryRef.current,
        ...newHistoryEntries,
      ].slice(-10);
      void emit('blinky://clinky-response', {
        text: friendlyMsg,
        provider: 'Clinky Desktop',
      });
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const workerRunId = `${Date.now()}-${runId}`;
    activeWorkerRunIdRef.current = workerRunId;

    // Immediately enable streaming TTS if requested
    workflowStartedWithReadbackRef.current = shouldSpeakAfter;
    hasStreamedTtsRef.current = false;
    setIsTtsActive(shouldSpeakAfter);
    setSpokenStatus('Thinking...');

    if (options.resetProgress) {
      completedTargetsRef.current = [];
      completedInstructionsRef.current = [];
      failedTargetsRef.current = [];
      failedRefsRef.current = [];
      currentGuideStepsRef.current = [];
      setSteps([]);
      setShowGuideCompletionSummary(false);
      lastQueryRef.current = '';
      conversationHistoryRef.current = [];
    }

    const previousQuestion = lastQueryRef.current || undefined;
    const conversationHistory = conversationHistoryRef.current.slice(-8);

    setIsRunning(true);
    setIsTaskCompleted(false);
    setStatus('Thinking...');
    void emit('blinky://clinky-state', { state: 'thinking' });
    if (!options.preserveStepsDuringRun) {
      setSteps([]);
    }
    stopSpeaking();
    void pauseWakeWord();

    const currentWindow = getCurrentWindow();
    let isPointing = false;
    try {
      let result: TutorResult;
      if (agentModeEnabled) {
        // Run the agent first — it may handle everything via MCP tools
        const agentResult = await runTutor(effectiveQuery, previousQuestion, currentProgress(), conversationHistory, false, true, undefined, undefined, workerRunId);

        // If agent handled it via computer use, use its result directly.
        // Autopilot loop is only for standard locator/vision questions that didn't run via computer_use loop.
        if (agentResult.computer_use) {
          result = agentResult;
        } else {
          // Show overlay window so AI cursor is visible on screen
          await showOverlay();

          // Vision-guided autopilot loop (screen-based clicking)
          const isSingleAction = isSingleActionQuery(effectiveQuery);
          let firstObservation: TutorResult | null = null;
          const autopilot = await runAutopilotLoop({
            maxAttempts: isSingleAction ? 1 : 5,
            maxRetriesPerStep: 2,
            observeAfterAction: !isSingleAction,
            isCancelled: () => cancelledRunIdsRef.current.has(runId),
            onStepFailed: (failedStep, retryCount) => {
              setStatus(`Action had no effect. Rethinking next step (Attempt ${retryCount})...`);
              rememberFailedStep(failedStep.target_text, failedStep.target_ref || failedStep.match?.ref);
            },
            observe: async () => {
              if (cancelledRunIdsRef.current.has(runId)) {
                return createEmptyTutorResult();
              }
              if (!firstObservation) {
                firstObservation = agentResult;
                return firstObservation;
              }
              return runTutor(effectiveQuery, previousQuestion, currentProgress(), conversationHistory, false, true, undefined, undefined, workerRunId);
            },
            act: async (point, step) => {
              if (cancelledRunIdsRef.current.has(runId)) return;
              const plannedTarget = (step as any).planned_target;
              // Prefer the element rung. cua-driver resolves the labelled control
              // inside the window that owns the point and invokes it through UIA:
              // it stays in the background, keeps the real pointer still, and does
              // not depend on the target being the topmost window. The point-only
              // click is the fallback for surfaces with no element tree (canvas,
              // video, WebGL) and for a step that carries no target text.
              const label = String((step as any).target_text || plannedTarget || '').trim();
              const click = async () => {
                if (label) {
                  await clickElement(point.x, point.y, label);
                } else {
                  await clickScreenPoint(point.x, point.y);
                }
              };
              if (isScrollAction(step.instruction)) {
                const direction = getScrollDirection(step.instruction);
                setStatus(`Autopilot scrolling ${direction}...`);
                rememberCompletedStep(step.target_text, step.instruction, plannedTarget);
                await scrollAtPoint(point.x, point.y, direction, 3);
              } else {
                const textToType = (step as any).text_to_type || extractTextToType(step.instruction);
                if (textToType) {
                  setStatus(`Autopilot typing "${textToType}"...`);
                  rememberCompletedStep(step.target_text, step.instruction, plannedTarget);
                  await click();
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  if (cancelledRunIdsRef.current.has(runId)) return;
                  const pressEnter = (step as any).key?.toLowerCase() === 'enter' || shouldPressEnterAfterTyping(step.instruction);
                  await typeText(point.x, point.y, textToType, pressEnter);
                } else {
                  setStatus(`Autopilot clicking (${point.x}, ${point.y})...`);
                  rememberCompletedStep(step.target_text, step.instruction, plannedTarget);
                  await click();
                }
              }
            },
          });
          if ((autopilot.stopReason === 'complete' || autopilot.stopReason === 'single_action') && autopilot.attempts > 0) {
            const firstStep = agentResult.steps?.find((candidate) => candidate.instruction.trim());
            result = {
              ...autopilot.finalResult,
              summary: isSingleAction
                ? `Clicked ${firstStep?.target_text || 'the target'}.`
                : `Autopilot successfully completed the task!`,
              steps: [],
            };
          } else if (autopilot.stopReason === 'unsafe_step') {

            const nextStep = autopilot.finalResult.steps.find((candidate) => candidate.instruction.trim());
            const blockedLabel = nextStep?.target_text || nextStep?.instruction || 'the next action';
            result = {
              ...autopilot.finalResult,
              summary: `Autopilot paused because "${blockedLabel}" requires manual interaction for safety.`,
            };
          } else if (autopilot.stopReason === 'missing_target') {
            result = {
              ...autopilot.finalResult,
              summary: `Autopilot stopped because it could not locate the next target on the screen. Please guide me manually.`,
            };
          } else if (autopilot.stopReason === 'unchanged_after_action') {
            result = {
              ...autopilot.finalResult,
              summary: `Autopilot stopped because the screen did not change after the last action. Please try manually.`,
            };
          } else if (autopilot.stopReason === 'max_attempts') {
            result = {
              ...autopilot.finalResult,
              summary: `Autopilot reached the maximum number of attempts. Please complete the remaining steps manually.`,
            };
          } else {
            result = autopilot.finalResult;
          }
        }
      } else {
        result = await runTutor(effectiveQuery, previousQuestion, currentProgress(), conversationHistory, webSearchEnabled, undefined, undefined, undefined, workerRunId);

        await logDebugMessage(`[executeTutor] (Standard) Received result from backend. Steps count: ${result.steps?.length || 0}`);
        if (result.steps && result.steps.length > 0) {
          const step = result.steps[0];
          await logDebugMessage(`[executeTutor] (Standard) Step 1: instruction="${step.instruction}", target_ref="${step.target_ref}", target_text="${step.target_text}", hasMatch=${!!step.match}`);
        }

        // Auto-trigger autopilot click for locator fast path results with click instructions
        const clickStep = result.steps?.find((s) => s.instruction && s.match);
        if (clickStep) {
          const isClick = isClickInstruction(clickStep.instruction);
          await logDebugMessage(`[executeTutor] (Standard) Click step candidate: instruction="${clickStep.instruction}", isClickInstruction=${isClick}`);
        }

        if (clickStep && isClickInstruction(clickStep.instruction)) {
          await logDebugMessage(`[executeTutor] (Standard) Triggering autopilot click at physical match x=${clickStep.match?.x}, y=${clickStep.match?.y}`);
          const autopilot = await runAutopilotLoop({
            maxAttempts: 1,
            observeAfterAction: false,
            isCancelled: () => cancelledRunIdsRef.current.has(runId),
            observe: async () => result,
            act: async (point, step) => {
              if (cancelledRunIdsRef.current.has(runId)) return;
              await logDebugMessage(`[executeTutor] (Standard) Autopilot act: clicking point x=${point.x}, y=${point.y}`);
              setStatus(`Clicking (${point.x}, ${point.y})...`);
              const label = String(step.target_text || '').trim();
              if (label) {
                await clickElement(point.x, point.y, label);
              } else {
                await clickScreenPoint(point.x, point.y);
              }
            },
          });
          if (autopilot.stopReason === 'complete' || autopilot.attempts > 0) {
            await logDebugMessage(`[executeTutor] (Standard) Autopilot completed with stopReason=${autopilot.stopReason}`);
            result = {
              ...result,
              summary: `Clicked ${clickStep.target_text || 'the target'}.`,
              steps: [],
            };
          }
        }
      }
      if (cancelledRunIdsRef.current.has(runId)) {
        return;
      }
      const isContinuation = !!result.is_continuation;

      if (!isContinuation) {
        if (!agentModeEnabled) {
          completedTargetsRef.current = [];
          completedInstructionsRef.current = [];
        }
        currentGuideStepsRef.current = [];
        setSteps([]);
        setShowGuideCompletionSummary(false);
        lastQueryRef.current = effectiveQuery;
      }

      const displaySteps = getDisplaySteps(result.steps || []);
      const currentGuideSteps = getCurrentGuideSteps(displaySteps, currentProgress());
      currentGuideStepsRef.current = currentGuideSteps;
      lastTutorResultRef.current = result;
      const hasCompletedProgress =
        completedTargetsRef.current.length > 0 || completedInstructionsRef.current.length > 0;
      const highlightSteps = getHighlightSteps(currentGuideSteps);
      await emit('blinky://guidance', { ...result, steps: currentGuideSteps });
      void emit('blinky://clinky-response', {
        text: result.summary,
        provider: provider === 'gemini' ? (geminiModel.includes('2.0') ? 'Gemini 2.0 Flash' : 'Gemini') : provider.toUpperCase(),
      });
      void emit('blinky://clinky-state', { state: 'idle' });
      isPointing = false;
      if (highlightSteps.length > 0) {
        await showOverlay();
        const primaryHighlight = highlightSteps[0];
        if (primaryHighlight && primaryHighlight.match) {
          isPointing = true;
          const point = getPhysicalClickablePoint(primaryHighlight, result);
          void emit('blinky://agent-cursor-move', {
            x: point.x,
            y: point.y,
            instruction: primaryHighlight.instruction,
          });
        }
      } else {
        await hideOverlay();
      }

      // When opening a folder or app, don't steal foreground focus away from it
      const agentTool = result.agent_action?.tool;
      if (agentTool !== 'open_folder' && agentTool !== 'open_app') {
        await currentWindow.setFocus();
      }
      setStatus(result.summary);
      const newHistoryEntries: TutorConversationMessage[] = [
        { role: 'student', content: effectiveQuery },
        { role: 'blinky', content: result.summary },
      ];
      conversationHistoryRef.current = [
        ...conversationHistoryRef.current,
        ...newHistoryEntries,
      ].slice(-10);

      const currentActiveSession = getActivePcSession();
      if (currentActiveSession) {
        const isDefaultTitle =
          currentActiveSession.title === 'New Conversation' ||
          currentActiveSession.title === 'Initial Session' ||
          currentActiveSession.title === 'Current Session';
        const updatedTitle = isDefaultTitle ? generatePcSessionTitle(effectiveQuery) : currentActiveSession.title;
        const updatedSession: PcChatSession = {
          ...currentActiveSession,
          title: updatedTitle,
          messages: [
            ...currentActiveSession.messages,
            { role: 'user', text: effectiveQuery, timestamp: Date.now() },
            {
              role: 'assistant',
              text: result.summary || (result as any).solution || (result as any).explanation || 'Completed instruction.',
              timestamp: Date.now(),
              steps: (currentGuideSteps || []).map((s: any) =>
                typeof s === 'string' ? s : s.instruction || s.title || ''
              ),
            },
          ],
        };
        savePcChatSession(updatedSession);
        setActivePcSession(updatedSession);
        setPcSessions(listPcChatSessions());
      }
      setShowGuideCompletionSummary(
        (hasCompletedProgress && currentGuideSteps.length === 0 && Boolean(result.summary))
        || Boolean(result.computer_use)
      );
      setSteps((previousSteps) => mergeGuideHistory(previousSteps, currentGuideSteps, currentProgress()));
      setQuestion('');
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
      }
    } catch (error) {
      if (cancelledRunIdsRef.current.has(runId)) {
        return;
      }
      await currentWindow.setFocus();
      setStatus(error instanceof Error ? error.message : String(error));
      setSteps([]);
    } finally {
      cancelledRunIdsRef.current.delete(runId);
      if (runIdRef.current === runId) {
        if (activeWorkerRunIdRef.current === workerRunId) {
          activeWorkerRunIdRef.current = null;
        }
        isRunningRef.current = false;
        setIsRunning(false);
        setIsTaskCompleted(true);
        if (!isPointing) {
          void emit('blinky://agent-cursor-done', {});
        }
        if (!shouldSpeakAfter && !isRecording && !isSpeaking) {
          void resumeWakeWord();
        }
      }
    }
  }

  function stopCurrentRun() {
    const runId = runIdRef.current;
    if (!isRunningRef.current || runId === 0) return;
    cancelledRunIdsRef.current.add(runId);
    const workerRunId = activeWorkerRunIdRef.current;
    if (workerRunId) {
      void cancelTutor(workerRunId);
    }
    isRunningRef.current = false;
    setIsRunning(false);
    setIsTaskCompleted(false);
    setStatus('Stopped.');
    setSteps([]);
    void hideOverlay();
    void emit('blinky://agent-cursor-done', {});
    stopSpeaking();
    if (!isRecording) {
      void resumeWakeWord();
    }
  }

  // Load settings on mount
  useEffect(() => {
    getSettings()
      .then((settings) => {
        setProvider(settings.provider);
        setShortcut(settings.shortcut);
        if (settings.gemini_api_key) setGeminiApiKey(settings.gemini_api_key);
        if (settings.openai_api_key) setOpenaiApiKey(settings.openai_api_key);
        if (settings.anthropic_api_key) setAnthropicApiKey(settings.anthropic_api_key);
        if (settings.vertex_project_id) setVertexProjectId(settings.vertex_project_id);
        if (settings.assemblyai_api_key) setAssemblyaiApiKey(settings.assemblyai_api_key);
        setSarvamApiKey(settings.sarvam_api_key || '');
        setGroqApiKey(settings.groq_api_key || '');
        setDeepseekApiKey(settings.deepseek_api_key || '');
        setCustomUrl(settings.custom_url || '');
        setCustomModel(settings.custom_model || '');
        setCustomApiKey(settings.custom_api_key || '');
      })
      .catch((err) => console.error('Failed to load settings:', err));
  }, []);

  // Always focus the window on mouse enter to ensure one-click interaction
  useEffect(() => {
    const handleMouseEnter = () => {
      void getCurrentWindow().setFocus();
    };

    document.addEventListener('mouseenter', handleMouseEnter);
    return () => {
      document.removeEventListener('mouseenter', handleMouseEnter);
    };
  }, []);

  // Global shortcut to toggle voice recording via Ctrl+Alt / Ctrl+Space / Win+Space
  useEffect(() => {
    const handleVoiceShortcut = (event: KeyboardEvent) => {
      const isCtrlAlt = (event.ctrlKey && event.altKey) || (event.ctrlKey && event.altKey && event.code === 'Space');
      const isWinSpace = (event.key === ' ' || event.code === 'Space') && (event.metaKey || event.ctrlKey);
      if (isCtrlAlt || isWinSpace) {
        event.preventDefault();
        if (!isRunning && !isTranscribing) {
          toggleRecording();
        }
      }
    };
    window.addEventListener('keydown', handleVoiceShortcut);
    return () => {
      window.removeEventListener('keydown', handleVoiceShortcut);
    };
  }, [isRunning, isTranscribing, isRecording]);

  // Global Escape key handler to close settings, history, and modals
  useEffect(() => {
    const handleGlobalEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSettings) {
          setShowSettings(false);
          setIsAgent1SearchOpen(false);
          setIsGeminiSearchOpen(false);
        }
        if (showHistory) setShowHistory(false);
        if (showWaModal) setShowWaModal(false);
        if (showMobileModal) setShowMobileModal(false);
      }
    };
    window.addEventListener('keydown', handleGlobalEscape);
    return () => window.removeEventListener('keydown', handleGlobalEscape);
  }, [showSettings, showHistory, showWaModal, showMobileModal]);

  // Setup native Tauri and web drag-and-drop listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setIsDraggingOver(true);
        } else if (event.payload.type === 'leave') {
          setIsDraggingOver(false);
        } else if (event.payload.type === 'drop') {
          setIsDraggingOver(false);
          const droppedPaths = event.payload.paths || [];
          if (droppedPaths.length > 0) {
            addAttachedFiles(droppedPaths);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch((err) => {
        console.warn('onDragDropEvent failed:', err);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Agent mode toggle synchronizes AI cursor visibility and active overlay state
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('agent-mode-active', agentModeEnabled);
    }
    void emit('blinky://agent-mode-active', { active: agentModeEnabled });
    if (agentModeEnabled) {
      void showOverlay();
      void setAgentCursorVisibility(true);
      void emit('blinky://agent-cursor-visibility', { visible: true });
    } else {
      // Ensure native cursor restored and AI cursor hidden when exiting agent mode
      void emit('blinky://agent-cursor-visibility', { visible: false });
      void setAgentCursorVisibility(false);
    }
  }, [agentModeEnabled]);

  useEffect(() => {

    const handleUnload = () => {
      void setAgentCursorVisibility(false);
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      void setAgentCursorVisibility(false);
    };
  }, []);




  const isVoiceActive = isSpeaking || isRecording || isTtsActive || (isRunning && workflowStartedWithReadbackRef.current);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    void emit('blinky://voice-active', { active: isVoiceActive });
  }, [isVoiceActive]);

  useEffect(() => {
    const unlistenPtt = listen<boolean>('blinky://push-to-talk', (event) => {
      if (event.payload) {
        if (!isRecordingRef.current && !isStartingRecordingRef.current) {
          stopSpeaking();
          void startRecording();
        }
      } else {
        if (isRecordingRef.current) {
          stopRecording();
        }
      }
    });

    return () => {
      unlistenPtt.then((dispose) => dispose());
    };
  }, []);

  // Synchronize wake word detector state with the application state centrally.
  // Guarded by ref so we only send PAUSE/RESUME on real transitions —
  // without this every re-render spams "[WakeWord] Resumed via stdin".
  const lastWakePausedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const shouldPause = isRunning || isRecording || isSpeaking || isTtsActive;
    if (lastWakePausedRef.current === shouldPause) return;
    lastWakePausedRef.current = shouldPause;
    if (shouldPause) {
      void pauseWakeWord();
    } else {
      void resumeWakeWord();
    }
  }, [isRunning, isRecording, isSpeaking, isTtsActive]);


  const persistAllSettings = async (overrides: Record<string, string> = {}) => {
    const prov = overrides.provider ?? provider;
    const sc = overrides.shortcut ?? shortcut;
    const sarvam = overrides.sarvamApiKey ?? sarvamApiKey;
    const groq = overrides.groqApiKey ?? groqApiKey;
    const deepseek = overrides.deepseekApiKey ?? deepseekApiKey;
    const cUrl = overrides.customUrl ?? customUrl;
    const cModel = overrides.customModel ?? customModel;
    const cKey = overrides.customApiKey ?? customApiKey;
    const aai = overrides.assemblyaiApiKey ?? assemblyaiApiKey;
    const vProv = overrides.voiceProvider ?? voiceProvider;
    const gemini = overrides.geminiApiKey ?? geminiApiKey;
    const oai = overrides.openaiApiKey ?? openaiApiKey;
    const anth = overrides.anthropicApiKey ?? anthropicApiKey;
    const vtx = overrides.vertexProjectId ?? vertexProjectId;
    const mdl = overrides.modelName ?? agent1Model;

    try {
      await saveSettings(
        prov,
        sc,
        sarvam,
        groq,
        deepseek,
        cUrl,
        cModel,
        cKey,
        aai,
        vProv,
        gemini,
        oai,
        anth,
        vtx,
        mdl
      );
    } catch (err) {
      console.error('Failed to persist settings:', err);
    }
  };

  const updateVoiceProvider = async (newVoiceProvider: 'assemblyai' | 'sarvam') => {
    setVoiceProvider(newVoiceProvider);
    voiceProviderRef.current = newVoiceProvider;
    localStorage.setItem('blinky_voice_provider', newVoiceProvider);
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        newVoiceProvider
      );
    } catch (err) {
      console.error('Failed to save voice provider:', err);
    }
  };

  const updateAssemblyaiApiKey = async (newKey: string) => {
    setAssemblyaiApiKey(newKey);
    assemblyaiApiKeyRef.current = newKey;
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        customModel,
        customApiKey,
        newKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save AssemblyAI API key:', err);
    }
  };

  const updateProvider = async (newProvider: string) => {
    const cleanProvider = newProvider.toLowerCase().trim();
    setProvider(cleanProvider);
    localStorage.setItem('blinky_ai_provider', cleanProvider);
    // Fetch live models for the chosen provider immediately
    void refreshAgent1Models(cleanProvider);
    // Switch to provider default model if current model does not match
    const catalog = getCuratedCatalog(cleanProvider);
    if (catalog.length > 0 && !catalog.some((m) => m.id === agent1Model)) {
      updateAgent1Model(catalog[0].id);
    }
    void persistAllSettings({ provider: cleanProvider });
  };

  const updateShortcut = async (newShortcut: string) => {
    setShortcut(newShortcut);
    try {
      await saveSettings(
        provider,
        newShortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save shortcut:', err);
    }
  };

  const updateSarvamApiKey = async (newKey: string) => {
    setSarvamApiKey(newKey);
    sarvamApiKeyRef.current = newKey;
    try {
      await saveSettings(
        provider,
        shortcut,
        newKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save Sarvam API key:', err);
    }
  };

  const updateGroqApiKey = async (newKey: string) => {
    setGroqApiKey(newKey);
    if (newKey.trim().length > 10) {
      void refreshAgent1Models('groq', newKey);
    }
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        newKey,
        deepseekApiKey,
        customUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save Groq API key:', err);
    }
  };

  const updateDeepseekApiKey = async (newKey: string) => {
    setDeepseekApiKey(newKey);
    if (newKey.trim().length > 10) {
      void refreshAgent1Models('deepseek', newKey);
    }
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        newKey,
        customUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save DeepSeek API key:', err);
    }
  };

  const updateCustomUrl = async (newUrl: string) => {
    setCustomUrl(newUrl);
    void refreshAgent1Models('custom', customApiKey, newUrl);
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        newUrl,
        customModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save custom URL:', err);
    }
  };

  const updateCustomModel = async (newModel: string) => {
    setCustomModel(newModel);
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        newModel,
        customApiKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save custom model:', err);
    }
  };

  const updateCustomApiKey = async (newKey: string) => {
    setCustomApiKey(newKey);
    try {
      await saveSettings(
        provider,
        shortcut,
        sarvamApiKey,
        groqApiKey,
        deepseekApiKey,
        customUrl,
        customModel,
        newKey,
        assemblyaiApiKey,
        voiceProvider
      );
    } catch (err) {
      console.error('Failed to save custom API key:', err);
    }
  };

  const handleRecipeDecision = async (save: boolean) => {
    if (!recipePrompt || recipeBusy) return;
    setRecipeBusy(true);
    try {
      await confirmRecipeSave(recipePrompt.recipe_id, save);
    } catch (err) {
      console.error('Failed to confirm recipe save:', err);
    } finally {
      setRecipeBusy(false);
      setRecipePrompt(null);
    }
  };

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const glowContainerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const showStatus = isRunning || status !== defaultStatus;
  const showSummaryBubble = shouldShowSummaryBubble({
    isRunning,
    status,
    defaultStatus,
    steps,
    forceShow: showGuideCompletionSummary,
  });

  // Focus input when open-command event is heard and prewarm connections
  useEffect(() => {
    const focusInput = () => {
      stopSpeaking();
      if (!isRunning && !isRecording) {
        void resumeWakeWord();
      }
      window.setTimeout(() => inputRef.current?.focus(), 60);
    };
    focusInput();

    const unlisten = listen('blinky://open-command', focusInput);
    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, [sarvamApiKey]);

  useEffect(() => {
    const unlisten = listen('blinky://wake-word-detected', () => {
      if (!mediaRecorderRef.current) {
        void pauseWakeWord();
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        } else if (audioCtxRef.current.state === 'suspended') {
          void audioCtxRef.current.resume();
        }
        stopSpeaking();
        void startRecording();
      }
    });
    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, [startRecording, stopSpeaking]);

  useEffect(() => {
    const unlisten = listen<TargetClickedPayload>('blinky://target-clicked', (event) => {
      const query = lastQueryRef.current.trim();
      if (!query || isRunning) return;
      const targetText = event.payload.target_text?.trim();
      const instruction = event.payload.instruction?.trim();
      const clickedStep =
        currentGuideStepsRef.current.find(
          (step) => step.instruction?.trim() === instruction && step.target_text?.trim() === targetText,
        ) || {
          instruction: instruction || '',
          target_text: targetText || '',
          match: null,
        };
      if (!shouldCompleteStepOnHighlightClick(clickedStep, query)) {
        void hideOverlay();
        return;
      }
      rememberCompletedStep(targetText, instruction);
      void hideOverlay();
    });
    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, [isRunning]);

  // Listen for remote Sentinel power events (Hibernate, Shutdown, Reboot, Lock, Sleep)
  useEffect(() => {
    const unlisten = listen<{ action?: string; message?: string }>('blinky://power-event', (event) => {
      const action = event.payload?.action || 'power action';
      const msg = event.payload?.message || `⚡ Sentinel: Remote ${action} initiated.`;
      setStatus(msg);
      setShowGuideCompletionSummary(true);
    });
    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, []);

  // Listen for remote mobile queries: executes with native PC Blinky tutor & autopilot pipeline
  useEffect(() => {
    const unlisten = listen<{ requestId: string; query: string; attachedImage?: string; attachedFile?: unknown }>('blinky://mobile-query', async (event) => {
      const { requestId, query, attachedImage, attachedFile } = event.payload;
      if ((!query || !query.trim()) && !attachedImage) return;
      const cleanQuery = (query || '').trim() || 'Explain what is in this image.';
      setQuestion(cleanQuery);
      try {
        await emit('blinky://mobile-status', {
          requestId: requestId || 'unknown',
          status: 'processing',
          data: { message: `Executing '${cleanQuery}' with AI companion...`, percent: 40 },
        });

        lastTutorResultRef.current = null;
        if (attachedImage) {
          const direct = await runTutor(cleanQuery, lastQueryRef.current || undefined, currentProgress(), conversationHistoryRef.current.slice(-8), false, false, attachedImage, attachedFile);
          lastTutorResultRef.current = direct;
          setStatus(direct.summary);
          await emit('blinky://mobile-status', {
            requestId: requestId || 'unknown',
            status: 'success',
            data: {
              response: direct.summary,
              steps: direct.steps || [],
              screenshot_b64: (direct as any).screenshot_b64,
            },
          });
          return;
        }

        await executeTutor(cleanQuery, false, { resetProgress: true });

        const summary = statusRef.current || `Completed: ${cleanQuery}`;
        const lastResult: any = lastTutorResultRef.current;
        await emit('blinky://mobile-status', {
          requestId: requestId || 'unknown',
          status: 'success',
          data: {
            response: summary,
            steps: currentGuideStepsRef.current,
            screenshot_b64: lastResult?.screenshot_b64,
            screenshot: lastResult?.screenshot,
          },
        });
      } catch (err: any) {
        await emit('blinky://mobile-status', {
          requestId: requestId || 'unknown',
          status: 'error',
          error: {
            code: 'EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
            details: '',
          },
        });
      }
    });
    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, []);

  // Listen for global Enter keypress to auto-advance if the active step is a text-entry step
  useEffect(() => {
    const unlisten = listen('blinky://global-enter', () => {
      // If the Blinky app webview itself has focus, don't auto-complete target app steps
      if (document.hasFocus()) return;

      const query = lastQueryRef.current.trim();
      if (!query || isRunning) return;

      const currentSteps = currentGuideStepsRef.current;
      if (currentSteps.length === 0) return;

      const activeStep = currentSteps[0];
      // Check if it is a text entry step (where shouldCompleteStepOnHighlightClick returns false)
      if (!shouldCompleteStepOnHighlightClick(activeStep)) {
        const targetText = activeStep.target_text?.trim();
        const instruction = activeStep.instruction?.trim();

        rememberCompletedStep(targetText, instruction);

        void hideOverlay();
      }
    });

    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, [isRunning]);



  // Handle clicking outside settings/history dropdown and window focus change/blur
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        toggleButtonRef.current &&
        !toggleButtonRef.current.contains(event.target as Node)
      ) {
        setShowSettings(false);
      }

      if (
        historyDropdownRef.current &&
        !historyDropdownRef.current.contains(event.target as Node) &&
        historyToggleRef.current &&
        !historyToggleRef.current.contains(event.target as Node)
      ) {
        setShowHistory(false);
      }
    }

    const handleBlur = () => {
      setShowSettings(false);
      setShowHistory(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);

    // Listen for Tauri window focus changes to handle global screen clicks
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        setShowSettings(false);
        setShowHistory(false);
      }
    });

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  // Dynamically resize window height based on exact DOM container size to prevent bottom cutoffs when typing long text
  useEffect(() => {
    const formElement = formRef.current;
    if (!formElement) return;

    const resizeWindow = () => {
      const formRect = formElement.getBoundingClientRect();
      let height = formRect.height;

      if (showSettings) {
        height = Math.max(height, 580);
      }

      if (showHistory && historyDropdownRef.current) {
        const hd = historyDropdownRef.current;
        const historyHeight = Math.max(hd.scrollHeight, hd.getBoundingClientRect().height);
        height = Math.max(height, 52 + historyHeight);
      }

      if (showWaModal) {
        height = Math.max(height, 420);
      }

      if (showMobileModal) {
        height = Math.max(height, 460);
      }

      const targetHeight = Math.ceil(height + 40);
      void resizeCommandWindow(targetHeight);
    };

    resizeWindow();
    // Re-measure after layout/fonts settle so the full menu height is used.
    const raf = requestAnimationFrame(resizeWindow);

    const observer = new ResizeObserver(() => {
      resizeWindow();
    });

    observer.observe(formElement);
    if (showSettings && dropdownRef.current) {
      observer.observe(dropdownRef.current);
    }
    if (showHistory && historyDropdownRef.current) {
      observer.observe(historyDropdownRef.current);
    }
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [showSettings, showHistory, showWaModal, showMobileModal, waStatus, provider, voiceProvider]);

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setIsTaskCompleted(false);
    setQuestion(event.target.value);
    const textarea = event.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed && attachedFiles.length === 0) return;
    if (isRunning) return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    } else if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }

    void executeTutor(trimmed || 'merge these videos', false);
  }

  let renderWordIndex = 0;

  const highlightText = (node: any): any => {
    if (typeof node === 'string') {
      const words = node.split(/(\s+)/); // keep whitespace
      return words.map((word, idx) => {
        if (!word.trim()) {
          return word;
        }

        const currentIdx = renderWordIndex;
        renderWordIndex++;

        const isCurrent = isTtsActive && currentIdx === activeWordIndex;
        const isSpoken = !isTtsActive || currentIdx < activeWordIndex;

        return (
          <span
            key={currentIdx}
            className={`word-node ${isCurrent ? 'active-speaking-word' : isSpoken ? 'spoken-word' : 'unspoken-word'}`}
          >
            {word}
          </span>
        );
      });
    }

    if (Array.isArray(node)) {
      return node.map((child, idx) => <span key={idx}>{highlightText(child)}</span>);
    }

    if (node && isValidElement(node)) {
      const children = (node.props as any).children;
      if (children) {
        return cloneElement(node, {
          children: highlightText(children)
        } as any);
      }
    }

    return node;
  };

  const markdownComponents = {
    p: ({ children }: any) => {
      return <p className="markdown-p">{highlightText(children)}</p>;
    },
    li: ({ children }: any) => {
      return <li className="markdown-li">{highlightText(children)}</li>;
    },
    ul: ({ children }: any) => {
      return <ul className="markdown-ul">{children}</ul>;
    },
    ol: ({ children }: any) => {
      return <ol className="markdown-ol">{children}</ol>;
    },
    strong: ({ children }: any) => {
      return <strong className="markdown-strong">{highlightText(children)}</strong>;
    },
    em: ({ children }: any) => {
      return <em className="markdown-em">{highlightText(children)}</em>;
    },
    a: (props: any) => {
      return <ExternalMarkdownLink {...props} children={highlightText(props.children)} />;
    },
    h1: ({ children }: any) => {
      return <h1 className="markdown-h1">{highlightText(children)}</h1>;
    },
    h2: ({ children }: any) => {
      return <h2 className="markdown-h2">{highlightText(children)}</h2>;
    },
    h3: ({ children }: any) => {
      return <h3 className="markdown-h3">{highlightText(children)}</h3>;
    },
    h4: ({ children }: any) => {
      return <h4 className="markdown-h4">{highlightText(children)}</h4>;
    },
    h5: ({ children }: any) => {
      return <h5 className="markdown-h5">{highlightText(children)}</h5>;
    },
    h6: ({ children }: any) => {
      return <h6 className="markdown-h6">{highlightText(children)}</h6>;
    },
    table: ({ children }: any) => {
      return (
        <div className="markdown-table-wrapper">
          <table className="markdown-table">{children}</table>
        </div>
      );
    },
    thead: ({ children }: any) => <thead className="markdown-thead">{children}</thead>,
    tbody: ({ children }: any) => <tbody className="markdown-tbody">{children}</tbody>,
    tr: ({ children }: any) => <tr className="markdown-tr">{children}</tr>,
    th: ({ children }: any) => <th className="markdown-th">{highlightText(children)}</th>,
    td: ({ children }: any) => <td className="markdown-td">{highlightText(children)}</td>,
    blockquote: ({ children }: any) => <blockquote className="markdown-blockquote">{children}</blockquote>,
    hr: () => <hr className="markdown-hr" />,
    code: ({ inline, className, children, ...props }: any) => {
      const isInline = inline ?? !String(children).includes('\n');
      return isInline ? (
        <code className="markdown-inline-code" {...props}>{children}</code>
      ) : (
        <pre className="markdown-pre"><code className="markdown-code-block" {...props}>{children}</code></pre>
      );
    },
  };

  async function startDrag() {
    await getCurrentWindow().startDragging();
  }

  return (
    <main className="command-window">
      <form
        ref={formRef}
        className="command-popup command-mini"
        onSubmit={submit}
      >
        <div
          className="resize-handle resize-handle-left"
          onPointerDown={(e) => startResize(e, 'left')}
          onPointerMove={handleResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
        />
        <div
          className="resize-handle resize-handle-right"
          onPointerDown={(e) => startResize(e, 'right')}
          onPointerMove={handleResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
        />
        <div
          className="command-header"
          data-tauri-drag-region
          onMouseDown={(event) => {
            // Only start dragging if not clicking a button, settings options, or interactive items
            const target = event.target as HTMLElement;
            if (!target.closest('button') && !target.closest('.command-settings-dropdown')) {
              void startDrag();
            }
          }}
        >
          <div className="command-icon">
            <img src="/logo_text.png" alt="Clinky" style={{ height: 32, objectFit: 'contain' }} />
          </div>

          <div className="command-top-hint" data-tauri-drag-region>
            Clinky app <span className="keys">Ctrl + Shift + {shortcut === 'Space' ? 'Space' : 'Enter'}</span>
          </div>

          <div className="command-actions">
            <button
              ref={historyToggleRef}
              type="button"
              className={`icon-action command-history-toggle ${showHistory ? 'active' : ''}`}
              aria-label="History"
              title="Command & Chat History"
              onClick={() => {
                setShowHistory(!showHistory);
                if (!showHistory) {
                  setPcSessions(listPcChatSessions());
                }
              }}
            >
              <Clock size={18} />
            </button>
            <button
              type="button"
              className={`icon-action ${showMobileModal ? 'active' : ''}`}
              aria-label="Connect Mobile"
              title="Connect Mobile (show QR)"
              onClick={openMobileModal}
            >
              <QrCode size={18} />
            </button>
            <button
              ref={toggleButtonRef}
              type="button"
              className={`icon-action command-settings-toggle ${showSettings ? 'active' : ''}`}
              aria-label="Settings"
              onClick={() => setShowSettings(!showSettings)}
            >
              <Settings size={18} />
            </button>
            <button
              type="button"
              className="icon-action"
              aria-label="Minimize"
              onClick={() => getCurrentWindow().minimize()}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              className="icon-action"
              aria-label="Close"
              onClick={() => getCurrentWindow().hide()}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Persistent Chat & Command History Dropdown */}
        {showHistory && (
          <div ref={historyDropdownRef} className="command-history-dropdown">
            <div className="history-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '13px', color: '#fff' }}>
                <Clock size={15} style={{ color: 'var(--accent-color, #ff5a36)' }} />
                <span>Command & Chat History</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  className="history-new-btn"
                  onClick={() => {
                    const newSess = createPcChatSession();
                    setActivePcSession(newSess);
                    setPcSessions(listPcChatSessions());
                    conversationHistoryRef.current = [];
                    setQuestion('');
                    setSteps([]);
                    setShowHistory(false);
                  }}
                  title="Start a new chat session"
                >
                  <Plus size={13} />
                  <span>New Chat</span>
                </button>
                <button
                  type="button"
                  className="icon-action"
                  onClick={() => setShowHistory(false)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className="history-list">
              {pcSessions.length === 0 ? (
                <div className="history-empty">
                  <Clock size={28} style={{ opacity: 0.3, marginBottom: '6px' }} />
                  <div>No saved sessions yet</div>
                  <div style={{ fontSize: '11px', opacity: 0.6 }}>Your commands and conversations will appear here.</div>
                </div>
              ) : (
                pcSessions.map((s) => {
                  const isActive = activePcSession?.id === s.id;
                  const formatTime = (ms: number) => {
                    const sec = Math.floor((Date.now() - ms) / 1000);
                    if (sec < 60) return 'Just now';
                    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
                    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
                    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
                  };
                  return (
                    <div
                      key={s.id}
                      className={`history-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        const switched = switchPcChatSession(s.id);
                        if (switched) {
                          setActivePcSession(switched);
                          conversationHistoryRef.current = switched.messages.slice(-8).map((m) => ({
                            role: m.role === 'user' ? 'student' : 'blinky',
                            content: m.text,
                          }));
                          if (switched.messages.length > 0) {
                            const lastUser = [...switched.messages].reverse().find((m) => m.role === 'user');
                            if (lastUser) setQuestion(lastUser.text);
                          }
                          setShowHistory(false);
                        }
                      }}
                    >
                      <div className="history-item-left">
                        <div className="history-item-title">{s.title}</div>
                        <div className="history-item-meta">
                          <span>{formatTime(s.updatedAt)}</span>
                          <span>•</span>
                          <span>{s.messages.length} msg{s.messages.length !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="history-item-delete"
                        title="Delete session"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = deletePcChatSession(s.id);
                          setActivePcSession(next);
                          setPcSessions(listPcChatSessions());
                          conversationHistoryRef.current = next.messages.slice(-8).map((m) => ({
                            role: m.role === 'user' ? 'student' : 'blinky',
                            content: m.text,
                          }));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {pcSessions.length > 0 && (
              <div className="history-footer">
                <button
                  type="button"
                  className="history-clear-btn"
                  onClick={() => {
                    if (confirm('Clear all conversation history?')) {
                      const fresh = clearAllPcChatSessions();
                      setActivePcSession(fresh);
                      setPcSessions(listPcChatSessions());
                      conversationHistoryRef.current = [];
                    }
                  }}
                >
                  <Trash2 size={12} />
                  <span>Clear All History</span>
                </button>
              </div>
            )}
          </div>
        )}




        {/* Workflow-save prompt (agent loop completed a task) */}
        {recipePrompt && (
          <div className="recipe-prompt-banner">
            <div className="recipe-prompt-title">
              <img src="/blinky_mascot_logo.png" alt="Clinky" style={{ height: 24, objectFit: 'contain' }} />
              <span>Save this workflow?</span>
            </div>
            <div className="recipe-prompt-preview">
              {recipePrompt.preview.length > 0
                ? recipePrompt.preview.slice(0, 6).map((step, i) => (
                  <span key={i} className="recipe-prompt-step">{step}</span>
                ))
                : <span className="recipe-prompt-step">No reusable steps</span>}
            </div>
            <div className="recipe-prompt-actions">
              <button type="button" className="recipe-prompt-btn primary" disabled={recipeBusy} onClick={() => handleRecipeDecision(true)}>
                <Check size={13} /> Save
              </button>
              <button type="button" className="recipe-prompt-btn" disabled={recipeBusy} onClick={() => handleRecipeDecision(false)}>
                <X size={13} /> Discard
              </button>
            </div>
          </div>
        )}

        {isDraggingOver && (
          <div className="command-dropzone-overlay">
            <div className="command-dropzone-icon-row">
              <Film size={24} />
              <ImageIcon size={24} />
              <Music size={24} />
            </div>
            <span className="command-dropzone-text">Drop videos or images to reference in AiCut</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          style={{ display: 'none' }}
          onChange={handleFileInputChange}
        />

        <div
          className="command-stack"
          onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDraggingOver(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              const paths: string[] = [];
              for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                const p = (f as any).path || f.name;
                if (p) paths.push(p);
              }
              addAttachedFiles(paths);
            }
          }}
        >
          <div className="command-input" onClick={() => inputRef.current?.focus()}>
            {attachedFiles.length > 0 && (
              <div className="command-attachments-tray">
                {attachedFiles.map((file) => (
                  <div key={file.path} className={`command-attachment-chip ${file.type}`} title={file.path}>
                    {file.previewUrl ? (
                      <img src={file.previewUrl} alt="" className="command-attachment-thumb" />
                    ) : file.type === 'video' ? (
                      <Film size={13} />
                    ) : file.type === 'audio' ? (
                      <Music size={13} />
                    ) : (
                      <ImageIcon size={13} />
                    )}
                    <span className="command-attachment-name">{file.name}</span>
                    <button
                      type="button"
                      className="command-attachment-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAttachedFile(file.path);
                      }}
                      title="Remove file"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={question}
              onChange={handleInputChange}
              placeholder={
                isRecording
                  ? assemblyaiApiKey || assemblyaiApiKeyRef.current
                    ? assemblyaiVoiceMode === 'agent'
                      ? "⚡ AssemblyAI Voice Agent listening... (Ctrl+Alt)"
                      : "🎙️ AssemblyAI Realtime STT listening... (Ctrl+Alt)"
                    : "Listening... click mic to stop (Ctrl+Alt)"
                  : isTranscribing
                    ? "Transcribing voice with Universal-3 Pro..."
                    : isTaskCompleted
                      ? "Finished! Ask anything... (Ctrl+Alt to speak)"
                      : assemblyaiApiKey || assemblyaiApiKeyRef.current
                        ? `Ask anything or speak (Ctrl+Alt) • AssemblyAI ${assemblyaiVoiceMode === 'agent' ? 'Voice Agent' : 'Realtime STT'}`
                        : "Ask anything... (Ctrl+Alt to speak)"
              }
              disabled={isTranscribing}
              autoFocus
              onKeyDown={(event) => {
                if ((event.key === ' ' || event.code === 'Space') && event.metaKey) {
                  event.preventDefault();
                  if (!isRunning && !isTranscribing) {
                    toggleRecording();
                  }
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit(event);
                }
              }}
            />
            <div className="command-input-actions">
              <div className="command-input-actions-left">
                <button
                  type="button"
                  className={`command-attach-btn ${attachedFiles.length > 0 ? 'has-attachments' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  disabled={isRunning || isTranscribing}
                  title="Attach video or image reference (or drag & drop)"
                >
                  <Paperclip size={16} />
                </button>
                <button
                  type="button"
                  className={`command-websearch-btn ${webSearchEnabled ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setWebSearchEnabled(!webSearchEnabled);
                  }}
                  disabled={isRunning || isTranscribing}
                  title="Toggle Web Search"
                >
                  <Globe size={16} />
                </button>
                <button
                  type="button"
                  className={`command-agent-btn ${agentModeEnabled ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAgentModeEnabled(!agentModeEnabled);
                  }}
                  disabled={isRunning || isTranscribing}
                  title="Toggle Agent Automation"
                >
                  <Bot size={16} />
                </button>
                <button
                  type="button"
                  className="command-agent-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openNotebookWindow();
                  }}
                  disabled={isRunning || isTranscribing}
                  title="Open OKF Notebook Hub"
                >
                  <BookOpen size={16} />
                </button>
              </div>
              <div className="command-input-actions-right">
                <button
                  type="button"
                  className={`command-mic-btn ${isRecording ? 'recording' : ''} ${isTranscribing ? 'loading' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRecording();
                  }}
                  disabled={isRunning || isTranscribing}
                  title={isRecording ? "Stop recording (Ctrl+Alt)" : "Record voice command (Ctrl+Alt)"}
                >
                  {isTranscribing ? (
                    <Loader2 className="spin" size={16} />
                  ) : isRecording ? (
                    <div className="audio-wave">
                      <div className="audio-wave-bar"></div>
                      <div className="audio-wave-bar"></div>
                      <div className="audio-wave-bar"></div>
                    </div>
                  ) : (
                    <Mic size={16} />
                  )}
                </button>
                <button
                  className={`command-send ${isRunning ? 'stopping' : ''}`}
                  type={isRunning ? 'button' : 'submit'}
                  disabled={isTranscribing || (!isRunning && question.trim().length === 0)}
                  onClick={(event) => {
                    if (!isRunning) return;
                    event.preventDefault();
                    event.stopPropagation();
                    stopCurrentRun();
                  }}
                  title={isRunning ? 'Stop desktop task' : 'Send'}
                >
                  {isRunning ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
                </button>
              </div>
            </div>
          </div>

          {(webSearchEnabled || agentModeEnabled) && isRunning && (
            <div className="command-progress-bar-container">
              <div className="command-progress-bar-fill" />
              <div className="command-progress-status-text">
                {agentModeEnabled ? <Bot size={12} className="spin" /> : <Globe size={12} className="spin" />}
                <span>{agentModeEnabled ? 'Agent Automation Active...' : 'Web Intelligence Search Active...'}</span>
              </div>
            </div>
          )}

          {showStatus && (
            <div className="command-result-container">
              {showSummaryBubble && (
                <div className="command-summary-bubble">
                  <img src="/blinky_mascot_logo.png" className="summary-sparkle" style={{ height: 24, objectFit: 'contain' }} alt="Clinky" />
                  <div className="command-summary-text-container">
                    <span className="command-status">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents as any}>
                        {preprocessMarkdown(status)}
                      </ReactMarkdown>
                    </span>
                    {isTaskCompleted && !isRunning && !isTranscribing && !isRecording && status && status !== defaultStatus && (
                      <div className="task-completion-indicator">
                        <span className="indicator-dot" />
                        <span>Finished • Ready for next request</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {steps.length > 0 && (
                <div className="command-steps-panel">
                  <h3>Action Guide</h3>
                  <ul className={`steps ${steps.length === 1 ? 'steps-single' : ''}`}>
                    {steps.map((step, idx) => (
                      <li
                        className={[
                          idx === steps.length - 1 ? 'guide-step-current' : 'guide-step-completed',
                          steps.length === 1 ? 'guide-step-single' : '',
                        ].filter(Boolean).join(' ')}
                        key={`${step.step || idx}-${step.instruction}-${step.target_text}`}
                      >
                        {steps.length > 1 && <span>{idx + 1}</span>}
                        <div>
                          <p>{step.instruction}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </form>

      {showWaModal && (
        <div className="wa-modal-backdrop" onClick={() => setShowWaModal(false)}>
          <div className="wa-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="wa-modal-header">
              <h3>WhatsApp Connection</h3>
              <button
                type="button"
                className="wa-modal-close"
                onClick={() => setShowWaModal(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="wa-modal-content">
              {waStatus === 'loading' && (
                <div className="wa-disconnected">
                  <div className="wa-loader">
                    <Loader2 className="spin" size={16} />
                    <span>Loading WhatsApp status...</span>
                  </div>
                  <button
                    type="button"
                    className="wa-btn wa-btn-logout"
                    onClick={logoutWhatsApp}
                    disabled={isWaActionLoading}
                  >
                    {isWaActionLoading ? <Loader2 className="spin" size={14} /> : 'Logout WhatsApp'}
                  </button>
                </div>
              )}

              {waStatus === 'disconnected' && (
                <div className="wa-disconnected">
                  <p className="wa-help-text">Connect to summarize group or direct chats using AI commands.</p>
                  <button
                    type="button"
                    className="wa-btn wa-btn-connect"
                    onClick={() => connectWhatsApp()}
                    disabled={isWaActionLoading}
                  >
                    {isWaActionLoading ? <Loader2 className="spin" size={14} /> : 'Connect WhatsApp'}
                  </button>
                </div>
              )}

              {waStatus === 'qr' && (
                <div className="wa-qr-container">
                  <p className="wa-scan-instruction">Scan this QR code with WhatsApp Linked Devices:</p>
                  <div className="wa-qr-canvas-wrapper">
                    <canvas ref={waCanvasRef} className="wa-qr-canvas" />
                    {isWaActionLoading && (
                      <div className="wa-qr-overlay">
                        <Loader2 className="spin" size={24} />
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="wa-btn wa-btn-cancel"
                    onClick={logoutWhatsApp}
                    disabled={isWaActionLoading}
                  >
                    Cancel Connection
                  </button>
                </div>
              )}

              {waStatus === 'connected' && (
                <div className="wa-connected">
                  <div className="wa-status-badge">
                    <Check size={14} className="wa-check-icon" />
                    <span>WhatsApp Connected</span>
                  </div>
                  <button
                    type="button"
                    className="wa-btn wa-btn-logout"
                    onClick={logoutWhatsApp}
                    disabled={isWaActionLoading}
                  >
                    {isWaActionLoading ? <Loader2 className="spin" size={14} /> : 'Disconnect Account'}
                  </button>
                </div>
              )}

              {waStatus === 'error' && (
                <div className="wa-error-container">
                  <p className="wa-error-msg">{waError || 'An error occurred'}</p>
                  <button
                    type="button"
                    className="wa-btn wa-btn-retry"
                    onClick={() => connectWhatsApp()}
                    disabled={isWaActionLoading}
                  >
                    Retry Connection
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showMobileModal && (
        <div className="wa-modal-backdrop" onClick={() => setShowMobileModal(false)}>
          <div className="wa-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="wa-modal-header">
              <h3>Connect Mobile</h3>
              <button
                type="button"
                className="wa-modal-close"
                onClick={() => setShowMobileModal(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="wa-modal-content">
              {pairingLoading && !pairingPayload && (
                <div className="wa-disconnected">
                  <div className="wa-loader">
                    <Loader2 className="spin" size={16} />
                    <span>Preparing pairing code...</span>
                  </div>
                </div>
              )}

              {pairingError && (
                <div className="wa-error-container">
                  <p className="wa-error-msg">{pairingError}</p>
                  <button
                    type="button"
                    className="wa-btn wa-btn-retry"
                    onClick={() => loadPairingPayload()}
                    disabled={pairingLoading}
                  >
                    Retry
                  </button>
                </div>
              )}

              {pairingPayload && !pairingError && (
                <div className="wa-qr-container">
                  <p className="wa-scan-instruction">Scan with the Clinky mobile app (QR tab):</p>
                  {pairingPayload.ips.length > 1 && (
                    <div className="pairing-ip-row">
                      <span className="wa-help-text">PC IP:</span>
                      <select
                        className="pairing-ip-select"
                        value={pairingIp}
                        onChange={(e) => setPairingIp(e.target.value)}
                      >
                        {pairingPayload.ips.map((ip) => (
                          <option key={ip} value={ip}>{ip}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="wa-qr-canvas-wrapper">
                    <canvas ref={mobileCanvasRef} className="wa-qr-canvas" />
                    {pairingLoading && (
                      <div className="wa-qr-overlay">
                        <Loader2 className="spin" size={24} />
                      </div>
                    )}
                  </div>
                  {pairingPayload.ips.length === 0 ? (
                    <p className="wa-error-msg">No LAN address detected. Enter the PC IP manually in the app (see ./setup-mobile.sh output).</p>
                  ) : (
                    <p className="wa-help-text">Or enter manually: IP {pairingIp} :{pairingPayload.ws_port}, then Establish Link.</p>
                  )}
                  <p className="wa-help-text pairing-warning">Anyone who scans this can control this PC on your LAN.</p>
                  <button
                    type="button"
                    className="wa-btn wa-btn-cancel"
                    onClick={handleRegenerateToken}
                    disabled={pairingLoading}
                  >
                    {pairingLoading ? <Loader2 className="spin" size={14} /> : 'Regenerate code'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="settings-modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="settings-modal-dialog" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="settings-modal-header">
              <div className="settings-modal-header-left">
                <div className="settings-about-logo" style={{ width: '32px', height: '32px', borderRadius: '8px' }}>
                  <Sliders size={16} />
                </div>
                <div>
                  <h3>Settings &amp; Intelligence</h3>
                  <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>
                    Multi-agent orchestrator, endpoints, and credentials
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {pingTesting && (
                  <span className="settings-ping-chip" style={{ background: 'rgba(255, 90, 54, 0.15)', color: '#ff8b6a' }}>
                    <Loader2 className="spin" size={12} /> Pinging...
                  </span>
                )}
                {pingResult && !pingTesting && (
                  <span className={`settings-ping-chip ${pingResult.ok ? 'success' : 'error'}`}>
                    {pingResult.ok ? (
                      <>⚡ {pingResult.latency_ms}ms ({pingResult.provider})</>
                    ) : (
                      <>❌ Ping Failed</>
                    )}
                  </span>
                )}
                <button
                  type="button"
                  className="settings-modal-close"
                  onClick={() => setShowSettings(false)}
                  title="Close Settings (Esc)"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="settings-modal-body">
              {/* Sidebar */}
              <div className="settings-modal-sidebar">
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'agent1' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('agent1')}
                >
                  <Bot size={15} />
                  <span>Agent 1: OS Actuator</span>
                </button>
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'agent2' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('agent2')}
                >
                  <Brain size={15} />
                  <span>Agent 2: Knowledge &amp; RAG</span>
                </button>
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'voice' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('voice')}
                >
                  <Mic size={15} />
                  <span>Voice &amp; Audio</span>
                </button>
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'keys' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('keys')}
                >
                  <Key size={15} />
                  <span>Credentials &amp; APIs</span>
                </button>
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'mobile' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('mobile')}
                >
                  <Smartphone size={15} />
                  <span>Mobile Companion</span>
                </button>
                <button
                  type="button"
                  className={`settings-sidebar-btn ${settingsTab === 'about' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('about')}
                >
                  <Info size={15} />
                  <span>Keybindings &amp; System</span>
                </button>
              </div>

              {/* Content Area */}
              <div className="settings-modal-content">
                {/* TAB 1: AGENT 1 - OS ACTUATOR */}
                {settingsTab === 'agent1' && (
                  <div className="settings-section-card settings-agent-card agent1-active">
                    <div className="settings-section-title">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Bot size={16} style={{ color: '#ff5a36' }} />
                        <span>Agent 1: OS Actuator</span>
                      </div>
                      <span className="agent-badge-pill ember">Vision &amp; Computer Use</span>
                    </div>
                    <p className="settings-help-text">
                      Orchestrates natural language commands into vision-guided OS clicks, keystrokes, and workflows.
                    </p>

                    <div className="settings-input-group">
                      <label className="settings-label">Backend Actuator Provider</label>
                      <div className="settings-provider-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                        <div
                          className={`provider-grid-item ${provider === 'gemini' ? 'active' : ''}`}
                          onClick={() => void updateProvider('gemini')}
                        >
                          <Brain size={15} style={{ color: '#c084fc' }} />
                          <span className="provider-grid-item-label">Google Gemini</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'vertex' ? 'active' : ''}`}
                          onClick={() => void updateProvider('vertex')}
                        >
                          <Cloud size={15} style={{ color: '#60a5fa' }} />
                          <span className="provider-grid-item-label">Vertex AI</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'antigravity' ? 'active' : ''}`}
                          onClick={() => void updateProvider('antigravity')}
                        >
                          <Sparkles size={15} style={{ color: '#38bdf8' }} />
                          <span className="provider-grid-item-label">Antigravity</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'codex' ? 'active' : ''}`}
                          onClick={() => void updateProvider('codex')}
                        >
                          <Cpu size={15} style={{ color: '#10b981' }} />
                          <span className="provider-grid-item-label">OpenAI Codex</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'openai' ? 'active' : ''}`}
                          onClick={() => void updateProvider('openai')}
                        >
                          <Sparkles size={15} style={{ color: '#34d399' }} />
                          <span className="provider-grid-item-label">OpenAI</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'anthropic' ? 'active' : ''}`}
                          onClick={() => void updateProvider('anthropic')}
                        >
                          <Brain size={15} style={{ color: '#f97316' }} />
                          <span className="provider-grid-item-label">Anthropic</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'custom' ? 'active' : ''}`}
                          onClick={() => void updateProvider('custom')}
                        >
                          <Wrench size={15} style={{ color: '#e2e8f0' }} />
                          <span className="provider-grid-item-label">Custom API</span>
                        </div>
                        <div
                          className={`provider-grid-item ${provider === 'ollama' ? 'active' : ''}`}
                          onClick={() => void updateProvider('ollama')}
                        >
                          <Cpu size={15} style={{ color: '#fbbf24' }} />
                          <span className="provider-grid-item-label">Ollama (Local)</span>
                        </div>
                      </div>
                    </div>

                    {/* Model Selector & Search for Agent 1 */}
                    <div className="settings-input-group">
                      <div className="settings-input-header">
                        <label className="settings-label">Actuator Model</label>
                        <button
                          type="button"
                          className="settings-btn-action settings-btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '10.5px' }}
                          onClick={() => void refreshAgent1Models()}
                          disabled={agent1ModelsLoading}
                        >
                          <RefreshCw className={agent1ModelsLoading ? 'spin' : ''} size={11} />
                          <span>{agent1ModelsLoading ? 'Fetching...' : 'Sync Models'}</span>
                        </button>
                      </div>

                      <div className="settings-search-container">
                        <div className="settings-model-selector-row">
                          <div className="settings-model-info">
                            <span className="settings-model-name">{agent1Model}</span>
                            <span className="settings-model-sub">Provider: {provider.toUpperCase()}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              type="button"
                              className="settings-btn-action"
                              onClick={() => setIsAgent1SearchOpen(!isAgent1SearchOpen)}
                            >
                              <Search size={12} />
                              <span>{isAgent1SearchOpen ? 'Close Search' : 'Change Model'}</span>
                            </button>
                            <button
                              type="button"
                              className="settings-btn-action settings-btn-secondary"
                              onClick={() => void handleTestPing(provider, getProviderKey(provider), agent1Model, customUrl)}
                              disabled={pingTesting}
                            >
                              ⚡ Ping
                            </button>
                          </div>
                        </div>

                        {isAgent1SearchOpen && (
                          <div className="settings-search-dropdown-menu">
                            <input
                              type="text"
                              className="settings-text-input"
                              placeholder={`Search or type custom model for ${provider}...`}
                              value={agent1SearchQuery}
                              onChange={(e) => setAgent1SearchQuery(e.target.value)}
                              autoFocus
                            />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px', maxHeight: '240px', overflowY: 'auto' }}>
                              {agent1SearchQuery.trim() && !agent1ModelsList.some((m) => m.id.toLowerCase() === agent1SearchQuery.trim().toLowerCase()) && (
                                <div
                                  className="settings-search-item"
                                  style={{ borderBottom: '1px dashed rgba(255, 255, 255, 0.15)' }}
                                  onClick={() => {
                                    updateAgent1Model(agent1SearchQuery.trim());
                                    setIsAgent1SearchOpen(false);
                                  }}
                                >
                                  <div>
                                    <div style={{ fontWeight: 600, color: '#38bdf8' }}>Use custom model: "{agent1SearchQuery.trim()}"</div>
                                    <div style={{ fontSize: '10px', color: '#94a3b8' }}>Click to apply custom model slug</div>
                                  </div>
                                  <Plus size={14} style={{ color: '#38bdf8' }} />
                                </div>
                              )}
                              {agent1ModelsList
                                .filter((m) =>
                                  m.id.toLowerCase().includes(agent1SearchQuery.toLowerCase()) ||
                                  (m.name && m.name.toLowerCase().includes(agent1SearchQuery.toLowerCase()))
                                )
                                .slice(0, 30)
                                .map((m) => (
                                  <div
                                    key={m.id}
                                    className={`settings-search-item ${agent1Model === m.id ? 'selected' : ''}`}
                                    onClick={() => {
                                      updateAgent1Model(m.id);
                                      setIsAgent1SearchOpen(false);
                                    }}
                                  >
                                    <div>
                                      <div style={{ fontWeight: 600 }}>{m.name || m.id}</div>
                                      <div style={{ fontSize: '10px', color: '#94a3b8' }}>{m.id}</div>
                                    </div>
                                    {agent1Model === m.id && <Check size={14} style={{ color: '#ff5a36' }} />}
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Reasoning & Deliberation Thinking Level */}
                    <div className="settings-input-group" style={{ marginTop: '16px' }}>
                      <div className="settings-input-header">
                        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Sliders size={14} style={{ color: '#ff5a36' }} />
                          <span>Deliberation Thinking Level</span>
                        </label>
                        <span className="agent-badge-pill ember" style={{ fontSize: '10px' }}>
                          {thinkingLevel === 'off' ? 'Off / None' : thinkingLevel === 'low' ? 'Low (Fast)' : thinkingLevel === 'medium' ? 'Medium (Balanced)' : 'High (Deep Reasoning)'}
                        </span>
                      </div>
                      <div className="settings-provider-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        <div
                          className={`provider-grid-item ${thinkingLevel === 'off' ? 'active' : ''}`}
                          onClick={() => updateThinkingLevel('off')}
                        >
                          <span className="provider-grid-item-label">Off / None</span>
                          <span style={{ fontSize: '10px', color: '#94a3b8' }}>Zero latency</span>
                        </div>
                        <div
                          className={`provider-grid-item ${thinkingLevel === 'low' ? 'active' : ''}`}
                          onClick={() => updateThinkingLevel('low')}
                        >
                          <span className="provider-grid-item-label">Low</span>
                          <span style={{ fontSize: '10px', color: '#94a3b8' }}>Fast reflection</span>
                        </div>
                        <div
                          className={`provider-grid-item ${thinkingLevel === 'medium' ? 'active' : ''}`}
                          onClick={() => updateThinkingLevel('medium')}
                        >
                          <span className="provider-grid-item-label">Medium</span>
                          <span style={{ fontSize: '10px', color: '#94a3b8' }}>Balanced · Default</span>
                        </div>
                        <div
                          className={`provider-grid-item ${thinkingLevel === 'high' ? 'active' : ''}`}
                          onClick={() => updateThinkingLevel('high')}
                        >
                          <span className="provider-grid-item-label">High</span>
                          <span style={{ fontSize: '10px', color: '#94a3b8' }}>Deep Reasoning</span>
                        </div>
                      </div>
                      <p className="settings-help-text" style={{ marginTop: '6px' }}>
                        Controls the reasoning budget for vision-guided click decomposition, auto-routing decisions, and multi-step tasks.
                      </p>
                    </div>
                  </div>
                )}

                {/* TAB 2: AGENT 2 - KNOWLEDGE & RAG */}
                {settingsTab === 'agent2' && (
                  <div className="settings-section-card settings-agent-card agent2-active">
                    <div className="settings-section-title">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Brain size={16} style={{ color: '#c084fc' }} />
                        <span>Agent 2: Knowledge &amp; RAG</span>
                      </div>
                      <span className="agent-badge-pill violet">Multimodal &amp; Grounding</span>
                    </div>
                    <p className="settings-help-text">
                      Powers document synthesis, smart context grounding, offline/online vector search, and web citations.
                    </p>

                    <div className="settings-input-group">
                      <label className="settings-label">Knowledge Engine Provider</label>
                      <div className="settings-provider-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'gemini' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('gemini')}
                        >
                          <Brain size={15} style={{ color: '#c084fc' }} />
                          <span className="provider-grid-item-label">Google Gemini</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'vertex' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('vertex')}
                        >
                          <Cloud size={15} style={{ color: '#60a5fa' }} />
                          <span className="provider-grid-item-label">Vertex AI</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'antigravity' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('antigravity')}
                        >
                          <Sparkles size={15} style={{ color: '#38bdf8' }} />
                          <span className="provider-grid-item-label">Antigravity</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'codex' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('codex')}
                        >
                          <Cpu size={15} style={{ color: '#10b981' }} />
                          <span className="provider-grid-item-label">OpenAI Codex</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'openai' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('openai')}
                        >
                          <Sparkles size={15} style={{ color: '#34d399' }} />
                          <span className="provider-grid-item-label">OpenAI</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'anthropic' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('anthropic')}
                        >
                          <Brain size={15} style={{ color: '#f97316' }} />
                          <span className="provider-grid-item-label">Anthropic</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'custom' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('custom')}
                        >
                          <Wrench size={15} style={{ color: '#e2e8f0' }} />
                          <span className="provider-grid-item-label">Custom API</span>
                        </div>
                        <div
                          className={`provider-grid-item ${agent2Provider === 'ollama' ? 'active' : ''}`}
                          onClick={() => updateAgent2Provider('ollama')}
                        >
                          <Cpu size={15} style={{ color: '#fbbf24' }} />
                          <span className="provider-grid-item-label">Ollama (Local)</span>
                        </div>
                      </div>
                    </div>

                    {/* Model Selector & Search for Agent 2 */}
                    <div className="settings-input-group">
                      <div className="settings-input-header">
                        <label className="settings-label">Knowledge Model</label>
                        <button
                          type="button"
                          className="settings-btn-action settings-btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '10.5px' }}
                          onClick={() => void refreshAgent2Models()}
                          disabled={agent2ModelsLoading}
                        >
                          <RefreshCw className={agent2ModelsLoading ? 'spin' : ''} size={11} />
                          <span>{agent2ModelsLoading ? 'Fetching...' : 'Sync Catalog'}</span>
                        </button>
                      </div>

                      <div className="settings-search-container">
                        <div className="settings-model-selector-row">
                          <div className="settings-model-info">
                            <span className="settings-model-name">{agent2Model}</span>
                            <span className="settings-model-sub">Provider: {agent2Provider.toUpperCase()}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              type="button"
                              className="settings-btn-action"
                              onClick={() => setIsAgent2SearchOpen(!isAgent2SearchOpen)}
                            >
                              <Search size={12} />
                              <span>{isAgent2SearchOpen ? 'Close Search' : 'Change Model'}</span>
                            </button>
                            <button
                              type="button"
                              className="settings-btn-action settings-btn-secondary"
                              onClick={() => void handleTestPing(agent2Provider, getProviderKey(agent2Provider), agent2Model, customUrl)}
                              disabled={pingTesting}
                            >
                              ⚡ Ping
                            </button>
                          </div>
                        </div>

                        {isAgent2SearchOpen && (
                          <div className="settings-search-dropdown-menu">
                            <input
                              type="text"
                              className="settings-text-input"
                              placeholder={`Search or type custom model for ${agent2Provider}...`}
                              value={agent2SearchQuery}
                              onChange={(e) => setAgent2SearchQuery(e.target.value)}
                              autoFocus
                            />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px', maxHeight: '240px', overflowY: 'auto' }}>
                              {agent2SearchQuery.trim() && !agent2ModelsList.some((m) => m.id.toLowerCase() === agent2SearchQuery.trim().toLowerCase()) && (
                                <div
                                  className="settings-search-item"
                                  style={{ borderBottom: '1px dashed rgba(255, 255, 255, 0.15)' }}
                                  onClick={() => {
                                    updateAgent2Model(agent2SearchQuery.trim());
                                    setIsAgent2SearchOpen(false);
                                  }}
                                >
                                  <div>
                                    <div style={{ fontWeight: 600, color: '#38bdf8' }}>Use custom model: "{agent2SearchQuery.trim()}"</div>
                                    <div style={{ fontSize: '10px', color: '#94a3b8' }}>Click to apply custom model slug</div>
                                  </div>
                                  <Plus size={14} style={{ color: '#38bdf8' }} />
                                </div>
                              )}
                              {agent2ModelsList
                                .filter((m) =>
                                  m.id.toLowerCase().includes(agent2SearchQuery.toLowerCase()) ||
                                  (m.name && m.name.toLowerCase().includes(agent2SearchQuery.toLowerCase()))
                                )
                                .slice(0, 30)
                                .map((m) => (
                                  <div
                                    key={m.id}
                                    className={`settings-search-item ${agent2Model === m.id ? 'selected' : ''}`}
                                    onClick={() => {
                                      updateAgent2Model(m.id);
                                      setIsAgent2SearchOpen(false);
                                    }}
                                  >
                                    <div>
                                      <div style={{ fontWeight: 600 }}>{m.name || m.id}</div>
                                      <div style={{ fontSize: '10px', color: '#94a3b8' }}>{m.id}</div>
                                    </div>
                                    {agent2Model === m.id && <Check size={14} style={{ color: '#c084fc' }} />}
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Web Search Grounding toggle with explanation */}
                    <div className="settings-section-card" style={{ marginTop: '16px', background: 'rgba(255, 255, 255, 0.03)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <Globe size={18} style={{ color: webSearchEnabled ? '#38bdf8' : '#94a3b8' }} />
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>Web Search Grounding</div>
                            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                              Grounds answers using live Google Search citations and internet intelligence.
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`settings-btn-action ${webSearchEnabled ? 'active' : 'settings-btn-secondary'}`}
                          style={{ padding: '6px 14px', fontSize: '12px', minWidth: '95px' }}
                          onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                        >
                          {webSearchEnabled ? '✓ Enabled' : 'Disabled'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 3: VOICE & AUDIO */}
                {settingsTab === 'voice' && (
                  <div className="settings-section-card settings-agent-card">
                    <div className="settings-section-title">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Mic size={16} style={{ color: '#4ade80' }} />
                        <span>Voice &amp; Audio Architecture</span>
                      </div>
                      <span className="agent-badge-pill emerald">Streaming Voice &amp; STT</span>
                    </div>
                    <p className="settings-help-text">
                      High-fidelity speech transcription, bidirectional speech APIs, rate-limit fallback failover, and audio synthesis.
                    </p>

                    {/* 1. Primary STT Model Selector */}
                    <div className="settings-input-group" style={{ marginTop: '12px' }}>
                      <div className="settings-input-header">
                        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Sparkles size={14} style={{ color: '#c084fc' }} />
                          <span>Primary STT Model (Speech-to-Text)</span>
                        </label>
                        <span className="agent-badge-pill violet" style={{ fontSize: '10px' }}>{primarySttModel}</span>
                      </div>
                      <select
                        className="settings-text-input"
                        value={primarySttModel}
                        onChange={(e) => updatePrimarySttModel(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', background: 'rgba(0, 0, 0, 0.45)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px' }}
                      >
                        <option value="gemini-3.5-transcribe" style={{ background: '#1e293b' }}>Gemini 3.5 Transcribe (Default · Low Latency)</option>
                        <option value="gemini-3.5-flash-lite" style={{ background: '#1e293b' }}>Gemini 3.5 Flash-Lite (Quota-Friendly)</option>
                        <option value="gemini-3.8-flash" style={{ background: '#1e293b' }}>Gemini 3.8 Flash (Multimodal)</option>
                        <option value="whisper-1" style={{ background: '#1e293b' }}>OpenAI Whisper-1</option>
                        <option value="groq-whisper" style={{ background: '#1e293b' }}>Groq Whisper Large V3</option>
                        <option value="assemblyai" style={{ background: '#1e293b' }}>AssemblyAI Universal-3 Pro</option>
                        <option value="sarvam" style={{ background: '#1e293b' }}>Sarvam AI Multilingual (Indic Languages)</option>
                      </select>
                    </div>

                    {/* 2. Fallback STT Model Selector */}
                    <div className="settings-input-group" style={{ marginTop: '12px' }}>
                      <div className="settings-input-header">
                        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Cpu size={14} style={{ color: '#38bdf8' }} />
                          <span>Fallback STT Model (Rate-Limit &amp; Error Failover)</span>
                        </label>
                        <span className="agent-badge-pill ember" style={{ fontSize: '10px' }}>{fallbackSttModel}</span>
                      </div>
                      <select
                        className="settings-text-input"
                        value={fallbackSttModel}
                        onChange={(e) => updateFallbackSttModel(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', background: 'rgba(0, 0, 0, 0.45)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px' }}
                      >
                        <option value="gemini-3.5-flash-lite" style={{ background: '#1e293b' }}>Gemini 3.5 Flash-Lite (Recommended Fallback)</option>
                        <option value="gemini-3.8-flash" style={{ background: '#1e293b' }}>Gemini 3.8 Flash</option>
                        <option value="whisper-1" style={{ background: '#1e293b' }}>OpenAI Whisper-1</option>
                        <option value="groq-whisper" style={{ background: '#1e293b' }}>Groq Whisper Large V3</option>
                        <option value="none" style={{ background: '#1e293b' }}>None (Disable Fallback)</option>
                      </select>
                    </div>

                    {/* 3. Bidirectional Speech Primary Model Selector */}
                    <div className="settings-input-group" style={{ marginTop: '14px' }}>
                      <div className="settings-input-header">
                        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Zap size={14} style={{ color: '#4ade80' }} />
                          <span>Bidirectional Speech Primary Model (Live API)</span>
                        </label>
                        <span className="agent-badge-pill emerald" style={{ fontSize: '10px' }}>{primaryLiveModel}</span>
                      </div>
                      <select
                        className="settings-text-input"
                        value={primaryLiveModel}
                        onChange={(e) => updatePrimaryLiveModel(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', background: 'rgba(0, 0, 0, 0.45)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px' }}
                      >
                        <option value="gemini-3.5-transcribe-live" style={{ background: '#1e293b' }}>Gemini 3.5 Transcribe Live ($0.54/hr · Ultra Low Latency)</option>
                        <option value="gemini-3.8-live" style={{ background: '#1e293b' }}>Gemini 3.8 Live ($1.35/hr · Live Conversational Audio)</option>
                        <option value="gemini-3.8-live-thinking" style={{ background: '#1e293b' }}>Gemini 3.8 Live Extended Thinking ($2.10/hr · Reasoning Live)</option>
                        <option value="assemblyai" style={{ background: '#1e293b' }}>AssemblyAI Realtime Agent (Conversational Voice Agent)</option>
                        <option value="sarvam" style={{ background: '#1e293b' }}>Sarvam AI Multilingual Streaming (Indian Accents)</option>
                      </select>
                    </div>

                    {/* 4. Bidirectional Speech Fallback Model Selector */}
                    <div className="settings-input-group" style={{ marginTop: '12px' }}>
                      <div className="settings-input-header">
                        <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Volume2 size={14} style={{ color: '#f59e0b' }} />
                          <span>Bidirectional Speech Fallback Model</span>
                        </label>
                        <span className="agent-badge-pill ember" style={{ fontSize: '10px' }}>{fallbackLiveModel}</span>
                      </div>
                      <select
                        className="settings-text-input"
                        value={fallbackLiveModel}
                        onChange={(e) => updateFallbackLiveModel(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', background: 'rgba(0, 0, 0, 0.45)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px' }}
                      >
                        <option value="gemini-3.5-flash-lite" style={{ background: '#1e293b' }}>Gemini 3.5 Flash-Lite (Recommended)</option>
                        <option value="gemini-3.8-flash" style={{ background: '#1e293b' }}>Gemini 3.8 Flash</option>
                        <option value="none" style={{ background: '#1e293b' }}>None (Disable Fallback)</option>
                      </select>
                    </div>

                    {/* 5. Automatic 429 Rate-Limit Fallback Switch */}
                    <div className="settings-section-card" style={{ marginTop: '14px', background: 'rgba(255, 255, 255, 0.03)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px' }}>
                      <div>
                        <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Zap size={14} style={{ color: '#ff5a36' }} />
                          <span>Automatic 429 Rate-Limit Fallback</span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                          Automatically failover to secondary model upon receiving HTTP 429 rate limit or quota exhaustion.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '8px' }}>
                        <input
                          type="checkbox"
                          checked={autoRateLimitFallback}
                          onChange={(e) => updateAutoRateLimitFallback(e.target.checked)}
                          style={{ width: '16px', height: '16px', accentColor: '#ff5a36', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '11px', fontWeight: 600, color: autoRateLimitFallback ? '#4ade80' : '#94a3b8' }}>
                          {autoRateLimitFallback ? 'ON' : 'OFF'}
                        </span>
                      </label>
                    </div>

                    {/* Audio Playback Test Button */}
                    <div className="settings-section-card" style={{ marginTop: '12px', background: 'rgba(255, 255, 255, 0.03)', padding: '12px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#f1f5f9' }}>Speaker Output Diagnostic</div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            Plays a verification sound chime through your active speakers.
                          </div>
                        </div>
                        <button
                          type="button"
                          className="settings-btn-action"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                          onClick={handleTestAudioPlayback}
                        >
                          🔊 Test Audio Playback
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 4: KEYS & CREDENTIALS */}
                {settingsTab === 'keys' && (
                  <>
                    {/* Antigravity OAuth Card */}
                    <div className="settings-section-card settings-key-card">
                      <div className="settings-input-header">
                        <label className="settings-label">
                          <Sparkles size={14} style={{ color: '#38bdf8' }} />
                          <span>Google Antigravity Code Assist OAuth</span>
                          {antigravityOAuth.connected ? (
                            <span className="key-badge-configured">
                              <Check size={10} /> Connected {antigravityOAuth.email ? `(${antigravityOAuth.email})` : ''}
                            </span>
                          ) : (
                            <span className="key-badge-unconfigured">Not connected</span>
                          )}
                        </label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="settings-btn-action"
                            style={{ padding: '2px 8px', fontSize: '10px' }}
                            onClick={() => void handleTestPing('antigravity', '', agent1Model)}
                            disabled={pingTesting || !antigravityOAuth.connected}
                          >
                            Test ⚡
                          </button>
                          {antigravityOAuth.connected && (
                            <button
                              type="button"
                              className="key-btn-clear"
                              onClick={() => void handleOAuthSignOut('antigravity')}
                              disabled={oauthLoading['antigravity']}
                            >
                              Sign Out
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="settings-help-text">
                        Authenticates directly with Google Cloud via local loopback on port 51121 for Code Assist and Antigravity models.
                      </p>
                      {!antigravityOAuth.connected && (
                        <button
                          type="button"
                          className="settings-btn-action"
                          style={{ alignSelf: 'flex-start', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}
                          onClick={() => void handleOAuthLogin('antigravity')}
                          disabled={oauthLoading['antigravity']}
                        >
                          {oauthLoading['antigravity'] ? <Loader2 className="spin" size={12} /> : <Sparkles size={12} />}
                          <span>{oauthLoading['antigravity'] ? 'Authenticating in browser...' : 'Sign In with Google'}</span>
                        </button>
                      )}
                    </div>

                    {/* Codex OAuth Card */}
                    <div className="settings-section-card settings-key-card">
                      <div className="settings-input-header">
                        <label className="settings-label">
                          <Cpu size={14} style={{ color: '#10b981' }} />
                          <span>OpenAI Codex OAuth (ChatGPT Desktop)</span>
                          {codexOAuth.connected ? (
                            <span className="key-badge-configured">
                              <Check size={10} /> Connected
                            </span>
                          ) : (
                            <span className="key-badge-unconfigured">Not connected</span>
                          )}
                        </label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="settings-btn-action"
                            style={{ padding: '2px 8px', fontSize: '10px' }}
                            onClick={() => void handleTestPing('codex', '', 'gpt-5.5')}
                            disabled={pingTesting || !codexOAuth.connected}
                          >
                            Test ⚡
                          </button>
                          {codexOAuth.connected && (
                            <button
                              type="button"
                              className="key-btn-clear"
                              onClick={() => void handleOAuthSignOut('codex')}
                              disabled={oauthLoading['codex']}
                            >
                              Sign Out
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="settings-help-text">
                        Authenticates directly with OpenAI Codex via local loopback on port 1455 for desktop completions.
                      </p>
                      {!codexOAuth.connected && (
                        <button
                          type="button"
                          className="settings-btn-action"
                          style={{ alignSelf: 'flex-start', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}
                          onClick={() => void handleOAuthLogin('codex')}
                          disabled={oauthLoading['codex']}
                        >
                          {oauthLoading['codex'] ? <Loader2 className="spin" size={12} /> : <Cpu size={12} />}
                          <span>{oauthLoading['codex'] ? 'Authenticating in browser...' : 'Sign In with OpenAI'}</span>
                        </button>
                      )}
                    </div>

                    {/* Google Gemini */}
                    <MaskedKeyInput
                      label="Google Gemini API Key"
                      envName="GEMINI_API_KEY"
                      icon={<Brain size={14} style={{ color: '#c084fc' }} />}
                      isConfigured={Boolean(geminiApiKey && geminiApiKey.trim())}
                      onSave={(val) => updateGeminiApiKey(val)}
                      onClear={() => {
                        updateGeminiApiKey('');
                        localStorage.removeItem('blinky_gemini_api_key');
                      }}
                      description="Enables Gemini multimodal synthesis, grounding, and reasoning."
                      testAction={() => handleTestPing('gemini', geminiApiKey, geminiModel)}
                      testDisabled={pingTesting}
                    />

                    {/* Google Cloud Vertex AI (Service Account JSON & Project ID / Location) */}
                    <div className="settings-section-card settings-key-card">
                      <div className="settings-input-header">
                        <label className="settings-label">
                          <Cloud size={14} style={{ color: '#60a5fa' }} />
                          <span>Google Cloud Vertex AI</span>
                          {vertexParsedSa?.valid ? (
                            <span className="key-badge-configured" style={{ fontSize: '10px' }}>
                              <Check size={10} /> Valid Service Account (Project: {vertexParsedSa.projectId}, Email: {vertexParsedSa.clientEmail})
                            </span>
                          ) : Boolean(vertexProjectId && vertexProjectId.trim()) ? (
                            <span className="key-badge-configured">
                              <Check size={10} /> Project Configured ({vertexProjectId})
                            </span>
                          ) : Boolean(vertexServiceAccountJson.trim()) ? (
                            <span className="key-badge-unconfigured" style={{ color: '#ef4444' }}>
                              Invalid Service Account JSON
                            </span>
                          ) : (
                            <span className="key-badge-unconfigured">Not set</span>
                          )}
                        </label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="settings-btn-action"
                            style={{ padding: '2px 8px', fontSize: '10px' }}
                            onClick={() => void handleTestPing('vertex', geminiApiKey, agent1Model, undefined, vertexProjectId, vertexServiceAccountJson)}
                            disabled={pingTesting || (!vertexProjectId.trim() && !vertexParsedSa?.valid)}
                          >
                            Test ⚡
                          </button>
                          {(Boolean(vertexProjectId && vertexProjectId.trim()) || Boolean(vertexServiceAccountJson.trim())) && (
                            <button
                              type="button"
                              className="key-btn-clear"
                              onClick={() => {
                                updateVertexProjectId('');
                                updateVertexServiceAccountJson('');
                              }}
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                        <input
                          type="text"
                          className="settings-text-input"
                          placeholder="Project ID override (e.g. rising-fact-p41fc)..."
                          value={vertexProjectId}
                          onChange={(e) => updateVertexProjectId(e.target.value)}
                          style={{ flex: 2 }}
                        />
                        <select
                          className="settings-text-input"
                          value={vertexLocation}
                          onChange={(e) => updateVertexLocation(e.target.value)}
                          style={{ flex: 1, padding: '7px 10px', background: 'rgba(255, 255, 255, 0.05)', color: '#fff', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '6px' }}
                        >
                          <option value="global" style={{ background: '#1e293b' }}>global</option>
                          <option value="us-central1" style={{ background: '#1e293b' }}>us-central1</option>
                          <option value="europe-west2" style={{ background: '#1e293b' }}>europe-west2</option>
                          <option value="asia-northeast1" style={{ background: '#1e293b' }}>asia-northeast1</option>
                        </select>
                      </div>

                      {/* Service Account JSON Masked / Editor */}
                      {vertexParsedSa?.valid && !showVertexSaKey ? (
                        <div style={{ marginTop: '8px', padding: '10px 12px', background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(74, 222, 128, 0.3)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div>
                            <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#4ade80', letterSpacing: '1px' }}>
                              ••••••••••••••••••••••••••••••••
                            </div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px' }}>
                              Service Account Configured · Project: <strong style={{ color: '#fff' }}>{vertexParsedSa.projectId}</strong> · Email: <strong style={{ color: '#fff' }}>{vertexParsedSa.clientEmail}</strong>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="settings-btn-action settings-btn-secondary"
                            style={{ padding: '3px 8px', fontSize: '10px' }}
                            onClick={() => setShowVertexSaKey(true)}
                          >
                            Show / Edit Key
                          </button>
                        </div>
                      ) : (
                        <div style={{ marginTop: '8px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label style={{ fontSize: '11px', color: '#94a3b8' }}>
                              Service Account Key JSON (optional · auto-populates Project ID &amp; verifies credentials)
                            </label>
                            {vertexParsedSa?.valid && (
                              <button
                                type="button"
                                className="key-btn-clear"
                                style={{ fontSize: '10px' }}
                                onClick={() => setShowVertexSaKey(false)}
                              >
                                Hide Key
                              </button>
                            )}
                          </div>
                          <textarea
                            className="settings-text-input"
                            rows={3}
                            placeholder='{"type": "service_account", "project_id": "my-gcp-project", "client_email": "service-account@...", "private_key": "..."}'
                            value={vertexServiceAccountJson}
                            onChange={(e) => updateVertexServiceAccountJson(e.target.value)}
                            style={{
                              width: '100%',
                              fontFamily: 'monospace',
                              fontSize: '11px',
                              resize: 'vertical',
                              background: 'rgba(0, 0, 0, 0.25)',
                              border: vertexParsedSa && !vertexParsedSa.valid ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.12)',
                              borderRadius: '6px',
                              padding: '8px',
                            }}
                          />
                        </div>
                      )}
                      <p className="settings-help-text" style={{ marginTop: '6px' }}>
                        Enter your Google Cloud Project ID or paste a Service Account JSON for enterprise Vertex AI routing.
                      </p>
                    </div>

                    {/* OpenAI */}
                    <MaskedKeyInput
                      label="OpenAI API Key"
                      envName="OPENAI_API_KEY"
                      icon={<Sparkles size={14} style={{ color: '#10b981' }} />}
                      isConfigured={Boolean(openaiApiKey && openaiApiKey.trim())}
                      onSave={(val) => updateOpenaiApiKey(val)}
                      onClear={() => updateOpenaiApiKey('')}
                      description="Enables OpenAI GPT and reasoning model completions."
                      testAction={() => void handleTestPing('openai', openaiApiKey, 'gpt-4o-mini')}
                      testDisabled={pingTesting}
                    />

                    {/* Anthropic */}
                    <MaskedKeyInput
                      label="Anthropic Claude API Key"
                      envName="ANTHROPIC_API_KEY"
                      icon={<Brain size={14} style={{ color: '#f97316' }} />}
                      isConfigured={Boolean(anthropicApiKey && anthropicApiKey.trim())}
                      onSave={(val) => updateAnthropicApiKey(val)}
                      onClear={() => updateAnthropicApiKey('')}
                      description="Enables Claude 4.5 Sonnet and Haiku model calls."
                      testAction={() => void handleTestPing('anthropic', anthropicApiKey, 'claude-haiku-4-5-20251001')}
                      testDisabled={pingTesting}
                    />

                    {/* Ollama */}
                    <div className="settings-section-card settings-key-card">
                      <div className="settings-input-header">
                        <label className="settings-label">
                          <Cpu size={14} style={{ color: '#fbbf24' }} />
                          <span>Ollama Host URL</span>
                          <span className="key-badge-configured">
                            <Check size={10} /> Active
                          </span>
                        </label>
                        <button
                          type="button"
                          className="settings-btn-action"
                          style={{ padding: '2px 8px', fontSize: '10px' }}
                          onClick={() => void handleTestPing('ollama', '', 'qwen2.5:7b', customUrl || 'http://localhost:11434')}
                          disabled={pingTesting}
                        >
                          Test ⚡
                        </button>
                      </div>
                      <input
                        type="text"
                        className="settings-text-input"
                        placeholder="http://localhost:11434"
                        value={customUrl}
                        onChange={(e) => updateCustomUrl(e.target.value)}
                      />
                      <p className="settings-help-text">
                        Host endpoint URL for local Ollama models (e.g. http://localhost:11434).
                      </p>
                    </div>

                    {/* Custom API */}
                    <div className="settings-section-card settings-key-card">
                      <label className="settings-label">
                        <Wrench size={14} style={{ color: '#e2e8f0' }} />
                        <span>Custom API (OpenAI-Compatible)</span>
                      </label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <input
                          type="text"
                          className="settings-text-input"
                          placeholder="Endpoint URL (e.g. http://localhost:11434/v1)"
                          value={customUrl}
                          onChange={(e) => updateCustomUrl(e.target.value)}
                        />
                        <input
                          type="password"
                          className="settings-text-input"
                          placeholder="API Key (optional for local endpoints)"
                          value={customApiKey}
                          onChange={(e) => updateCustomApiKey(e.target.value)}
                        />
                        <input
                          type="text"
                          className="settings-text-input"
                          placeholder="Model Identifier (e.g. deepseek-chat, mistral-large)"
                          value={customModel}
                          onChange={(e) => updateCustomModel(e.target.value)}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* TAB 3: MOBILE COMPANION */}
                {settingsTab === 'mobile' && (
                  <div className="settings-section-card" style={{ padding: '16px' }}>
                    <div className="settings-section-title">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Smartphone size={16} style={{ color: '#ff5a36' }} />
                        <span>Clinky Mobile Companion</span>
                      </div>
                      <span className="agent-badge-pill ember">Local Encrypted Link</span>
                    </div>

                    {pairingLoading && !pairingPayload && (
                      <div className="wa-disconnected" style={{ padding: '24px 0' }}>
                        <div className="wa-loader">
                          <Loader2 className="spin" size={18} />
                          <span>Preparing pairing credentials...</span>
                        </div>
                      </div>
                    )}

                    {pairingError && (
                      <div className="wa-error-container">
                        <p className="wa-error-msg">{pairingError}</p>
                        <button
                          type="button"
                          className="settings-btn-action"
                          onClick={() => loadPairingPayload()}
                          disabled={pairingLoading}
                        >
                          Retry Connection
                        </button>
                      </div>
                    )}

                    {pairingPayload && !pairingError && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' }}>
                        <p style={{ margin: 0, fontSize: '12px', color: '#cbd5e1' }}>
                          Scan this QR code from your Clinky Mobile app (Pair tab):
                        </p>

                        {pairingPayload.ips.length > 1 && (
                          <div className="pairing-ip-row" style={{ alignSelf: 'center' }}>
                            <span className="wa-help-text">Host PC IP:</span>
                            <select
                              className="pairing-ip-select"
                              value={pairingIp}
                              onChange={(e) => setPairingIp(e.target.value)}
                            >
                              {pairingPayload.ips.map((ip) => (
                                <option key={ip} value={ip}>{ip}</option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div className="wa-qr-canvas-wrapper" style={{ background: '#fff', padding: '10px', borderRadius: '12px' }}>
                          <canvas ref={mobileCanvasRef} className="wa-qr-canvas" />
                          {pairingLoading && (
                            <div className="wa-qr-overlay">
                              <Loader2 className="spin" size={24} />
                            </div>
                          )}
                        </div>

                        <p className="settings-help-text">
                          Manual address: IP <code style={{ color: '#38bdf8' }}>{pairingIp}</code>, Port <code style={{ color: '#38bdf8' }}>{pairingPayload.ws_port}</code>
                        </p>

                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            className="settings-btn-action settings-btn-secondary"
                            onClick={handleRegenerateToken}
                            disabled={pairingLoading}
                          >
                            {pairingLoading ? <Loader2 className="spin" size={13} /> : 'Regenerate Code'}
                          </button>
                          <button
                            type="button"
                            className="settings-btn-action"
                            onClick={() => {
                              setShowSettings(false);
                              setShowWaModal(true);
                            }}
                          >
                            <MessageSquare size={13} />
                            <span>WhatsApp Bridge ({waStatus})</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 6: KEYBINDINGS & SYSTEM */}
                {settingsTab === 'about' && (
                  <>
                    <div className="settings-section-card">
                      <div className="settings-section-title">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Command size={16} style={{ color: '#ff5a36' }} />
                          <span>Global Summon Shortcut</span>
                        </div>
                        <span className="agent-badge-pill ember">System-Wide</span>
                      </div>
                      <p className="settings-help-text">
                        Press this key combination from any application on Windows to instantly summon Clinky.
                      </p>

                      <div className="settings-shortcut-grid">
                        <button
                          type="button"
                          className={`shortcut-pill-btn ${shortcut === 'Enter' ? 'active' : ''}`}
                          onClick={() => updateShortcut('Enter')}
                        >
                          <span>Ctrl + Shift + Enter</span>
                          {shortcut === 'Enter' && <Check size={14} />}
                        </button>
                        <button
                          type="button"
                          className={`shortcut-pill-btn ${shortcut === 'Space' ? 'active' : ''}`}
                          onClick={() => updateShortcut('Space')}
                        >
                          <span>Ctrl + Win + Space</span>
                          {shortcut === 'Space' && <Check size={14} />}
                        </button>
                      </div>
                    </div>

                    <div className="settings-section-card">
                      <div className="settings-section-title">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Mic size={16} style={{ color: '#4ade80' }} />
                          <span>Push-To-Talk Voice Input</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9' }}>Hold Mic Button / Hotkey</div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>Streams speech directly to Clinky's voice pipeline</div>
                        </div>
                        <span className="agent-badge-pill emerald">Win + Space</span>
                      </div>
                    </div>

                    <div className="settings-section-card">
                      <div className="settings-section-title">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <X size={16} style={{ color: '#cbd5e1' }} />
                          <span>Dismiss &amp; Cancel</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9' }}>Escape Key</div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>Closes modals, dismisses result bubbles, or cancels autopilot</div>
                        </div>
                        <span className="agent-badge-pill" style={{ background: 'rgba(255, 255, 255, 0.1)', color: '#cbd5e1' }}>Esc</span>
                      </div>
                    </div>

                    {/* Application Logs & Diagnostics */}
                    <div className="settings-section-card">
                      <div className="settings-section-title">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <BookOpen size={16} style={{ color: '#38bdf8' }} />
                          <span>Application Logs &amp; Diagnostics</span>
                        </div>
                        <span className="agent-badge-pill" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>Diagnostics</span>
                      </div>
                      <p className="settings-help-text">
                        Inspect live runtime logs, automation execution traces, and actuator diagnostics.
                      </p>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                        <button
                          type="button"
                          className="settings-btn-action"
                          style={{ padding: '6px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                          onClick={() => void handleViewLogs()}
                          disabled={loadingLogs}
                        >
                          {loadingLogs ? <Loader2 className="spin" size={13} /> : <BookOpen size={13} />}
                          <span>{loadingLogs ? 'Loading Logs...' : 'View Application Logs'}</span>
                        </button>
                        <button
                          type="button"
                          className="settings-btn-action settings-btn-secondary"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                          onClick={() => void handleClearLogs()}
                        >
                          🧹 Clear Logs
                        </button>
                        <button
                          type="button"
                          className="settings-btn-action settings-btn-secondary"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                          onClick={() => void handleOpenLogsFolder()}
                        >
                          📂 Open Logs Folder
                        </button>
                      </div>
                    </div>

                    <div className="settings-section-card settings-about-hero">
                      <div className="settings-about-logo">
                        <Bot size={28} />
                      </div>
                      <div>
                        <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', color: '#fff', fontFamily: 'Astonpoliz, Okine Sans, sans-serif' }}>
                          Clinky Desktop
                        </h3>
                        <span className="agent-badge-pill ember">v0.2.0</span>
                      </div>
                      <p style={{ margin: '4px 0 0 0', fontSize: '11.5px', color: '#94a3b8', maxWidth: '380px' }}>
                        The Windows AI Buddy. Unified multi-agent intelligence with local computer-use actuation and streaming voice.
                      </p>

                      <div className="settings-about-grid">
                        <div className="settings-about-stat">
                          <span className="settings-about-stat-label">UI Design System</span>
                          <span className="settings-about-stat-val">Ember &amp; Deep Space</span>
                        </div>
                        <div className="settings-about-stat">
                          <span className="settings-about-stat-label">Actuator Engine</span>
                          <span className="settings-about-stat-val">{provider.toUpperCase()} ({agent1Model})</span>
                        </div>
                        <div className="settings-about-stat">
                          <span className="settings-about-stat-label">Knowledge Engine</span>
                          <span className="settings-about-stat-val">{agent2Provider.toUpperCase()} ({agent2Model})</span>
                        </div>
                        <div className="settings-about-stat">
                          <span className="settings-about-stat-label">Voice Pipeline</span>
                          <span className="settings-about-stat-val">{voiceProvider === 'assemblyai' ? 'AssemblyAI Realtime' : 'Sarvam Multilingual'}</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Application Logs Modal */}
      {showLogsModal && (
        <div
          className="settings-modal-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            zIndex: 12000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setShowLogsModal(false)}
        >
          <div
            className="settings-dialog-card"
            style={{
              width: '840px',
              maxWidth: '92vw',
              height: '580px',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '12px',
              overflow: 'hidden',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                background: 'rgba(255, 255, 255, 0.03)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BookOpen size={16} style={{ color: '#38bdf8' }} />
                <span style={{ fontWeight: 600, fontSize: '14px', color: '#f8fafc' }}>
                  Application Runtime Logs
                </span>
                <span className="agent-badge-pill" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontSize: '10px' }}>
                  blinky.log
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  className="settings-btn-action settings-btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px' }}
                  onClick={() => void handleViewLogs()}
                  disabled={loadingLogs}
                >
                  <RefreshCw size={11} className={loadingLogs ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  className="settings-btn-action settings-btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => void handleClearLogs()}
                >
                  Clear Logs
                </button>
                <button
                  type="button"
                  className="settings-btn-action settings-btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => {
                    void navigator.clipboard.writeText(appLogsContent);
                    setStatus('Logs copied to clipboard.');
                  }}
                >
                  Copy All
                </button>
                <button
                  type="button"
                  className="settings-btn-action settings-btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => void handleOpenLogsFolder()}
                >
                  Open Folder
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogsModal(false)}
                  style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px', display: 'flex' }}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div style={{ flex: 1, padding: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <pre
                style={{
                  flex: 1,
                  margin: 0,
                  padding: '12px',
                  background: 'rgba(0, 0, 0, 0.55)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px',
                  color: '#e2e8f0',
                  fontFamily: 'JetBrains Mono, Consolas, monospace',
                  fontSize: '11px',
                  lineHeight: 1.5,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {appLogsContent || 'No logs available.'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
