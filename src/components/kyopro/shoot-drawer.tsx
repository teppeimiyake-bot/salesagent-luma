"use client";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  KYOPRO_ROLES,
  ROLE_LABEL,
  ROLE_STYLE,
  SHOOT_KIND_LABEL,
  SHOOT_STATUS_LABEL,
  ASSIGN_STATUS_LABEL,
  formatJPY,
  isPayRateOutOfRange,
  parseRequiredCounts,
  resolveRate,
  billTotal,
  payTotal,
  type RateLike,
} from "@/lib/kyopro";
import type { KyoproRole } from "@prisma/client";
import { holidayName } from "@/lib/jp-holidays";
import { X, Plus, Trash2, AlertTriangle, Search, Sparkles, Loader2 } from "lucide-react";

type DetailAssignment = {
  id: string;
  role: KyoproRole;
  staffId: string;
  staffName: string;
  status: string;
  billAmount: number;
  payAmount: number;
  cleanup: boolean;
  cleanupBillAmount: number;
  cleanupPayAmount: number;
  adjustAmount: number;
  note: string | null;
};

type Detail = {
  shoot: {
    id: string;
    date: string;
    kind: "SHOOT" | "SETUP";
    status: string;
    clientName: string;
    clientColor: string;
    venueName: string | null;
    startTime: string | null;
    endTime: string | null;
    note: string | null;
    requiredCounts: unknown;
  };
  assignments: DetailAssignment[];
  staff: { id: string; name: string; roles: KyoproRole[]; payOverrides: unknown }[];
  rates: (Omit<RateLike, "effectiveFrom"> & { effectiveFrom: string })[];
  sameDay: { staffId: string; where: string }[];
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dateLabel(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const holiday = holidayName(iso);
  return `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}${holiday ? `・${holiday}` : ""}）`;
}

/**
 * 撮影会詳細（右スライドオーバー）
 * ------------------------------------------------------------
 * 職種ごとに依頼人数ぶんの枠を並べ、空き枠は破線で残す。
 * 現場から開いて片付けチェックだけ入れられるよう、モバイル幅では全画面にする。
 */
export function ShootDrawer({
  shootId,
  canEdit,
  onClose,
}: {
  shootId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const [addingRole, setAddingRole] = useState<KyoproRole | null>(null);

  const apply = useCallback((ok: boolean, body: Detail & { error?: string }) => {
    if (ok) setData(body);
    else setError(body.error ?? "読み込みに失敗しました");
  }, []);

  /** 更新後の読み直し（イベントハンドラから呼ぶ） */
  const load = useCallback(async () => {
    const res = await fetch(`/api/kyopro/shoots/${shootId}`);
    apply(res.ok, await res.json().catch(() => ({})));
  }, [shootId, apply]);

  // 初回読み込み。閉じた後に結果が返ってきても state を触らないようにする。
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/kyopro/shoots/${shootId}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!cancelled) apply(ok, body);
      })
      .catch(() => {
        if (!cancelled) setError("読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [shootId, apply]);

  // Esc で閉じる（現場でスマホから開いたときも戻りやすく）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mutate = useCallback(
    (fn: () => Promise<Response>) => {
      startBusy(async () => {
        const res = await fn();
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? "更新に失敗しました");
          return;
        }
        setError(null);
        await load();
        router.refresh();
      });
    },
    [load, router],
  );

  const required = useMemo(
    () => parseRequiredCounts(data?.shoot.requiredCounts),
    [data?.shoot.requiredCounts],
  );
  const sameDayMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of data?.sameDay ?? []) m.set(s.staffId, [...(m.get(s.staffId) ?? []), s.where]);
    return m;
  }, [data?.sameDay]);

  const rates: RateLike[] = useMemo(
    () => (data?.rates ?? []).map((r) => ({ ...r, effectiveFrom: new Date(r.effectiveFrom) })),
    [data?.rates],
  );

  const live = (data?.assignments ?? []).filter((a) => a.status !== "CANCELLED");
  const totalBill = live.reduce((s, a) => s + billTotal(a), 0);
  const totalPay = live.reduce((s, a) => s + payTotal(a), 0);
  const margin = totalBill - totalPay;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
      />
      <aside className="relative flex h-full w-full flex-col border-l border-zinc-200 bg-white shadow-2xl sm:w-[600px]">
        {!data ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            読み込み中…
          </div>
        ) : (
          <>
            <header className="border-b border-zinc-200 px-5 py-4">
              <div className="flex items-start gap-3">
                <span
                  className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
                  style={{ background: data.shoot.clientColor }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold tracking-tight">
                      {dateLabel(data.shoot.date)} {data.shoot.clientName}
                    </h2>
                    {data.shoot.kind === "SETUP" && (
                      <span className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-500">
                        {SHOOT_KIND_LABEL.SETUP}
                      </span>
                    )}
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">
                      {SHOOT_STATUS_LABEL[data.shoot.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {data.shoot.venueName ?? "会場未設定"}
                    {data.shoot.startTime && ` ／ ${data.shoot.startTime}${data.shoot.endTime ? `–${data.shoot.endTime}` : ""}`}
                    {data.shoot.note && ` ／ ${data.shoot.note}`}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  aria-label="閉じる"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </header>

            {error && (
              <p className="mx-5 mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
            )}

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {KYOPRO_ROLES.map((role) => {
                const st = ROLE_STYLE[role];
                const rows = live.filter((a) => a.role === role);
                const req = required[role] ?? 0;
                const empty = Math.max(0, req - rows.length);
                if (req === 0 && rows.length === 0) return null;
                return (
                  <section key={role}>
                    <div className="mb-2 flex items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.bg} ${st.border} ${st.text}`}
                      >
                        {ROLE_LABEL[role]}
                      </span>
                      <span
                        className={`text-xs font-semibold tabular-nums ${
                          rows.length < req ? "text-rose-600" : "text-zinc-400"
                        }`}
                      >
                        {rows.length}
                        {req > 0 && ` / ${req}`}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      {rows.map((a) => (
                        <AssignmentRow
                          key={`${a.id}:${a.payAmount}:${a.cleanup}`}
                          a={a}
                          rate={resolveRate(rates, role, new Date(`${data.shoot.date}T00:00:00Z`))}
                          conflict={sameDayMap.get(a.staffId) ?? []}
                          canEdit={canEdit}
                          busy={busy}
                          onPatch={(body) =>
                            mutate(() =>
                              fetch(`/api/kyopro/assignments/${a.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(body),
                              }),
                            )
                          }
                          onDelete={() =>
                            mutate(() =>
                              fetch(`/api/kyopro/assignments/${a.id}`, { method: "DELETE" }),
                            )
                          }
                        />
                      ))}

                      {canEdit && addingRole === role ? (
                        <StaffPicker
                          role={role}
                          staff={data.staff}
                          taken={new Set(rows.map((r) => r.staffId))}
                          sameDayMap={sameDayMap}
                          onCancel={() => setAddingRole(null)}
                          onPick={(staffId) => {
                            setAddingRole(null);
                            mutate(() =>
                              fetch("/api/kyopro/assignments", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ shootId: data.shoot.id, staffId, role }),
                              }),
                            );
                          }}
                        />
                      ) : (
                        canEdit &&
                        Array.from({ length: empty }).map((_, i) => (
                          <button
                            key={i}
                            onClick={() => setAddingRole(role)}
                            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400 hover:border-emerald-400 hover:text-emerald-700"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            人材を割り当て
                          </button>
                        ))
                      )}

                      {canEdit && addingRole !== role && empty === 0 && (
                        <button
                          onClick={() => setAddingRole(role)}
                          className="text-[11px] text-zinc-400 hover:text-emerald-700"
                        >
                          ＋ 依頼人数を超えて追加
                        </button>
                      )}
                    </div>
                  </section>
                );
              })}

              {canEdit && (
                <div className="border-t border-zinc-100 pt-3">
                  <div className="mb-2 text-[11px] font-bold tracking-wide text-zinc-400">
                    依頼が無い職種を追加
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {KYOPRO_ROLES.filter(
                      (r) => (required[r] ?? 0) === 0 && !live.some((a) => a.role === r),
                    ).map((r) => (
                      <button
                        key={r}
                        onClick={() => setAddingRole(r)}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:border-emerald-400 hover:text-emerald-700"
                      >
                        ＋ {ROLE_LABEL[r]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <footer className="border-t border-zinc-200 bg-zinc-50 px-5 py-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm tabular-nums">
                <span className="text-zinc-500">
                  受注 <b className="text-zinc-900">{formatJPY(totalBill)}</b>
                </span>
                <span className="text-zinc-500">
                  発注 <b className="text-zinc-900">{formatJPY(totalPay)}</b>
                </span>
                <span className="font-semibold text-emerald-700">
                  粗利 {formatJPY(margin)}
                  {totalBill > 0 && (
                    <span className="ml-1 text-xs text-emerald-600">
                      {Math.round((margin / totalBill) * 1000) / 10}%
                    </span>
                  )}
                </span>
                <span className="ml-auto text-xs text-zinc-400">{live.length} 人日</span>
              </div>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

function AssignmentRow({
  a,
  rate,
  conflict,
  canEdit,
  busy,
  onPatch,
  onDelete,
}: {
  a: DetailAssignment;
  rate: RateLike | null;
  conflict: string[];
  canEdit: boolean;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  // 保存後は親が key を変えて作り直すので、初期値の同期は不要
  const [pay, setPay] = useState(String(a.payAmount));
  const outOfRange = isPayRateOutOfRange(rate, a.role, Number(pay || 0));

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-medium">{a.staffName}</span>

        {a.status === "TENTATIVE" && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">
            {ASSIGN_STATUS_LABEL.TENTATIVE}
          </span>
        )}
        {conflict.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700"
            title={`同じ日に ${conflict.join("、")} にも入っています`}
          >
            <AlertTriangle className="h-3 w-3" />
            同日 {conflict.length} 件
          </span>
        )}

        <button
          disabled={!canEdit || busy}
          onClick={() => onPatch({ cleanup: !a.cleanup })}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
            a.cleanup
              ? "border-emerald-500 bg-emerald-50 text-emerald-700"
              : "border-zinc-200 text-zinc-400 hover:border-emerald-300 hover:text-emerald-600"
          }`}
          title="片付け対応（京プロへ+3,000円請求／人材への支払は変わりません）"
        >
          <Sparkles className="h-3 w-3" />
          片付け{a.cleanup ? " ✓" : ""}
        </button>

        <div className="ml-auto flex items-center gap-2 text-xs tabular-nums text-zinc-500">
          <span title="受注（京プロ請求）">
            受注 {formatJPY(a.billAmount + a.cleanupBillAmount)}
          </span>
          <span className="text-zinc-300">／</span>
          <label className="inline-flex items-center gap-1" title="発注（人材支払）">
            発注
            <input
              type="number"
              step={1000}
              min={0}
              disabled={!canEdit || busy}
              value={pay}
              onChange={(e) => setPay(e.target.value)}
              onBlur={() => {
                const n = Number(pay);
                if (Number.isFinite(n) && n !== a.payAmount) onPatch({ payAmount: n });
              }}
              className={`w-20 rounded border px-1.5 py-0.5 text-right tabular-nums ${
                outOfRange ? "border-amber-400 bg-amber-50 text-amber-800" : "border-zinc-200"
              }`}
            />
          </label>
          {canEdit && (
            <button
              onClick={() => {
                if (confirm(`${a.staffName} のアサインを削除しますか？`)) onDelete();
              }}
              disabled={busy}
              className="rounded p-1 text-zinc-300 hover:bg-red-50 hover:text-red-500"
              title="アサインを外す"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {outOfRange && (
        <p className="mt-1 text-[11px] text-amber-700">
          この職種の想定レンジ（{formatJPY(rate?.payRateMin ?? 0)}〜{formatJPY(rate?.payRateMax ?? 0)}）から外れています。
        </p>
      )}
    </div>
  );
}

function StaffPicker({
  role,
  staff,
  taken,
  sameDayMap,
  onPick,
  onCancel,
}: {
  role: KyoproRole;
  staff: { id: string; name: string; roles: KyoproRole[] }[];
  taken: Set<string>;
  sameDayMap: Map<string, string[]>;
  onPick: (staffId: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const list = staff
    .filter((s) => !taken.has(s.id))
    .filter((s) => (q ? s.name.includes(q) : true))
    // 対応職種の人を先に出す（それ以外も選べるようにはしておく）
    .sort((a, b) => Number(b.roles.includes(role)) - Number(a.roles.includes(role)));

  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50/40 p-2">
      <div className="mb-2 flex items-center gap-2">
        <Search className="h-3.5 w-3.5 text-zinc-400" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`${ROLE_LABEL[role]}を検索`}
          className="h-7 flex-1 rounded border border-zinc-200 px-2 text-sm outline-none focus:border-emerald-400"
        />
        <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-800">
          キャンセル
        </button>
      </div>
      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
        {list.map((s) => {
          const conflict = sameDayMap.get(s.id) ?? [];
          const canRole = s.roles.includes(role);
          return (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              title={
                conflict.length > 0
                  ? `同じ日に ${conflict.join("、")} にも入っています`
                  : canRole
                    ? ""
                    : `${ROLE_LABEL[role]}は対応職種に入っていません`
              }
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                canRole
                  ? "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-400 hover:text-emerald-700"
                  : "border-dashed border-zinc-200 bg-white/60 text-zinc-400 hover:border-emerald-300"
              }`}
            >
              {s.name}
              {conflict.length > 0 && <AlertTriangle className="h-3 w-3 text-amber-500" />}
            </button>
          );
        })}
        {list.length === 0 && <p className="p-2 text-xs text-zinc-400">該当する人材がいません。</p>}
      </div>
    </div>
  );
}
