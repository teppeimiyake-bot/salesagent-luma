"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Building2,
  MapPin,
  Phone,
  Globe,
  User,
  Calendar,
  Users,
  Wallet,
  Edit3,
  Save,
  X,
  ImageIcon,
} from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { CompanyLogo } from "@/components/ui/company-logo";

type Company = {
  id: string;
  name: string;
  industry: string | null;
  websiteUrl: string | null;
  address: string | null;
  ceoName: string | null;
  establishedYear: number | null;
  employeeCount: number | null;
  capital: string | null;
  phoneNumber: string | null;
  logoColor: string | null;
  logoUrl: string | null;
};

type Stats = {
  pipelineAmount: number;
  wonAmount: number;
  activeDeals: number;
  contacts: number;
};

export function CompanyHero({ company, stats }: { company: Company; stats: Stats }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({
    industry: company.industry ?? "",
    address: company.address ?? "",
    ceoName: company.ceoName ?? "",
    establishedYear: company.establishedYear?.toString() ?? "",
    employeeCount: company.employeeCount?.toString() ?? "",
    capital: company.capital ?? "",
    phoneNumber: company.phoneNumber ?? "",
    websiteUrl: company.websiteUrl ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [fetchingLogo, setFetchingLogo] = useState(false);

  async function fetchLogo() {
    setFetchingLogo(true);
    await fetch(`/api/companies/${company.id}/fetch-logo`, { method: "POST" });
    setFetchingLogo(false);
    router.refresh();
  }

  async function save() {
    setSaving(true);
    await fetch(`/api/companies/${company.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        industry: v.industry || null,
        address: v.address || null,
        ceoName: v.ceoName || null,
        establishedYear: v.establishedYear ? Number(v.establishedYear) : null,
        employeeCount: v.employeeCount ? Number(v.employeeCount) : null,
        capital: v.capital || null,
        phoneNumber: v.phoneNumber || null,
        websiteUrl: v.websiteUrl || null,
      }),
    });
    setSaving(false);
    setEditing(false);
    router.refresh();
  }

  return (
    <div className="rounded-2xl bg-gradient-to-br from-orange-500 via-orange-500 to-amber-500 p-6 text-white shadow-lg">
      <div className="flex items-start gap-5">
        <div className="relative shrink-0">
          <CompanyLogo
            name={company.name}
            logoUrl={company.logoUrl}
            logoColor={company.logoColor}
            size="xl"
            className="border-2 border-white/40 shadow-xl"
          />
          {company.websiteUrl && (
            <button
              onClick={fetchLogo}
              disabled={fetchingLogo}
              title="HPからロゴを取得"
              className="absolute -bottom-1 -right-1 bg-white text-orange-600 rounded-full p-1 shadow-md hover:bg-orange-50 disabled:opacity-50"
            >
              <ImageIcon className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold tracking-tight truncate">{company.name}</h1>
          <p className="text-base text-white/90 mt-1">{company.industry || "業種未設定"}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
            <Stat icon={Wallet} label="見込み金額" value={formatJPY(Math.round(stats.pipelineAmount))} />
            <Stat icon={Building2} label="進行商談" value={`${stats.activeDeals} 件`} />
            <Stat icon={Users} label="連絡先" value={`${stats.contacts} 名`} />
            <Stat icon={Wallet} label="累計受注" value={formatJPY(stats.wonAmount)} highlight />
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing(!editing)}
          className="bg-white/20 text-white hover:bg-white/30 border-0"
        >
          {editing ? <X className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
          {editing ? "閉じる" : "編集"}
        </Button>
      </div>

      {/* 基本情報グリッド */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-5 border-t border-white/20">
        <Field label="代表者" value={company.ceoName} icon={User} />
        <Field label="設立" value={company.establishedYear ? `${company.establishedYear}年` : null} icon={Calendar} />
        <Field
          label="従業員"
          value={company.employeeCount ? `${company.employeeCount.toLocaleString()}名` : null}
          icon={Users}
        />
        <Field label="資本金" value={company.capital} icon={Wallet} />
        <Field label="電話" value={company.phoneNumber} icon={Phone} />
        <Field label="所在地" value={company.address} icon={MapPin} />
        <Field
          label="HP"
          value={company.websiteUrl}
          icon={Globe}
          href={company.websiteUrl ?? undefined}
        />
      </div>

      {editing && (
        <div className="mt-6 pt-5 border-t border-white/20 grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { key: "industry", label: "業種" },
            { key: "ceoName", label: "代表者" },
            { key: "establishedYear", label: "設立年（数値）" },
            { key: "employeeCount", label: "従業員数（数値）" },
            { key: "capital", label: "資本金" },
            { key: "phoneNumber", label: "電話" },
            { key: "address", label: "所在地" },
            { key: "websiteUrl", label: "HP URL" },
          ].map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs text-white/80">{f.label}</Label>
              <Input
                value={v[f.key as keyof typeof v]}
                onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                className="bg-white/90 text-zinc-900"
              />
            </div>
          ))}
          <div className="md:col-span-2 flex justify-end gap-2 mt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing(false)}
              className="bg-white/20 text-white hover:bg-white/30"
            >
              キャンセル
            </Button>
            <Button onClick={save} disabled={saving} className="bg-white text-orange-700 hover:bg-white/90">
              <Save className="h-4 w-4" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-white/70 mb-0.5">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className={highlight ? "text-2xl font-bold tabular-nums" : "text-xl font-bold tabular-nums"}>
        {value}
      </p>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  href?: string;
}) {
  return (
    <div className="text-sm">
      <div className="flex items-center gap-1.5 text-xs text-white/70 mb-1">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {value ? (
        href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium hover:underline truncate block"
          >
            {value}
          </a>
        ) : (
          <p className="font-medium truncate">{value}</p>
        )
      ) : (
        <p className="text-white/50 italic">未設定</p>
      )}
    </div>
  );
}
