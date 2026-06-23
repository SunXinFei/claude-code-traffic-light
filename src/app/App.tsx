import { useState, useEffect, useRef, useCallback } from "react";

type Light = "red" | "yellow" | "green";
type Theme = "dark" | "light";
type Style = "triple" | "single";

declare global {
  interface Window {
    electronAPI: {
      onStateChange: (cb: (state: string, project: string) => void) => () => void;
      onThemeChange: (cb: (theme: string) => void) => () => void;
      onStyleChange: (cb: (style: string) => void) => () => void;
      onProjectChange: (cb: (project: string) => void) => () => void;
      setState: (state: string) => void;
      quit: () => void;
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => void;
      getStyle: () => Promise<string>;
      setStyle: (style: string) => void;
      focusApp: () => void;
      activateHost: () => void;
      getMute: () => Promise<boolean>;
      setMute: (muted: boolean) => void;
      setWindowHeight: (h: number) => void;
      getProjects: () => Promise<string[]>;
      getSelectedProject: () => Promise<string>;
      selectProject: (name: string) => void;
      getBalance: () => Promise<any>;
      refreshBalance: () => void;
      onBalanceUpdate: (cb: (balance: any) => void) => () => void;
      openSettings: () => void;
      getBudget: (provider: string) => Promise<number | null>;
      setBudget: (provider: string, amount: number) => void;
      getSelectedProvider: () => Promise<string | null>;
      selectProvider: (p: string) => void;
    };
  }
}

const LIGHT_CONFIG = {
  red:    { active: "#FF3B30", dimDark: "#2a1110", dimLight: "#fde8e7", glow: "rgba(255,59,48,0.55)",  innerGlow: "rgba(255,100,80,0.3)"  },
  yellow: { active: "#FF9F0A", dimDark: "#271d08", dimLight: "#fef3dc", glow: "rgba(255,159,10,0.55)", innerGlow: "rgba(255,180,60,0.3)"  },
  green:  { active: "#30D158", dimDark: "#0b2818", dimLight: "#d8f5e4", glow: "rgba(48,209,88,0.55)",  innerGlow: "rgba(80,220,110,0.3)"  },
};

const ORDER: Light[] = ["red", "yellow", "green"];

export default function App() {
  const [active, setActive]           = useState<Light>("yellow");
  const [theme, setThemeState]        = useState<Theme>("dark");
  const [style, setStyleState]        = useState<Style>("triple");
  const [greenSteady, setGreenSteady] = useState(false);
  const [muted, setMuted]             = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentProject, setCurrentProject] = useState("");
  const [balance, setBalance] = useState<any>(null);
  const greenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);

  useEffect(() => {
    window.electronAPI.getTheme().then((t) => {
      if (t === "light" || t === "dark") setThemeState(t as Theme);
    });
    window.electronAPI.getMute().then((m) => setMuted(m));
    window.electronAPI.getStyle().then((s) => {
      if (s === "single" || s === "triple") setStyleState(s as Style);
    });
    window.electronAPI.getSelectedProject().then((p) => setCurrentProject(p));
    window.electronAPI.getBalance().then((b) => { if (b) setBalance(b); });
  }, []);

  useEffect(() => {
    return window.electronAPI.onThemeChange((t) => {
      if (t === "light" || t === "dark") setThemeState(t as Theme);
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.onStyleChange((s) => {
      if (s === "single" || s === "triple") setStyleState(s as Style);
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.onProjectChange((p) => {
      setCurrentProject(p);
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.onBalanceUpdate((b) => {
      setBalance(b);
      if (b && b._budget) setBudgetState(b._budget);
    });
  }, []);

  const playSound = useCallback((light: Light) => {
    if (muted) return;
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (light === "red") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(320, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
      } else if (light === "yellow") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(480, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
      } else {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);

        osc.type = "sine";
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);

        osc2.type = "sine";
        osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
        gain2.gain.setValueAtTime(0.0, ctx.currentTime);
        gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.1);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
        osc2.start(ctx.currentTime + 0.1);
        osc2.stop(ctx.currentTime + 0.28);
      }
    } catch {}
  }, [muted]);

  const applyState = useCallback((state: string) => {
    const s = state as Light;
    if (!ORDER.includes(s)) return;
    if (greenTimerRef.current) { clearTimeout(greenTimerRef.current); greenTimerRef.current = null; }
    setGreenSteady(false);
    setActive(s);
    playSound(s);
    if (s === "green") {
      greenTimerRef.current = setTimeout(() => setGreenSteady(true), 2500);
    }
  }, [playSound]);

  useEffect(() => {
    const cleanup = window.electronAPI.onStateChange((state) => {
      applyState(state);
    });
    return () => {
      cleanup();
      if (greenTimerRef.current) clearTimeout(greenTimerRef.current);
    };
  }, [applyState]);

  const dark = theme === "dark";

  const formatBalanceShort = () => {
    if (!balance) return null;
    if (balance.error) return null;
    const provider = balance._provider || balance.provider;
    if (provider === 'volcengine') {
      const sess = balance.quotas?.find((q: any) => q.level === 'session');
      if (!sess) return null;
      return `${Math.round(sess.percent)}%`;
    }
    if (!balance.balance_infos?.length) return null;
    const total = balance.balance_infos.reduce((sum: number, info: any) => {
      return sum + (parseFloat(info.total_balance) || 0);
    }, 0);
    const currency = balance.balance_infos[0]?.currency || 'CNY';
    const symbol = currency === 'USD' ? '$' : '¥';
    return `${symbol}${total.toFixed(2)}`;
  };

  const volcQuotaStr = () => {
    if (!balance || balance.error) return null;
    const provider = balance._provider || balance.provider;
    if (provider !== 'volcengine') return null;
    const q = balance.quotas || [];
    const get = (lvl: string) => {
      const it = q.find((x: any) => x.level === lvl);
      return it ? `${Math.round(it.percent)}%` : '—';
    };
    return `${get('session')} / ${get('weekly')} / ${get('monthly')}`;
  };

  const [budget, setBudgetState] = useState<number | null>(null);
  useEffect(() => {
    window.electronAPI.getBudget('deepseek').then((b: number | null) => setBudgetState(b));
  }, []);

  const ringPercent = (() => {
    if (!balance || balance.error) return 0;
    const provider = balance._provider || balance.provider;
    if (provider === 'volcengine') {
      const mo = balance.quotas?.find((q: any) => q.level === 'monthly');
      if (!mo) return 0;
      return Math.max(0, Math.min(1, 1 - (mo.percent || 0) / 100));
    }
    if (!balance.balance_infos?.length) return 0;
    const total = balance.balance_infos.reduce((s: number, i: any) => s + (parseFloat(i.total_balance) || 0), 0);
    const fallback = balance.balance_infos.reduce((s: number, i: any) => s + (parseFloat(i.topped_up_balance) || 0), 0);
    const denom = budget || fallback;
    if (!denom) return 0;
    return Math.min(1, total / denom);
  })();
  const ringDeg = ringPercent * 360;
  const ringColor = ringPercent > 0.5 ? '#30D158' : ringPercent > 0.2 ? '#FF9F0A' : '#FF453A';

  useEffect(() => {
    const hasBalance = formatBalanceShort() !== null;
    const balanceH = hasBalance ? 20 : 0;
    const base = (style === "single" ? 110 : 220) + balanceH;
    const withSettings = style === "single" ? 200 : 310;
    window.electronAPI.setWindowHeight(showSettings ? withSettings : base);
  }, [showSettings, style, balance]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    window.electronAPI.setMute(next);
  };

  const housing = dark
    ? {
        background: "linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 40%, #232325 100%)",
        boxShadow: "0 2px 0px rgba(255,255,255,0.06) inset, 0 -1px 0px rgba(0,0,0,0.5) inset",
        border: "1px solid rgba(255,255,255,0.07)",
      }
    : {
        background: "linear-gradient(180deg, #ffffff 0%, #f5f5f7 100%)",
        boxShadow: "0 1px 0px rgba(255,255,255,0.9) inset, 0 -1px 0px rgba(0,0,0,0.06) inset",
        border: "1px solid rgba(0,0,0,0.08)",
      };

  return (
    <div
      className="size-full flex flex-col items-center justify-start pt-3"
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        background: "transparent",
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      <style>{`
        @keyframes breathe-red {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.2; transform: scale(0.93); }
        }
        @keyframes ring-pulse {
          0% { box-shadow: 0 0 0 0px var(--ring-color); opacity: 1; }
          100% { box-shadow: 0 0 0 20px transparent; opacity: 0; }
        }
        .light-breathe-red { animation: breathe-red 2s ease-in-out infinite; }
        .light-active { animation: pulse-glow 0.55s ease-in-out infinite; }
        .ring-pulse-yellow { --ring-color: rgba(255,159,10,0.6); animation: ring-pulse 0.55s ease-out infinite; }
        .ring-pulse-green  { --ring-color: rgba(48,209,88,0.6);  animation: ring-pulse 0.55s ease-out infinite; }
        .no-drag { -webkit-app-region: no-drag; }
      `}</style>

      <div className="relative inline-flex">
        {/* Ring background track — dark version of gradient */}
        <div style={{
          position: "absolute", inset: -4, borderRadius: 28,
          background: dark
            ? "conic-gradient(from 0deg, rgba(255,59,48,0.25), rgba(255,149,0,0.25), rgba(255,204,0,0.25), rgba(52,199,89,0.25), rgba(48,209,88,0.25))"
            : "conic-gradient(from 0deg, rgba(255,59,48,0.18), rgba(255,149,0,0.18), rgba(255,204,0,0.18), rgba(52,199,89,0.18), rgba(48,209,88,0.18))",
          pointerEvents: "none",
        }} />
        {/* Ring progress — full gradient, masked to percentage */}
        {ringPercent > 0 && (
          <div style={{
            position: "absolute", inset: -4, borderRadius: 28,
            background: "conic-gradient(from 0deg, rgba(255,59,48,0.8), rgba(255,149,0,0.8), rgba(255,204,0,0.8), rgba(52,199,89,0.8), rgba(48,209,88,0.8))",
            WebkitMaskImage: `conic-gradient(from 0deg, black 0deg, black ${ringDeg}deg, transparent ${ringDeg}deg, transparent 360deg)`,
            maskImage: `conic-gradient(from 0deg, black 0deg, black ${ringDeg}deg, transparent ${ringDeg}deg, transparent 360deg)`,
            pointerEvents: "none",
          }} />
        )}
        {/* Donut hole cover — matches housing bg to create ring effect */}
        <div style={{
          position: "absolute", inset: -1, borderRadius: 26,
          background: dark ? "#2c2c2e" : "#f5f5f7",
          pointerEvents: "none",
        }} />

        <div
          className="relative flex flex-col items-center"
          style={{ ...housing, borderRadius: 24, width: 80, padding: style === "single" ? "16px 0 16px" : "16px 0 20px", WebkitAppRegion: "drag" } as React.CSSProperties}
        >
        {style === "single" ? (
          <div className="flex flex-col items-center">
            {(() => {
              const cfg = LIGHT_CONFIG[active];
              const isBlinking = active === "yellow" || (active === "green" && !greenSteady);
              const isBreathing = active === "red";
              const dim = dark ? cfg.dimDark : cfg.dimLight;
              return (
                <div className="relative flex items-center justify-center no-drag" onDoubleClick={() => window.electronAPI.activateHost()} style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                  {isBlinking && (
                    <div
                      className={`ring-pulse-${active}`}
                      style={{ position: "absolute", width: 44, height: 44, borderRadius: "50%", pointerEvents: "none" }}
                    />
                  )}
                  <div
                    style={{
                      width: 44, height: 44, borderRadius: "50%",
                      background: dim,
                      boxShadow: dark
                        ? `inset 0 2px 8px rgba(0,0,0,0.6), 0 0 20px ${cfg.glow}, 0 0 40px ${cfg.glow}`
                        : `inset 0 2px 8px rgba(0,0,0,0.08), 0 0 10px ${cfg.glow}`,
                      border: `1px solid ${cfg.active}30`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", transition: "all 0.3s ease",
                    }}
                    onClick={() => window.electronAPI.activateHost()}
                  >
                    <div
                      className={isBreathing ? "light-breathe-red" : isBlinking ? "light-active" : ""}
                      style={{
                        width: 34, height: 34, borderRadius: "50%",
                        background: `radial-gradient(circle at 38% 36%, ${cfg.active}ff 0%, ${cfg.active}dd 40%, ${cfg.active}88 100%)`,
                        boxShadow: dark
                          ? `0 0 12px ${cfg.glow}, 0 0 4px ${cfg.innerGlow}, inset 0 1px 2px rgba(255,255,255,0.25)`
                          : `0 0 6px ${cfg.glow}, inset 0 1px 2px rgba(255,255,255,0.4)`,
                        transition: "all 0.4s ease",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {active !== "red" ? (
                        <div style={{ width: 16, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.35)", marginTop: 10, filter: "blur(2px)" }} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
          {ORDER.map((light) => {
            const cfg = LIGHT_CONFIG[light];
            const isActive = active === light;
            const dim = dark ? cfg.dimDark : cfg.dimLight;
            const isBlinking = isActive && (light === "yellow" || (light === "green" && !greenSteady));
            const isBreathing = isActive && light === "red";

            return (
              <div key={light} className="relative flex items-center justify-center no-drag" onDoubleClick={() => window.electronAPI.activateHost()} style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                {isBlinking && (
                  <div
                    className={`ring-pulse-${light}`}
                    style={{ position: "absolute", width: 44, height: 44, borderRadius: "50%", pointerEvents: "none" }}
                  />
                )}
                <div
                  style={{
                    width: 44, height: 44, borderRadius: "50%",
                    background: isActive ? dim : dark ? "#1a1a1b" : "#ebebed",
                    boxShadow: isActive
                      ? dark
                        ? `inset 0 2px 8px rgba(0,0,0,0.6), 0 0 20px ${cfg.glow}, 0 0 40px ${cfg.glow}`
                        : `inset 0 2px 8px rgba(0,0,0,0.08), 0 0 10px ${cfg.glow}`
                      : `inset 0 2px 8px ${dark ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.1)"}`,
                    border: `1px solid ${isActive ? cfg.active + "30" : dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", transition: "all 0.3s ease",
                  }}
                  onClick={() => window.electronAPI.activateHost()}
                >
                  <div
                    className={isBreathing ? "light-breathe-red" : isBlinking ? "light-active" : ""}
                    style={{
                      width: 34, height: 34, borderRadius: "50%",
                      background: isActive
                        ? `radial-gradient(circle at 38% 36%, ${cfg.active}ff 0%, ${cfg.active}dd 40%, ${cfg.active}88 100%)`
                        : `radial-gradient(circle at 38% 36%, ${dim}cc 0%, ${dim}88 100%)`,
                      boxShadow: isActive
                        ? dark
                          ? `0 0 12px ${cfg.glow}, 0 0 4px ${cfg.innerGlow}, inset 0 1px 2px rgba(255,255,255,0.25)`
                          : `0 0 6px ${cfg.glow}, inset 0 1px 2px rgba(255,255,255,0.4)`
                        : `inset 0 1px 3px ${dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.12)"}`,
                      transition: "all 0.4s ease",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {isActive && light !== "red" ? (
                      <div style={{ width: 16, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.35)", marginTop: 10, filter: "blur(2px)" }} />
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        )}

        {balance && (
          <button
            className="no-drag"
            onClick={() => window.electronAPI.refreshBalance()}
            style={{
              position: "absolute", bottom: 6, left: 6,
              width: 20, height: 20, borderRadius: "50%", border: "none",
              background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
              color: dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)",
              fontSize: 10, cursor: "pointer", display: "flex",
              alignItems: "center", justifyContent: "center",
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
            title="刷新余额"
          >↻</button>
        )}

        <button
          className="no-drag"
          onClick={() => setShowSettings(next => !next)}
          style={{
            position: "absolute", bottom: 6, right: 6,
            width: 20, height: 20, borderRadius: "50%", border: "none",
            background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
            color: dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)",
            fontSize: 11, cursor: "pointer", display: "flex",
            alignItems: "center", justifyContent: "center",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
          title="设置"
        >⚙</button>
        </div>
      </div>

      {formatBalanceShort() !== null && !showSettings && (
        <div
          className="no-drag"
          style={{
            marginTop: 4,
            fontSize: 9,
            color: dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)",
            textAlign: "center",
            WebkitAppRegion: "no-drag",
            cursor: "pointer",
          }}
          onClick={() => window.electronAPI.openSettings()}
          title={(() => {
            const provider = balance?._provider || balance?.provider;
            if (provider === 'volcengine') {
              return `Ark 用量 ${volcQuotaStr()} (sess/wk/mo) | 剩余 ${Math.round(ringPercent * 100)}%`;
            }
            return `余额 ${formatBalanceShort()} / 预算 ¥${budget || '—'} | ${Math.round(ringPercent * 100)}%`;
          })()}
        >
          <div>{(() => {
            const provider = balance?._provider || balance?.provider;
            if (provider === 'volcengine') return `Ark ${volcQuotaStr()}`;
            return `DS ${formatBalanceShort()}${budget ? ` / ¥${budget}` : ''}`;
          })()}</div>
          <div style={{ fontSize: 7, color: `${ringColor}cc`, marginTop: 1 }}>
            {Math.round(ringPercent * 100)}%
          </div>
        </div>
      )}

      {showSettings && (
        <div
          className="no-drag"
          style={{
            marginTop: 8, borderRadius: 14, padding: "10px 14px",
            background: dark ? "rgba(44,44,46,0.96)" : "rgba(255,255,255,0.96)",
            border: dark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.08)",
            width: 80, display: "flex", flexDirection: "column", gap: 8,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <span style={{ fontSize: 11, color: dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)" }}>
              {muted ? "🔇" : "🔔"}
            </span>
            <div
              onClick={toggleMute}
              style={{
                width: 32, height: 18, borderRadius: 9,
                background: muted
                  ? (dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)")
                  : "#30D158",
                position: "relative", transition: "background 0.2s",
                cursor: "pointer",
              }}
            >
              <div style={{
                position: "absolute", top: 2,
                left: muted ? 2 : 14,
                width: 14, height: 14, borderRadius: "50%",
                background: "white",
                transition: "left 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              }} />
            </div>
          </label>

          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <span style={{ fontSize: 11, color: dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)" }}>
              {dark ? "🌙" : "☀️"}
            </span>
            <div
              onClick={() => {
                const next = dark ? "light" : "dark";
                setThemeState(next);
                window.electronAPI.setTheme(next);
              }}
              style={{
                width: 32, height: 18, borderRadius: 9,
                background: dark ? "#30D158" : "rgba(0,0,0,0.12)",
                position: "relative", transition: "background 0.2s",
                cursor: "pointer",
              }}
            >
              <div style={{
                position: "absolute", top: 2,
                left: dark ? 14 : 2,
                width: 14, height: 14, borderRadius: "50%",
                background: "white",
                transition: "left 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              }} />
            </div>
          </label>

          <button
            onClick={() => window.electronAPI.openSettings()}
            style={{
              fontSize: 9, border: "none", borderRadius: 6,
              padding: "4px 0", cursor: "pointer",
              background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
              color: dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
            }}
          >AI 设置</button>

          {currentProject && (
            <div style={{
              fontSize: 9,
              color: dark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.35)",
              textAlign: "center",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "100%",
            }}>
              {currentProject}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
