"use client";

/**
 * `TimingSimulator` — визуальная симуляция тайминга рассылки на основе
 * текущего `AntiBanConfig`. Помогает «увидеть» влияние настроек до
 * сохранения.
 *
 * Что показываем:
 *   - Горизонтальная timeline: точки запросов с интервалами в диапазоне
 *     [delay_min, delay_max], jitter случайный (но детерминированный
 *     по seed-у конфига, чтобы при одинаковых настройках картинка была
 *     одинаковая).
 *   - Длинные паузы — серые блоки между батчами.
 *   - Подсчёт ETA для типового объёма (50 запросов).
 *   - Анимация воспроизведения: когда нажата кнопка ▶, точки появляются
 *     одна за другой в реальном (но ускоренном) времени, чтобы пользователь
 *     увидел паттерн вживую.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Sparkles } from "lucide-react";

import type { AntiBanConfig } from "@/lib/anti-ban";

export interface TimingSimulatorProps {
  config: AntiBanConfig;
  /** Сколько запросов симулировать (default 50). */
  sampleSize?: number;
}

interface SimEvent {
  /** Смещение от старта в секундах. */
  t: number;
  /** Тип события — отправка или длинная пауза. */
  kind: "send" | "long_pause";
}

/**
 * Детерминированный pseudo-random на основе seed (FNV-1a hash от
 * config-параметров) — чтобы перерендеры с одинаковым конфигом давали
 * стабильную картинку, но изменение любого поля меняло паттерн.
 */
function makeRng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function configSeed(c: AntiBanConfig): number {
  // FNV-1a по сериализации
  const s = JSON.stringify([
    c.delay_min,
    c.delay_max,
    c.long_pause_every_n,
    c.long_pause_seconds,
    c.batch_size,
    c.broadcast_jitter_max,
  ]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildSimulation(config: AntiBanConfig, n: number): SimEvent[] {
  const rng = makeRng(configSeed(config));
  const events: SimEvent[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    events.push({ t, kind: "send" });
    const span = Math.max(0, config.delay_max - config.delay_min);
    const delay = config.delay_min + rng() * span + 1.0; // +1 — типовое время API-запроса
    t += delay;
    if (
      config.long_pause_every_n > 0 &&
      (i + 1) % config.long_pause_every_n === 0 &&
      i + 1 < n
    ) {
      events.push({ t, kind: "long_pause" });
      t += config.long_pause_seconds;
    }
  }
  return events;
}

export function TimingSimulator({
  config,
  sampleSize = 50,
}: TimingSimulatorProps) {
  const events = useMemo(
    () => buildSimulation(config, sampleSize),
    [config, sampleSize],
  );
  const totalSeconds = events.length
    ? events[events.length - 1].t +
      (config.delay_min + config.delay_max) / 2 +
      1
    : 0;

  // ── Voice-over: «играем» симуляцию в ускоренном времени ────────────────
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 — доля totalSeconds
  const rafRef = useRef<number | null>(null);
  const startRealRef = useRef<number>(0);
  const speedRef = useRef<number>(15); // 15× ускорение

  useEffect(() => {
    if (!playing) return;
    startRealRef.current = performance.now();
    const tick = () => {
      const elapsed =
        ((performance.now() - startRealRef.current) / 1000) *
        speedRef.current;
      const p = Math.min(1, elapsed / Math.max(0.0001, totalSeconds));
      setProgress(p);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, totalSeconds]);

  function toggle() {
    if (playing) {
      setPlaying(false);
      return;
    }
    setProgress(0);
    setPlaying(true);
  }

  const playedT = progress * totalSeconds;
  const sent = events.filter((e) => e.kind === "send" && e.t <= playedT).length;

  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
          <Sparkles className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
          Симулятор тайминга ({sampleSize} запросов)
        </div>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-surface border border-border text-xs text-text-secondary hover:border-accent/40 transition-colors"
        >
          {playing ? (
            <Pause className="h-3 w-3" strokeWidth={2.5} />
          ) : (
            <Play className="h-3 w-3" strokeWidth={2.5} />
          )}
          {playing ? "Пауза" : "Проиграть"}
        </button>
      </div>

      {/* Timeline */}
      <div className="relative h-12 w-full rounded-md bg-surface overflow-hidden">
        {events.map((event, idx) => {
          const left = (event.t / Math.max(0.0001, totalSeconds)) * 100;
          if (event.kind === "long_pause") {
            const widthSec = config.long_pause_seconds;
            const width = (widthSec / Math.max(0.0001, totalSeconds)) * 100;
            return (
              <div
                key={`p-${idx}`}
                className="absolute top-0 bottom-0 bg-warning/20 border-x border-warning/40"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`Длинная пауза ${widthSec} сек`}
              />
            );
          }
          const visible = event.t <= playedT;
          return (
            <div
              key={`s-${idx}`}
              className={`absolute top-1/2 -translate-y-1/2 h-2 w-2 rounded-full transition-colors ${
                visible ? "bg-accent" : "bg-text-muted/40"
              }`}
              style={{ left: `${left}%`, transform: "translate(-50%, -50%)" }}
              title={`Запрос #${events.slice(0, idx + 1).filter((e) => e.kind === "send").length} @ ${event.t.toFixed(1)}s`}
            />
          );
        })}

        {/* Прогресс-индикатор воспроизведения */}
        {playing && (
          <div
            className="absolute top-0 bottom-0 w-px bg-accent"
            style={{ left: `${progress * 100}%` }}
          />
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Длительность" value={formatDuration(totalSeconds)} />
        <Stat
          label="Среднее между запросами"
          value={`${avgInterval(config).toFixed(1)} сек`}
        />
        <Stat
          label="Длинных пауз"
          value={
            config.long_pause_every_n > 0
              ? String(Math.floor(sampleSize / config.long_pause_every_n))
              : "0"
          }
        />
      </div>

      {playing && (
        <div className="text-xs text-text-muted">
          Отправлено: <span className="text-text font-mono">{sent}/{sampleSize}</span>{" "}
          · ускорение ×{speedRef.current}
        </div>
      )}
    </div>
  );
}

function avgInterval(c: AntiBanConfig): number {
  return (c.delay_min + c.delay_max) / 2 + 1.0;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m} мин ${s} сек` : `${m} мин`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h} ч ${remM} мин`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2 border border-border">
      <div className="text-text-muted">{label}</div>
      <div className="text-text font-semibold mt-0.5">{value}</div>
    </div>
  );
}

export default TimingSimulator;
