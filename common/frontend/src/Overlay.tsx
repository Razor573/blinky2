import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

import { getHighlightSteps } from './lib/guidance';
import type { TutorResult } from './lib/types';
import { getCursorPosition, logDebugMessage, setAgentCursorVisibility } from './lib/tauri';

interface GlobalClick {
  x: number;
  y: number;
  overlay_x: number;
  overlay_y: number;
  scale_factor: number;
}

interface HighlightFrame {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  compact: boolean;
  step: number;
  targetText: string;
  instruction: string;
}

export type ClinkyState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface ClinkyResponse {
  text: string;
  provider?: string;
}

interface PendingAction {
  action_id: string;
  description: string;
  command?: string;
}

export function Overlay() {
  const [result, setResult] = useState<TutorResult | null>(null);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());
  const [offsets, setOffsets] = useState({ x: 0, y: 0 });
  const offsetsRef = useRef({ x: 0, y: 0 });

  const cursorRef = useRef<HTMLDivElement>(null);
  const currentPosRef = useRef<{ x: number; y: number }>({ x: -100, y: -100 });
  const targetPosRef = useRef<{ x: number; y: number }>({ x: -100, y: -100 });
  const activeGlideAnimRef = useRef<Animation | null>(null);

  const [agentCursorVisible, setAgentCursorVisible] = useState(true);
  const [isAgentModeActive, setIsAgentModeActive] = useState(false);
  const isAgentModeActiveRef = useRef(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isClicking, setIsClicking] = useState(false);
  const [clinkyState, setClinkyState] = useState<ClinkyState>('idle');

  // Floating Response Bubble
  const [responseBubble, setResponseBubble] = useState<ClinkyResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBubbleHoveredRef = useRef(false);

  // Action Confirmation Gate
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const isAgentActingRef = useRef(false);
  const actingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isVoiceActiveRef = useRef(false);
  const hideVoiceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framesRef = useRef<HighlightFrame[]>([]);

  const glowContainerRef = useRef<HTMLDivElement>(null);

  const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  const pixelRatio = typeof window !== 'undefined' && isWindows ? window.devicePixelRatio || 1 : 1;

  // Clinky companion cursor offset: +14px X, -16px Y from cursor
  const COMPANION_OFFSET_X = 14;
  const COMPANION_OFFSET_Y = -16;
  const nativeCursorPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Click-through behavior: ignore cursor events by default on overlay
  useEffect(() => {
    try {
      void getCurrentWindow().setIgnoreCursorEvents(true);
    } catch (err) {
      console.warn('Failed to set initial ignoreCursorEvents:', err);
    }
    return () => {
      try {
        void getCurrentWindow().setIgnoreCursorEvents(false);
      } catch {}
    };
  }, []);

  const handleInteractiveMouseEnter = useCallback(() => {
    try {
      void getCurrentWindow().setIgnoreCursorEvents(false);
    } catch {}
  }, []);

  const handleInteractiveMouseLeave = useCallback(() => {
    try {
      void getCurrentWindow().setIgnoreCursorEvents(true);
    } catch {}
  }, []);

  // Response bubble auto-hide timer management (15s default, paused when hovered)
  const startAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
    if (!isBubbleHoveredRef.current) {
      autoHideTimerRef.current = setTimeout(() => {
        setResponseBubble(null);
        handleInteractiveMouseLeave();
      }, 15000);
    }
  }, [handleInteractiveMouseLeave]);

  const pauseAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  const showResponse = useCallback((text: string, provider = 'Gemini 2.0 Flash') => {
    if (!text || !text.trim()) return;
    setResponseBubble({ text: text.trim(), provider });
    startAutoHideTimer();
  }, [startAutoHideTimer]);

  const handleCopyResponse = async () => {
    if (!responseBubble?.text) return;
    try {
      await navigator.clipboard.writeText(responseBubble.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy response text to clipboard:', err);
    }
  };

  const handleDismissResponse = () => {
    pauseAutoHideTimer();
    setResponseBubble(null);
    handleInteractiveMouseLeave();
  };

  const handleAllowAction = async () => {
    if (!pendingAction) return;
    await emit('blinky://confirm-action-response', {
      action_id: pendingAction.action_id,
      allowed: true,
    });
    setPendingAction(null);
    handleInteractiveMouseLeave();
  };

  const handleCancelAction = async () => {
    if (!pendingAction) return;
    await emit('blinky://confirm-action-response', {
      action_id: pendingAction.action_id,
      allowed: false,
    });
    setPendingAction(null);
    handleInteractiveMouseLeave();
  };

  // Smooth requestAnimationFrame lerp loop: direct glide, zero lag/rubber-banding
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (!isAgentActingRef.current && cursorRef.current && targetPosRef.current.x !== -100) {
        const cur = currentPosRef.current;
        const target = targetPosRef.current;
        const dx = target.x - cur.x;
        const dy = target.y - cur.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 0.05) {
          if (cur.x === -100 || dist < 0.8) {
            cur.x = target.x;
            cur.y = target.y;
          } else {
            // Direct responsive glide (0.38 lerp factor)
            cur.x += dx * 0.38;
            cur.y += dy * 0.38;
          }
          cursorRef.current.style.transform = `translate3d(${cur.x}px, ${cur.y}px, 0)`;
        }
      }
      animId = requestAnimationFrame(updateLoop);
    };
    animId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Window offsets initialization and tracking
  const updateOffsets = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const pos = await appWindow.outerPosition();
      const factor = await appWindow.scaleFactor();
      const newOffsets = {
        x: pos.x / factor,
        y: pos.y / factor,
      };
      setOffsets(newOffsets);
      offsetsRef.current = newOffsets;
    } catch (err) {
      console.error('Failed to get window offsets:', err);
    }
  }, []);

  useEffect(() => {
    void updateOffsets();
    window.addEventListener('resize', updateOffsets);
    return () => window.removeEventListener('resize', updateOffsets);
  }, [updateOffsets]);

  // Initialize native cursor position on mount
  useEffect(() => {
    void getCursorPosition().then((pos) => {
      if (pos.x !== 0 || pos.y !== 0) {
        const cssX = (pos.x / pixelRatio) - offsetsRef.current.x;
        const cssY = (pos.y / pixelRatio) - offsetsRef.current.y;
        const companionX = cssX + COMPANION_OFFSET_X;
        const companionY = cssY + COMPANION_OFFSET_Y;
        currentPosRef.current = { x: companionX, y: companionY };
        targetPosRef.current = { x: companionX, y: companionY };
        nativeCursorPos.current = { x: companionX, y: companionY };
        if (cursorRef.current) {
          cursorRef.current.style.transform = `translate3d(${companionX}px, ${companionY}px, 0)`;
        }
      }
    });
  }, [pixelRatio]);

  // Sync native cursor blanking with AI cursor visibility
  useEffect(() => {
    void setAgentCursorVisibility(agentCursorVisible || isAgentModeActive);
  }, [agentCursorVisible, isAgentModeActive]);

  useEffect(() => {
    isVoiceActiveRef.current = isVoiceActive;
    if (isVoiceActive) {
      if (hideVoiceTimeoutRef.current) {
        clearTimeout(hideVoiceTimeoutRef.current);
        hideVoiceTimeoutRef.current = null;
      }
      setAgentCursorVisible(true);
      setClinkyState('listening');
      if (cursorRef.current && !isAgentActingRef.current) {
        cursorRef.current.style.opacity = '1';
      }
    } else {
      if (clinkyState === 'listening') {
        setClinkyState('idle');
      }
      if (hideVoiceTimeoutRef.current) clearTimeout(hideVoiceTimeoutRef.current);
      hideVoiceTimeoutRef.current = setTimeout(() => {
        if (!isAgentActingRef.current && !isAgentModeActiveRef.current) {
          // Keep buddy cursor smoothly visible beside cursor
        }
      }, 500);
    }
  }, [isVoiceActive, clinkyState]);

  useEffect(() => {
    const unlistenVad = listen<{ volume: number }>('blinky://vad-update', (event) => {
      if (glowContainerRef.current) {
        const volume = event.payload.volume;
        glowContainerRef.current.style.setProperty('--vad-opacity', volume > 0 ? (0.2 + volume * 0.8).toString() : '0');
        glowContainerRef.current.style.setProperty('--glow-scale', (1 + volume * 0.2).toString());
        glowContainerRef.current.style.setProperty('--glow-speed', `${4 - volume * 2.5}s`);
      }
    });

    const unlistenVoice = listen<{ active: boolean }>('blinky://voice-active', (event) => {
      setIsVoiceActive(event.payload.active);
    });

    const unlistenAgentMode = listen<{ active: boolean }>('blinky://agent-mode-active', (event) => {
      setIsAgentModeActive(event.payload.active);
      isAgentModeActiveRef.current = event.payload.active;
      if (event.payload.active) {
        setAgentCursorVisible(true);
        if (cursorRef.current) {
          cursorRef.current.style.opacity = '1';
        }
      }
    });

    const unlistenVis = listen<{ visible: boolean }>('blinky://agent-cursor-visibility', (event) => {
      setAgentCursorVisible(event.payload.visible);
      if (event.payload.visible) {
        if (cursorRef.current) {
          cursorRef.current.style.opacity = '1';
        }
      } else {
        isAgentActingRef.current = false;
        if (!isAgentModeActiveRef.current && !isVoiceActiveRef.current && cursorRef.current) {
          // Retain buddy opacity if companion mode is active
        }
      }
    });

    const unlistenNativeMove = listen<{ x: number, y: number }>('blinky://native-cursor-move', (event) => {
      const cssX = (event.payload.x / pixelRatio) - offsetsRef.current.x;
      const cssY = (event.payload.y / pixelRatio) - offsetsRef.current.y;
      
      const companionX = cssX + COMPANION_OFFSET_X;
      const companionY = cssY + COMPANION_OFFSET_Y;

      nativeCursorPos.current = { x: companionX, y: companionY };
      targetPosRef.current = { x: companionX, y: companionY };

      if (cursorRef.current && !isAgentActingRef.current) {
        if (currentPosRef.current.x === -100) {
          currentPosRef.current = { x: companionX, y: companionY };
          cursorRef.current.style.transform = `translate3d(${companionX}px, ${companionY}px, 0)`;
        }
        cursorRef.current.style.opacity = '1';
      }
    });

    const unlistenAgentMove = listen<{ x: number, y: number, instruction?: string }>('blinky://agent-cursor-move', (event) => {
      if (actingTimeoutRef.current) {
        clearTimeout(actingTimeoutRef.current);
        actingTimeoutRef.current = null;
      }
      if (hideVoiceTimeoutRef.current) {
        clearTimeout(hideVoiceTimeoutRef.current);
        hideVoiceTimeoutRef.current = null;
      }
      if (activeGlideAnimRef.current) {
        activeGlideAnimRef.current.cancel();
        activeGlideAnimRef.current = null;
      }

      isAgentActingRef.current = true;

      const startCssX = currentPosRef.current.x;
      const startCssY = currentPosRef.current.y;
      let targetCssX = (event.payload.x / pixelRatio) - offsetsRef.current.x;
      let targetCssY = (event.payload.y / pixelRatio) - offsetsRef.current.y;

      const hasExplicitCoords =
        typeof event.payload.x === 'number' &&
        !isNaN(event.payload.x) &&
        typeof event.payload.y === 'number' &&
        !isNaN(event.payload.y);

      if (!hasExplicitCoords && framesRef.current && framesRef.current.length > 0) {
        const frame = framesRef.current[0];
        targetCssX = frame.left + frame.width / 2;
        targetCssY = frame.top + frame.height / 2;
      }

      const el = cursorRef.current;
      if (el) {
        el.style.transform = `translate3d(${startCssX}px, ${startCssY}px, 0)`;
        el.style.opacity = '1';
        setAgentCursorVisible(true);

        const anim = el.animate(
          [
            { transform: `translate3d(${startCssX}px, ${startCssY}px, 0)` },
            { transform: `translate3d(${targetCssX}px, ${targetCssY}px, 0)` }
          ],
          {
            duration: 220,
            easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)',
            fill: 'forwards'
          }
        );
        activeGlideAnimRef.current = anim;

        anim.onfinish = () => {
          el.style.transform = `translate3d(${targetCssX}px, ${targetCssY}px, 0)`;
          currentPosRef.current = { x: targetCssX, y: targetCssY };
          try {
            anim.cancel();
          } catch {}
          activeGlideAnimRef.current = null;

          // Trigger click ripple ring
          setIsClicking(true);
          setTimeout(() => setIsClicking(false), 350);
        };
      }

      actingTimeoutRef.current = setTimeout(() => {
        isAgentActingRef.current = false;
      }, 20000);
    });

    const unlistenAgentDone = listen('blinky://agent-cursor-done', () => {
      if (actingTimeoutRef.current) {
        clearTimeout(actingTimeoutRef.current);
        actingTimeoutRef.current = null;
      }
      if (activeGlideAnimRef.current) {
        try {
          activeGlideAnimRef.current.cancel();
        } catch {}
        activeGlideAnimRef.current = null;
      }
      setIsClicking(false);

      const el = cursorRef.current;
      if (el) {
        const startX = currentPosRef.current.x;
        const startY = currentPosRef.current.y;
        const returnX = nativeCursorPos.current.x || startX;
        const returnY = nativeCursorPos.current.y || startY;
        const dist = Math.hypot(returnX - startX, returnY - startY);

        if (dist > 10) {
          const returnAnim = el.animate(
            [
              { transform: `translate3d(${startX}px, ${startY}px, 0)` },
              { transform: `translate3d(${returnX}px, ${returnY}px, 0)` },
            ],
            {
              duration: 500,
              easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)',
              fill: 'forwards',
            }
          );
          activeGlideAnimRef.current = returnAnim;

          returnAnim.onfinish = () => {
            el.style.transform = `translate3d(${returnX}px, ${returnY}px, 0)`;
            currentPosRef.current = { x: returnX, y: returnY };
            targetPosRef.current = { x: returnX, y: returnY };
            try {
              returnAnim.cancel();
            } catch {}
            activeGlideAnimRef.current = null;
            isAgentActingRef.current = false;
          };
        } else {
          el.style.transform = `translate3d(${returnX}px, ${returnY}px, 0)`;
          currentPosRef.current = { x: returnX, y: returnY };
          targetPosRef.current = { x: returnX, y: returnY };
          isAgentActingRef.current = false;
        }
        el.style.opacity = '1';
      } else {
        isAgentActingRef.current = false;
      }
    });

    // Clinky State Indicator Listener
    const unlistenClinkyState = listen<{ state: ClinkyState }>('blinky://clinky-state', (event) => {
      if (event.payload?.state) {
        setClinkyState(event.payload.state);
      }
    });

    // Floating Response Bubble Listener
    const unlistenClinkyResponse = listen<{ text: string; provider?: string }>('blinky://clinky-response', (event) => {
      if (event.payload?.text) {
        showResponse(event.payload.text, event.payload.provider || 'Gemini 2.0 Flash');
      }
    });

    // Action Confirmation Gate Listener
    const unlistenConfirmAction = listen<PendingAction>('blinky://confirm-action', (event) => {
      setPendingAction(event.payload);
      setAgentCursorVisible(true);
      if (cursorRef.current) {
        cursorRef.current.style.opacity = '1';
      }
    });

    // Tutor Status Listener for state synchronization
    const unlistenTutorStatus = listen<{ phase: string; message: string }>('blinky://tutor-status', (event) => {
      const p = (event.payload?.phase || '').toLowerCase();
      const m = (event.payload?.message || '').toLowerCase();
      if (p === 'thinking' || m.includes('thinking')) {
        setClinkyState('thinking');
      } else if (p === 'error' || m.includes('error') || m.includes('failed')) {
        setClinkyState('error');
      } else if (p === 'done' || p === 'idle' || p === 'success') {
        setClinkyState('idle');
      }
    });

    return () => {
      if (actingTimeoutRef.current) {
        clearTimeout(actingTimeoutRef.current);
      }
      if (hideVoiceTimeoutRef.current) {
        clearTimeout(hideVoiceTimeoutRef.current);
      }
      unlistenVad.then((dispose) => dispose());
      unlistenVoice.then((dispose) => dispose());
      unlistenAgentMode.then((dispose) => dispose());
      unlistenVis.then((dispose) => dispose());
      unlistenNativeMove.then((dispose) => dispose());
      unlistenAgentMove.then((dispose) => dispose());
      unlistenAgentDone.then((dispose) => dispose());
      unlistenClinkyState.then((dispose) => dispose());
      unlistenClinkyResponse.then((dispose) => dispose());
      unlistenConfirmAction.then((dispose) => dispose());
      unlistenTutorStatus.then((dispose) => dispose());
    };
  }, [pixelRatio, showResponse]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unlisten = listen<TutorResult>('blinky://guidance', (event) => {
      setResult(event.payload);
      setDismissedKeys(new Set());
      setClinkyState('idle');

      if (event.payload?.summary) {
        showResponse(event.payload.summary, 'Gemini 2.0 Flash');
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!navigator.userAgent.includes('Windows')) {
        timeoutId = setTimeout(() => {
          setResult(null);
        }, 8000);
      }
    });

    return () => {
      unlisten.then((dispose) => dispose());
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [showResponse]);

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const screenshotWidth = result?.screenshot?.width || viewportWidth * pixelRatio;
  const screenshotHeight = result?.screenshot?.height || viewportHeight * pixelRatio;

  const physicalScaleX = (viewportWidth * pixelRatio) / screenshotWidth;
  const physicalScaleY = (viewportHeight * pixelRatio) / screenshotHeight;
  const scaleX = physicalScaleX / pixelRatio;
  const scaleY = physicalScaleY / pixelRatio;

  useEffect(() => {
    if (!result) return;
    void logDebugMessage(JSON.stringify({
      type: 'overlay_render',
      viewportWidth,
      viewportHeight,
      devicePixelRatio: window.devicePixelRatio,
      pixelRatio,
      screenshotWidth,
      screenshotHeight,
      scaleX,
      scaleY,
      offsets,
      steps: result?.steps,
    }, null, 2));
  }, [result, scaleX, scaleY, viewportWidth, viewportHeight, offsets]);

  const frames = useMemo<HighlightFrame[]>(() => {
    return (
      getHighlightSteps(result?.steps || [])
        .map((step) => {
          const match = step.match;
          if (!match) return null;

          const key = `${step.step}-${step.target_text}-${match.x}-${match.y}`;

          const scaledW = match.width * scaleX;
          const scaledH = match.height * scaleY;
          
          const textStr = match.text ? String(match.text).trim() : '';
          const controlType = String(match.control_type || '').toLowerCase();
          const isIcon = 
            match.control_type === 'Image' ||
            (scaledW <= 40 && scaledH <= 40) ||
            (scaledW <= 48 && scaledH <= 48 && textStr.length <= 1);
          const isWindowsSidebarIcon =
            isWindows &&
            ['button', 'image', 'tabitem', 'menuitem', 'custom'].includes(controlType) &&
            match.x * scaleX <= 8 &&
            scaledW >= 24 &&
            scaledW <= 70 &&
            scaledH >= 24 &&
            scaledH <= 80;
          const useIconFrame = isIcon || isWindowsSidebarIcon;

          const paddingX = useIconFrame ? 4 : 20; 
          const paddingY = useIconFrame ? 4 : 8;  

          const rawLeft = Math.round(match.x * scaleX) - Math.round(paddingX / 2) - offsets.x;
          let rawTop = Math.round(match.y * scaleY) - Math.round(paddingY / 2) - offsets.y;

          const rawWidth = Math.max(8, Math.round(match.width * scaleX)) + paddingX;
          const rawHeight = Math.max(8, Math.round(match.height * scaleY)) + paddingY;

          const matchSource = String(match.source || '').toLowerCase();
          const isDesktopIcon =
            (match as unknown as Record<string, unknown>).shell_region === 'desktop' ||
            matchSource === 'icon';
          const MAX_BOX_WIDTH = isDesktopIcon ? 130 : (useIconFrame ? 100 : 140);
          const MAX_BOX_HEIGHT = isDesktopIcon ? 170 : (useIconFrame ? 40 : 44);

          const MIN_BOX_SIZE = 36;
          let displayHeight = Math.min(Math.max(MIN_BOX_SIZE, rawHeight), MAX_BOX_HEIGHT);

          const isInput =
            match.control_type === 'Edit' ||
            match.control_type === 'TextBox' ||
            match.control_type === 'ComboBox';

          let displayWidth = Math.min(Math.max(MIN_BOX_SIZE, rawWidth), MAX_BOX_WIDTH);
          let displayLeft = rawLeft;

          if (isWindowsSidebarIcon) {
            const iconBoxSize = 30;
            const iconCenterX = rawLeft + Math.min(rawWidth / 2, 24);
            const iconCenterY = rawTop + rawHeight / 2;
            displayWidth = iconBoxSize;
            displayHeight = iconBoxSize;
            displayLeft = Math.round(iconCenterX - iconBoxSize / 2);
            rawTop = Math.round(iconCenterY - iconBoxSize / 2 - (rawHeight - displayHeight) / 2);
          } else if (isInput) {
            displayWidth = rawWidth;
            displayLeft = rawLeft;
          } else if (!useIconFrame && !isDesktopIcon && rawWidth > 140) {
            const textLength = match.text ? String(match.text).length : 8;
            const estimatedWidth = 24 + textLength * 7.2 + 28;
            
            displayWidth = Math.min(rawWidth, Math.max(55, Math.round(estimatedWidth)));
            displayLeft = rawLeft + 20;
          } else {
            displayLeft = rawLeft + Math.round((rawWidth - displayWidth) / 2);
          }
          const displayTop = rawTop + Math.round((rawHeight - displayHeight) / 2);
          const clamped = clampFrame(
            displayLeft,
            displayTop,
            displayWidth,
            displayHeight,
            viewportWidth,
            viewportHeight,
          );

          void logDebugMessage(JSON.stringify({
            type: 'frame_math',
            target: step.target_text,
            matchX: match.x,
            matchY: match.y,
            scaleX,
            scaleY,
            offsets,
            rawLeft,
            rawTop,
            displayLeft,
            displayTop,
            clamped,
          }));

          return {
            key,
            left: clamped.left,
            top: clamped.top,
            width: clamped.width,
            height: clamped.height,
            compact: isWindowsSidebarIcon,
            step: step.step,
            targetText: step.target_text,
            instruction: step.instruction,
          };
        })
        .filter((frame): frame is HighlightFrame => Boolean(frame)) || []
    );
  }, [result, scaleX, scaleY, viewportWidth, viewportHeight, offsets, isWindows]);

  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  useEffect(() => {
    const unlisten = listen<GlobalClick>('blinky://global-click', (event) => {
      setIsClicking(true);
      setTimeout(() => setIsClicking(false), 300);

      const clickedFrame = frames.find((frame) => containsClick(frame, event.payload, scaleX, scaleY));
      if (!clickedFrame) return;

      void emit('blinky://agent-cursor-done', {});

      setDismissedKeys((current) => {
        const next = new Set(current);
        next.add(clickedFrame.key);
        return next;
      });
      void emit('blinky://target-clicked', {
        key: clickedFrame.key,
        step: clickedFrame.step,
        target_text: clickedFrame.targetText,
        instruction: clickedFrame.instruction,
      });
    });

    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, [frames, scaleX, scaleY]);

  return (
    <main className="overlay-root">
      <div className="fullscreen-edge-lighting-container" ref={glowContainerRef}>
        <div className="fullscreen-edge-lighting-gradient" />
      </div>

      <div 
        ref={cursorRef}
        className="clinky-buddy-wrapper"
        style={{
          opacity: agentCursorVisible ? 1 : 0,
          transform: `translate3d(${currentPosRef.current.x}px, ${currentPosRef.current.y}px, 0)`,
        }}
      >
        {isClicking && <div className="agent-cursor-click-ring" />}
        
        <div className="clinky-buddy-anchor">
          {clinkyState === 'thinking' && <div className="clinky-state-thinking" />}
          <svg 
            className={`clinky-buddy-triangle ${clinkyState === 'idle' ? 'clinky-buddy-breathe' : ''} ${clinkyState === 'speaking' ? 'clinky-buddy-speaking' : ''} ${clinkyState === 'error' ? 'clinky-state-error' : ''}`}
            viewBox="0 0 22 20" 
            width="22" 
            height="20" 
            xmlns="http://www.w3.org/2000/svg"
          >
            <polygon points="11,1 21,19 1,19" fill={clinkyState === 'error' ? '#ff6b6b' : '#8EC5FF'} />
          </svg>
          {clinkyState === 'listening' && (
            <div className="clinky-state-listening">
              <span className="clinky-eq-bar" />
              <span className="clinky-eq-bar" />
              <span className="clinky-eq-bar" />
            </div>
          )}
        </div>

        {/* Floating Response Bubble */}
        {responseBubble && !pendingAction && (
          <div
            className="clinky-response-bubble"
            onMouseEnter={() => {
              isBubbleHoveredRef.current = true;
              pauseAutoHideTimer();
              handleInteractiveMouseEnter();
            }}
            onMouseLeave={() => {
              isBubbleHoveredRef.current = false;
              startAutoHideTimer();
              handleInteractiveMouseLeave();
            }}
          >
            <div className="bubble-header">
              <span className="bubble-badge">{responseBubble.provider || 'Gemini 2.0 Flash'}</span>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="bubble-copy-btn"
                  onClick={handleCopyResponse}
                  title={copied ? 'Copied!' : 'Copy response'}
                >
                  {copied ? <Check size={12} color="#4ade80" /> : <Copy size={12} />}
                </button>
                <button
                  type="button"
                  className="bubble-dismiss-btn"
                  onClick={handleDismissResponse}
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="bubble-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {responseBubble.text}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* Action Confirmation Gate */}
        {pendingAction && (
          <div
            className="clinky-confirmation-card"
            onMouseEnter={handleInteractiveMouseEnter}
            onMouseLeave={handleInteractiveMouseLeave}
          >
            <div className="confirmation-card-header">
              <span className="confirmation-title">Action Confirmation</span>
            </div>
            <div className="confirmation-card-body">
              <p className="confirmation-description">
                {pendingAction.description || 'Clinky is about to run:'}
              </p>
              {pendingAction.command && (
                <code className="confirmation-command">{pendingAction.command}</code>
              )}
            </div>
            <div className="confirmation-card-actions">
              <button
                type="button"
                className="confirmation-btn-allow"
                onClick={handleAllowAction}
              >
                Allow
              </button>
              <button
                type="button"
                className="confirmation-btn-cancel"
                onClick={handleCancelAction}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {frames.map((frame) => {
        if (dismissedKeys.has(frame.key)) return null;
        return (
          <div
            className={`target-frame ${frame.compact ? 'target-frame-compact' : ''}`}
            key={frame.key}
            style={{
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
            }}
          >
            <div className="target-pulse" />
          </div>
        );
      })}
    </main>
  );
}

function clampFrame(left: number, top: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const frameMargin = 0;
  const pulseInset = 6;
  const clampedWidth = Math.min(width, Math.max(8, viewportWidth - pulseInset * 2));
  const clampedHeight = Math.min(height, Math.max(8, viewportHeight - pulseInset * 2));
  const maxLeft = Math.max(frameMargin, viewportWidth - clampedWidth - pulseInset);
  const maxTop = Math.max(frameMargin, viewportHeight - clampedHeight - pulseInset);

  return {
    left: Math.min(Math.max(frameMargin, left), maxLeft),
    top: Math.min(Math.max(frameMargin, top), maxTop),
    width: clampedWidth,
    height: clampedHeight,
  };
}

function containsClick(frame: HighlightFrame, click: GlobalClick, scaleX: number, scaleY: number) {
  const clickTolerance = 10;
  const scaleFactor = click.scale_factor || window.devicePixelRatio || 1;
  const localX = (click.x - click.overlay_x) / scaleFactor;
  const localY = (click.y - click.overlay_y) / scaleFactor;
  const candidates = [
    {
      x: localX,
      y: localY,
    },
    {
      x: localX * scaleX,
      y: localY * scaleY,
    },
  ];

  return candidates.some(
    ({ x, y }) =>
      x >= frame.left - clickTolerance &&
      x <= frame.left + frame.width + clickTolerance &&
      y >= frame.top - clickTolerance &&
      y <= frame.top + frame.height + clickTolerance,
  );
}
