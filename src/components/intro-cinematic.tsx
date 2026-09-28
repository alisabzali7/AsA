"use client";
/**
 * AsA CINEMATIC ENTRY EXPERIENCE
 *
 * 1. 0.0s -> 1.0s: 3D interactive stylized $100 banknote with realistic depth,
 *    subtle ambient lighting, intaglio textures, and physical interactive tear gestures.
 * 2. Gesture / drag / swipe / tap -> The bill tears vertically down the center into
 *    two 3D physics-displaced halves.
 * 3. 1.0s -> 3.0s: Persian welcome typography reveal:
 *    «سلام علی، به کارخانه پول‌سازی خودت خوش اومدی»
 *    with soft gold luminance and blur-to-clear presentation.
 * 4. Seamless continuous fade into Home without page reloads.
 * 5. Reduced-motion and auto-advance protection (user never gets stuck).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motionPref } from "./selection";

interface IntroCinematicProps {
  onComplete: () => void;
}

export function IntroCinematic({ onComplete }: IntroCinematicProps) {
  const [motion] = motionPref.use();
  const isReduced = motion === "reduced";
  const [stage, setStage] = useState<"bill" | "tearing" | "torn" | "welcome" | "finishing">(() =>
    isReduced ? "welcome" : "bill"
  );
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0); // 0 to 1
  const startXRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoTearTimerRef = useRef<NodeJS.Timeout | null>(null);

  const triggerTear = useCallback(() => {
    if (stage !== "bill" && stage !== "tearing") return;
    setStage("torn");
    setTimeout(() => {
      setStage("welcome");
    }, 600);
    setTimeout(() => {
      setStage("finishing");
      setTimeout(() => {
        try {
          sessionStorage.setItem("asa-intro-seen", "true");
        } catch { /* ignore */ }
        onComplete();
      }, 700);
    }, 2800);
  }, [stage, onComplete]);

  // Reduced motion or timer fallback
  useEffect(() => {
    if (isReduced) {
      const t = setTimeout(() => {
        try {
          sessionStorage.setItem("asa-intro-seen", "true");
        } catch { /* ignore */ }
        onComplete();
      }, 1800);
      return () => clearTimeout(t);
    }

    // Auto-advance fallback if user does not touch after 2 seconds
    autoTearTimerRef.current = setTimeout(() => {
      triggerTear();
    }, 2200);

    return () => {
      if (autoTearTimerRef.current) clearTimeout(autoTearTimerRef.current);
    };
  }, [isReduced, onComplete, triggerTear]);

  // Mouse / Touch Gesture Handlers
  const handlePointerDown = (clientX: number) => {
    if (stage !== "bill") return;
    startXRef.current = clientX;
    setIsDragging(true);
    if (autoTearTimerRef.current) clearTimeout(autoTearTimerRef.current);
  };

  const handlePointerMove = (clientX: number) => {
    if (!isDragging || startXRef.current === null || stage !== "bill") return;
    const diff = Math.abs(clientX - startXRef.current);
    const maxDist = 140;
    const progress = Math.min(1, diff / maxDist);
    setDragX(clientX - startXRef.current);
    setDragProgress(progress);

    if (progress >= 0.75) {
      setIsDragging(false);
      triggerTear();
    }
  };

  const handlePointerUp = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (dragProgress > 0.4) {
      triggerTear();
    } else {
      setDragX(0);
      setDragProgress(0);
    }
  };

  const handleSkip = () => {
    try {
      sessionStorage.setItem("asa-intro-seen", "true");
    } catch { /* ignore */ }
    onComplete();
  };

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden select-none transition-opacity duration-700 ${
        stage === "finishing" ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      style={{
        background: "radial-gradient(circle at center, #0e121a 0%, #06070a 100%)",
        perspective: "1200px",
      }}
      onMouseMove={(e) => handlePointerMove(e.clientX)}
      onMouseUp={handlePointerUp}
      onTouchMove={(e) => {
        if (e.touches[0]) handlePointerMove(e.touches[0].clientX);
      }}
      onTouchEnd={handlePointerUp}
    >
      {/* Background ambient lighting */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(600px 300px at 50% 50%, rgba(216,188,120,0.15), transparent 70%), radial-gradient(400px 400px at 50% 80%, rgba(67,196,149,0.08), transparent 60%)",
        }}
      />

      {/* Skip affordance */}
      <button
        onClick={handleSkip}
        className="focus-ring absolute top-5 end-6 z-20 rounded-full border hairline bg-[rgba(14,17,24,0.7)] px-3 py-1 text-[11px] text-dim backdrop-blur-sm transition-colors hover:text-gold hover:border-gold-3"
      >
        Skip ✕
      </button>

      {/* ----------------- 3D Banknote Container ----------------- */}
      {(stage === "bill" || stage === "tearing" || stage === "torn") && (
        <div className="relative flex flex-col items-center justify-center p-4">
          <div
            className="relative cursor-grab active:cursor-grabbing transition-transform duration-150"
            style={{
              width: "min(90vw, 440px)",
              height: "min(46vw, 210px)",
              transformStyle: "preserve-3d",
              transform: `rotateY(${dragX * 0.1}deg) rotateX(${-dragProgress * 12}deg) scale(${1 + dragProgress * 0.04})`,
            }}
            onMouseDown={(e) => handlePointerDown(e.clientX)}
            onTouchStart={(e) => {
              if (e.touches[0]) handlePointerDown(e.touches[0].clientX);
            }}
            onClick={triggerTear}
          >
            {/* Left Half of $100 Bill */}
            <div
              className="absolute inset-y-0 start-0 w-1/2 overflow-hidden rounded-s-lg border border-e-0 border-[rgba(216,188,120,0.4)] shadow-2xl transition-all duration-700 ease-out"
              style={{
                background: "linear-gradient(135deg, #18231c 0%, #1e2e25 50%, #121c16 100%)",
                boxShadow: "0 20px 50px rgba(0,0,0,0.8), inset 0 0 20px rgba(67,196,149,0.15)",
                transformOrigin: "left center",
                transform:
                  stage === "torn"
                    ? "translateX(-120px) translateY(-30px) rotateZ(-16deg) rotateY(-25deg) scale(0.9)"
                    : `translateX(${-dragProgress * 14}px) rotateY(${-dragProgress * 8}deg)`,
                opacity: stage === "torn" ? 0 : 1,
              }}
            >
              {/* Intaglio Grid & Textures */}
              <div
                className="absolute inset-0 opacity-20 pointer-events-none"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, #43c495 0, #43c495 1px, transparent 0, transparent 8px)",
                }}
              />
              {/* Left Content */}
              <div className="relative h-full w-[200%] p-4 flex flex-col justify-between text-[#85b99b]">
                <div className="flex items-start justify-between">
                  <div className="flex flex-col">
                    <span className="mono text-2xl font-black tracking-tight text-[#d8bc78]">100</span>
                    <span className="text-[8px] uppercase tracking-widest text-[#66987d]">FEDERAL RESERVE NOTE</span>
                  </div>
                  <div className="rounded-full border border-[#d8bc78]/40 px-2 py-0.5 text-[8px] font-bold text-[#d8bc78]">
                    SERIES 2026
                  </div>
                </div>

                {/* Franklin Portrait Silhouette Center */}
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex items-center justify-center opacity-40">
                  <div className="h-28 w-24 rounded-full border-2 border-dashed border-[#85b99b]/40 flex items-center justify-center">
                    <span className="text-[10px] font-bold tracking-widest text-gold">AsA 100</span>
                  </div>
                </div>

                <div className="flex items-end justify-between text-[9px] font-mono opacity-80">
                  <span>UNITED STATES OF AMERICA</span>
                  <span>ONE HUNDRED DOLLARS</span>
                </div>
              </div>

              {/* Tearing Serration Edge */}
              <div
                className="absolute inset-y-0 end-0 w-2 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(circle at 100% 50%, rgba(216,188,120,0.5) 0%, transparent 80%)",
                  borderRight: dragProgress > 0 ? "2px dashed #d8bc78" : "1px solid rgba(216,188,120,0.3)",
                }}
              />
            </div>

            {/* Right Half of $100 Bill */}
            <div
              className="absolute inset-y-0 end-0 w-1/2 overflow-hidden rounded-e-lg border border-s-0 border-[rgba(216,188,120,0.4)] shadow-2xl transition-all duration-700 ease-out"
              style={{
                background: "linear-gradient(225deg, #18231c 0%, #1e2e25 50%, #121c16 100%)",
                boxShadow: "0 20px 50px rgba(0,0,0,0.8), inset 0 0 20px rgba(67,196,149,0.15)",
                transformOrigin: "right center",
                transform:
                  stage === "torn"
                    ? "translateX(120px) translateY(30px) rotateZ(16deg) rotateY(25deg) scale(0.9)"
                    : `translateX(${dragProgress * 14}px) rotateY(${dragProgress * 8}deg)`,
                opacity: stage === "torn" ? 0 : 1,
              }}
            >
              {/* Intaglio Grid & Textures */}
              <div
                className="absolute inset-0 opacity-20 pointer-events-none"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(-45deg, #43c495 0, #43c495 1px, transparent 0, transparent 8px)",
                }}
              />
              {/* Right Content (offset by -50% to align with full bill) */}
              <div
                className="relative h-full w-[200%] p-4 flex flex-col justify-between text-[#85b99b]"
                style={{ transform: "translateX(-50%)" }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex flex-col">
                    <span className="mono text-2xl font-black tracking-tight text-[#d8bc78]">100</span>
                    <span className="text-[8px] uppercase tracking-widest text-[#66987d]">FEDERAL RESERVE NOTE</span>
                  </div>
                  <div className="rounded-full border border-[#d8bc78]/40 px-2 py-0.5 text-[8px] font-bold text-[#d8bc78]">
                    THE UNITED STATES
                  </div>
                </div>

                <div className="flex items-end justify-between text-[9px] font-mono opacity-80">
                  <span>FRANKLIN</span>
                  <span className="font-bold text-gold">IN TRUTH WE TRUST</span>
                </div>
              </div>

              {/* Tearing Serration Edge */}
              <div
                className="absolute inset-y-0 start-0 w-2 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(circle at 0% 50%, rgba(216,188,120,0.5) 0%, transparent 80%)",
                  borderLeft: dragProgress > 0 ? "2px dashed #d8bc78" : "1px solid rgba(216,188,120,0.3)",
                }}
              />
            </div>
          </div>

          {/* Interactive Hint */}
          <div
            className={`mt-6 text-center transition-opacity duration-300 ${
              stage === "torn" ? "opacity-0" : "opacity-80"
            }`}
          >
            <p className="text-[12px] font-medium text-gold flex items-center justify-center gap-1.5 animate-pulse">
              <span>Swipe or touch bill to tear</span>
              <span className="mono text-[10px] text-dim">({Math.round(dragProgress * 100)}%)</span>
            </p>
          </div>
        </div>
      )}

      {/* ----------------- Persian Welcome Typography Reveal ----------------- */}
      {(stage === "welcome" || stage === "finishing") && (
        <div
          className="relative z-10 flex max-w-[850px] flex-col items-center px-6 text-center"
          dir="rtl"
          lang="fa"
        >
          {/* AsA Geometric Monogram Crest */}
          <div
            className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-gold-2 bg-[rgba(216,188,120,0.08)] shadow-[0_0_40px_rgba(216,188,120,0.3)] transition-all duration-700 ease-out"
            style={{
              animation: "asa-dialog-in var(--t-long) var(--ease-spring) both",
            }}
          >
            <span className="mono text-2xl font-black text-gold">AsA</span>
          </div>

          {/* Persian Welcome Headline */}
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-extrabold leading-relaxed text-text tracking-normal transition-all duration-1000"
            style={{
              fontFamily: "'Vazirmatn', sans-serif",
              textShadow: "0 0 30px rgba(216,188,120,0.35)",
              animation: "asa-page-in var(--t-long) var(--ease-out) both",
            }}
          >
            «سلام علی، به کارخانه پول‌سازی خودت خوش اومدی»
          </h1>

          {/* Subtitle */}
          <p
            className="mt-4 text-sm sm:text-base text-muted max-w-[540px] leading-relaxed"
            style={{
              animation: "asa-rise var(--t-long) var(--ease-out) both",
              animationDelay: "300ms",
            }}
          >
            ایستگاه هوش بازار و تحلیل قطعی تریدینگ ترمینال
          </p>

          <div
            className="mt-8 flex items-center justify-center gap-2"
            style={{
              animation: "asa-fade 800ms ease both",
              animationDelay: "600ms",
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-gold animate-ping" />
            <span className="mono text-[11px] text-gold uppercase tracking-wider">
              INITIALIZING WORKSTATION…
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
