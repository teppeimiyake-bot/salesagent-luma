"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  KYOPRO_COLOR_PRESETS,
  KYOPRO_ROLES,
  ROLE_LABEL,
  ROLE_STYLE,
  formatJPY,
} from "@/lib/kyopro";
import { Plus, Save, Trash2, RotateCcw } from "lucide-react";

export type ClientRow = {
  id: string;
  name: string;
  colorHex: string;
  defaultVenueId: string | null;
  active: boolean;
};
export type VenueRow = { id: string; name: string; colorHex: string; active: boolean };
export type RateRow = {
  id: string;
  role: string;
  billRate: number;
  payRateDefault: number;
  payRateMin: number | null;
  payRateMax: number | null;
  cleanupBillAmount: number;
  cleanupPayAmount: number;
};
export type SettingRow = { id: string; payoutDueMonths: number; taxRate: number };

export function MastersClient({
  clients,
  venues,
  rates,
  setting,
}: {
  clients: ClientRow[];
  venues: VenueRow[];
  rates: RateRow[];
  setting: SettingRow;
}) {
  return (
    <div className="space-y-6">
      <RatesSection rates={rates} />
      <SettingSection setting={setting} />
      <ClientsSection clients={clients} venues={venues} />
      <VenuesSection venues={venues} />
    </div>
  );
}

function Section({
  title,
  desc,
  children,
  action,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-zinc-800">{title}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RatesSection({ rates }: { rates: RateRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Record<string, Partial<RateRow>>>({});
  const [error, setError] = useState<string | null>(null);

  const sorted = KYOPRO_ROLES.map((r) => rates.find((x) => x.role === r)).filter(
    (r): r is RateRow => Boolean(r),
  );

  function set(id: string, key: keyof RateRow, value: string) {
    const n = value === "" ? null : Number(value);
    setDraft((p) => ({ ...p, [id]: { ...p[id], [key]: n } }));
  }

  function save(row: RateRow) {
    const d = draft[row.id];
    if (!d) return;
    setError(null);
    start(async () => {
      const res = await fetch(`/api/kyopro/rates/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "保存に失敗しました");
        return;
      }
      setDraft((p) => ({ ...p, [row.id]: {} }));
      router.refresh();
    });
  }

  return (
    <Section
      title="職種レート"
      desc="1名1日あたり・税抜。過去のアサインは確定時の金額を保持しているため、ここを変えても実績・請求は動きません。"
    >
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400">
              <th className="px-2 py-2 text-left font-bold">職種</th>
              <th className="px-2 py-2 text-right font-bold">受注（京プロ請求）</th>
              <th className="px-2 py-2 text-right font-bold">発注（既定）</th>
              <th className="px-2 py-2 text-right font-bold">発注 下限</th>
              <th className="px-2 py-2 text-right font-bold">発注 上限</th>
              <th className="px-2 py-2 text-right font-bold">片付け請求</th>
              <th className="px-2 py-2 text-right font-bold">片付け支払</th>
              <th className="px-2 py-2 text-right font-bold">粗利</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const d = draft[r.id] ?? {};
              const val = (k: keyof RateRow) => {
                const v = k in d ? d[k] : r[k];
                return v === null || v === undefined ? "" : String(v);
              };
              const bill = Number(val("billRate") || 0);
              const pay = Number(val("payRateDefault") || 0);
              const st = ROLE_STYLE[r.role as keyof typeof ROLE_STYLE];
              const dirty = Object.keys(d).length > 0;
              return (
                <tr key={r.id} className="border-b border-zinc-100 last:border-b-0">
                  <td className="px-2 py-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${st.bg} ${st.border} ${st.text}`}>
                      {ROLE_LABEL[r.role as keyof typeof ROLE_LABEL]}
                    </span>
                  </td>
                  {(
                    [
                      "billRate",
                      "payRateDefault",
                      "payRateMin",
                      "payRateMax",
                      "cleanupBillAmount",
                      "cleanupPayAmount",
                    ] as (keyof RateRow)[]
                  ).map((k) => (
                    <td key={k} className="px-2 py-2 text-right">
                      <input
                        type="number"
                        step={1000}
                        min={0}
                        value={val(k)}
                        onChange={(e) => set(r.id, k, e.target.value)}
                        className="w-24 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm tabular-nums focus:border-emerald-400 focus:outline-none"
                      />
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-emerald-700">
                    {formatJPY(bill - pay)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Button
                      size="sm"
                      variant={dirty ? "primary" : "ghost"}
                      disabled={!dirty || pending}
                      onClick={() => save(r)}
                    >
                      <Save className="h-3.5 w-3.5" />
                      保存
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function SettingSection({ setting }: { setting: SettingRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [months, setMonths] = useState(String(setting.payoutDueMonths));

  function save(next: string) {
    setMonths(next);
    start(async () => {
      await fetch("/api/kyopro/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutDueMonths: Number(next) }),
      });
      router.refresh();
    });
  }

  return (
    <Section title="締め・支払サイクル" desc="京プロへの請求は月次締め。人材への支払期日はここで決まります。">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { v: "1", label: "翌月末", hint: "11月撮影 → 12/31" },
          { v: "2", label: "翌々月末", hint: "11月撮影 → 1/31" },
          { v: "3", label: "3ヶ月後末", hint: "11月撮影 → 2/28" },
        ].map((o) => (
          <button
            key={o.v}
            type="button"
            disabled={pending}
            onClick={() => save(o.v)}
            className={`rounded-lg border px-4 py-2 text-left transition-colors ${
              months === o.v
                ? "border-emerald-600 bg-emerald-50"
                : "border-zinc-200 bg-white hover:border-zinc-300"
            }`}
          >
            <div className={`text-sm font-semibold ${months === o.v ? "text-emerald-700" : "text-zinc-700"}`}>
              {o.label}
            </div>
            <div className="text-[11px] text-zinc-500">{o.hint}</div>
          </button>
        ))}
      </div>
    </Section>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex gap-1">
      {KYOPRO_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{ background: c }}
          className={`h-5 w-5 rounded-full transition-transform ${
            value.toLowerCase() === c.toLowerCase() ? "ring-2 ring-zinc-900 ring-offset-1" : "hover:scale-110"
          }`}
          aria-label={c}
        />
      ))}
    </div>
  );
}

function ClientsSection({ clients, venues }: { clients: ClientRow[]; venues: VenueRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(KYOPRO_COLOR_PRESETS[0]);
  const [error, setError] = useState<string | null>(null);

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await fetch("/api/kyopro/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, colorHex: color }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      setName("");
      setAdding(false);
      router.refresh();
    });
  }

  function patch(id: string, body: Record<string, unknown>) {
    start(async () => {
      await fetch(`/api/kyopro/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });
  }

  return (
    <Section
      title="クライアント（呉服店）"
      desc="撮影会の主催者。請求先は京プロなので、ここは日程の識別と色分けに使います。"
      action={
        !adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            追加
          </Button>
        )
      }
    >
      {adding && (
        <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：おおやま様" required className="h-8 w-64" />
          <ColorPicker value={color} onChange={setColor} />
          <Button type="submit" size="sm" variant="primary" disabled={pending || !name}>
            保存
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            キャンセル
          </Button>
        </form>
      )}
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      <div className="space-y-1">
        {clients.map((c) => (
          <div
            key={c.id}
            className={`flex flex-wrap items-center gap-3 rounded-lg border border-zinc-100 px-3 py-2 ${
              c.active ? "" : "opacity-50"
            }`}
          >
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.colorHex }} />
            <span className="min-w-[180px] text-sm font-medium">{c.name}</span>
            {!c.active && <Badge variant="secondary">無効</Badge>}
            <ColorPicker value={c.colorHex} onChange={(hex) => patch(c.id, { colorHex: hex })} />
            <select
              value={c.defaultVenueId ?? ""}
              onChange={(e) => patch(c.id, { defaultVenueId: e.target.value || null })}
              className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-600"
            >
              <option value="">既定会場なし</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => patch(c.id, { active: !c.active })}
              disabled={pending}
              className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-rose-600"
              title={c.active ? "無効にする" : "有効に戻す"}
            >
              {c.active ? <Trash2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
            </button>
          </div>
        ))}
        {clients.length === 0 && <p className="text-xs text-zinc-400">まだ登録がありません。</p>}
      </div>
    </Section>
  );
}

function VenuesSection({ venues }: { venues: VenueRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await fetch("/api/kyopro/venues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      setName("");
      setAdding(false);
      router.refresh();
    });
  }

  function patch(id: string, body: Record<string, unknown>) {
    start(async () => {
      await fetch(`/api/kyopro/venues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });
  }

  return (
    <Section
      title="会場"
      desc="複数会場が同日に走るため、会場名は撮影会の識別に使います。クライアント店舗での開催は会場なしでも登録できます。"
      action={
        !adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            追加
          </Button>
        )
      }
    >
      {adding && (
        <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：葛飾シンフォニーヒルズ（青砥）" required className="h-8 w-80" />
          <Button type="submit" size="sm" variant="primary" disabled={pending || !name}>
            保存
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            キャンセル
          </Button>
        </form>
      )}
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {venues.map((v) => (
          <div
            key={v.id}
            className={`inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1.5 text-xs ${
              v.active ? "bg-white text-zinc-700" : "bg-zinc-50 text-zinc-400"
            }`}
          >
            {v.name}
            <button
              onClick={() => patch(v.id, { active: !v.active })}
              disabled={pending}
              className="text-zinc-300 hover:text-rose-500"
              title={v.active ? "無効にする" : "有効に戻す"}
            >
              {v.active ? <Trash2 className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
        {venues.length === 0 && <p className="text-xs text-zinc-400">まだ登録がありません。</p>}
      </div>
    </Section>
  );
}
