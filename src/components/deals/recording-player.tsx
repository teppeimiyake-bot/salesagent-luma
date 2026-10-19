"use client";
import { useRef, useState } from "react";
import { fmtDuration } from "@/lib/meetings/recording-facts";

function clock(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const hours = Math.floor(whole / 3600);
  const rest = fmtDuration(whole % 3600) ?? "0:00";
  return hours ? `${hours}:${rest.padStart(5, "0")}` : rest;
}

/**
 * 記録カードの録音プレーヤー。デスクトップはネイティブの audio controls のまま。
 * T04/T03: 390px ではネイティブのシークバーが時刻・音量の表示に押されて短い棒になり、指で途中へ動かせないため、
 * 狭い幅（sm 未満）だけ全幅のシーク用スライダーを下に出す。長さが分かってから出す（長さ不明の webm では出さない）。
 */
export function RecordingPlayer({ src }: { src: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const sync = () => {
    const element = audio.current;
    if (!element) return;
    setCurrent(element.currentTime);
    setDuration(Number.isFinite(element.duration) ? element.duration : 0);
  };
  return (
    <div>
      <audio
        ref={audio}
        controls
        preload="metadata"
        className="w-full h-10"
        src={src}
        onLoadedMetadata={sync}
        onDurationChange={sync}
        onTimeUpdate={sync}
      />
      {duration > 0 && (
        <div className="mt-2 sm:hidden">
          <input
            type="range"
            min={0}
            max={duration}
            step={1}
            value={Math.min(current, duration)}
            aria-label="再生位置"
            className="block h-8 w-full touch-manipulation accent-orange-600"
            onChange={(event) => {
              const element = audio.current;
              if (!element) return;
              element.currentTime = Number(event.target.value);
              setCurrent(element.currentTime);
            }}
          />
          <p className="text-right text-[12px] tabular-nums text-zinc-500">
            {clock(current)} / {clock(duration)}
          </p>
        </div>
      )}
    </div>
  );
}
