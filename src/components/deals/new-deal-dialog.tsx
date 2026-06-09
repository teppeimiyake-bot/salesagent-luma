"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Sparkles,
  AlertCircle,
  Search,
  Building2,
  ChevronDown,
  ChevronRight,
  Check,
  NotebookPen,
  Mail,
  Phone,
  Globe,
  Trash2,
  Crown,
  UserPlus,
} from "lucide-react";
import { DateInput } from "@/components/ui/date-input";
import {
  STAGE_GROUP_LABEL,
  rowToStageDef,
  type PipelineStageRow,
  type StageGroup,
} from "@/lib/pipeline-stage";
import { leadSourceColor } from "@/lib/lead-source";
import { IndustryPicker } from "@/components/companies/industry-picker";

type Company = {
  id: string;
  name: string;
  industry?: string | null;
  websiteUrl?: string | null;
};
type SalesUser = { id: string; name: string; avatarColor?: string | null };
type LeadSource = { id: string; name: string; active: boolean; sortOrder: number };
type ExistingDeal = { id: string; title: string; productCount: number };
type Contact = {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
};

/**
 * 一度に追加する複数の担当者ドラフト（新規企業/既存企業 共通）
 * - 全フィールド任意
 * - name または email のいずれかが入っていれば作成対象
 * - 全行空欄なら何も作らない
 */
type ContactDraft = {
  uid: string; // ローカル一意キー（行のkey/削除用）
  name: string;
  email: string;
  phone: string;
  role: string;
  isDecisionMaker: boolean;
  note: string;
};

const DEFAULT_STAGE = "【商談前】商談予定";

function newContactDraft(): ContactDraft {
  return {
    uid: Math.random().toString(36).slice(2),
    name: "",
    email: "",
    phone: "",
    role: "",
    isDecisionMaker: false,
    note: "",
  };
}

// URL バリデータ
function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * ContactDraftのうち「名前 or メール のいずれかが入っているもの」を採用対象とする
 */
function activeDrafts(drafts: ContactDraft[]): ContactDraft[] {
  return drafts.filter(
    (d) => d.name.trim().length > 0 || d.email.trim().length > 0,
  );
}

export function NewDealDialog({ defaultCompanyId }: { defaultCompanyId?: string } = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // マスタ
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<SalesUser[]>([]);
  const [leadSources, setLeadSources] = useState<LeadSource[]>([]);
  const [stages, setStages] = useState<PipelineStageRow[]>([]);

  // 入力値
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? "");
  const [companySearch, setCompanySearch] = useState("");
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyHp, setNewCompanyHp] = useState("");
  const [newCompanyIndustry, setNewCompanyIndustry] = useState("");

  const [appointmentDate, setAppointmentDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [ownerUserId, setOwnerUserId] = useState("");
  const [pipelineStage, setPipelineStage] = useState<string>(DEFAULT_STAGE);
  const [leadSourceId, setLeadSourceId] = useState("");
  const [leadSourceMemo, setLeadSourceMemo] = useState("");

  // 連絡先：「既存連絡先から1件選ぶ」 or 「複数の新規担当者を一度に追加」 のハイブリッド
  const [contactMode, setContactMode] = useState<"new" | "existing">("new");
  const [existingContactId, setExistingContactId] = useState("");
  const [contactDrafts, setContactDrafts] = useState<ContactDraft[]>([
    newContactDraft(),
  ]);

  // 選択企業に対する既存連絡先
  const [existingContacts, setExistingContacts] = useState<Contact[]>([]);

  // 既存企業に websiteUrl が無い時の追加入力
  const [websiteUrlForExisting, setWebsiteUrlForExisting] = useState("");

  // UI 状態
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [existingDealForCompany, setExistingDealForCompany] = useState<ExistingDeal | null>(null);
  const [existingDealLoading, setExistingDealLoading] = useState(false);

  // マスタ取得
  // 重要：1つのマスタ取得が失敗しても他のドロップダウンが空にならないよう
  // Promise.all（全か無か）ではなく個別 try/catch + 個別パースにする。
  // （以前は Promise.all で1本でも失敗すると全マスタが空→送信ボタンが永久に
  //   無効化される＝「商談作成ボタンが押せない」本番障害の原因になっていた）
  const [masterError, setMasterError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadJson(url: string): Promise<unknown | null> {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }

    (async () => {
      const [c, u, ls, ps] = await Promise.all([
        loadJson("/api/companies"),
        loadJson("/api/users"),
        loadJson("/api/lead-sources"),
        loadJson("/api/pipeline-stages"),
      ]);
      if (cancelled) return;
      setMasterError(null);

      const companiesData = (c as { companies?: Company[] } | null)?.companies ?? [];
      const usersData =
        (u as { users?: (SalesUser & { permission?: string })[] } | null)?.users ?? [];
      const leadSourcesData =
        (ls as { leadSources?: LeadSource[] } | null)?.leadSources ?? [];
      const stagesData =
        (ps as { stages?: PipelineStageRow[] } | null)?.stages ?? [];

      setCompanies(companiesData);
      setUsers(usersData.filter((x) => x.permission !== "viewer"));
      setLeadSources(leadSourcesData);
      setStages(stagesData);

      // 既定ステージが取得済み一覧に無ければ先頭の有効ステージへ自動フォールバック
      if (stagesData.length > 0) {
        const hasDefault = stagesData.some(
          (s) => s.active && s.value === DEFAULT_STAGE,
        );
        if (!hasDefault) {
          const firstActive = stagesData.find((s) => s.active) ?? stagesData[0];
          if (firstActive) setPipelineStage(firstActive.value);
        }
      }

      // 送信に必須なマスタが空／取得失敗ならユーザーに理由を明示
      const problems: string[] = [];
      if (usersData.filter((x) => x.permission !== "viewer").length === 0) {
        problems.push("担当者");
      }
      if (leadSourcesData.filter((x) => x.active).length === 0) {
        problems.push("リード獲得経由");
      }
      if (u === null || ls === null || c === null || ps === null) {
        setMasterError(
          "マスタ情報の取得に失敗しました。通信状態を確認し、ダイアログを開き直してください。",
        );
      } else if (problems.length > 0) {
        setMasterError(
          `${problems.join("・")}が登録されていないため商談を作成できません。管理者メニューから登録してください。`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // 企業選択時、その企業に既にDealがあるかチェック + Contacts取得
  useEffect(() => {
    if (!companyId) {
      setExistingDealForCompany(null);
      setExistingContacts([]);
      setWebsiteUrlForExisting("");
      return;
    }
    setExistingDealLoading(true);
    Promise.all([
      fetch(`/api/deals?companyId=${companyId}`).then((r) => r.json()),
      fetch(`/api/contacts?companyId=${companyId}`).then((r) => r.json()),
    ])
      .then(([dealJ, contactJ]) => {
        const deals = dealJ.deals ?? [];
        if (deals.length > 0) {
          setExistingDealForCompany({
            id: deals[0].id,
            title: deals[0].title,
            productCount: deals[0].products?.length ?? 0,
          });
        } else {
          setExistingDealForCompany(null);
        }
        const contacts: Contact[] = contactJ.contacts ?? [];
        setExistingContacts(contacts);
        // 既存連絡先がある場合のデフォルト
        if (contacts.length > 0) {
          setContactMode("existing");
          setExistingContactId(contacts[0].id);
        } else {
          setContactMode("new");
          setExistingContactId("");
        }
      })
      .finally(() => setExistingDealLoading(false));
  }, [companyId]);

  // 検索ヒット企業
  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim();
    if (!q) return companies.slice(0, 20);
    const lq = q.toLowerCase();
    const startsWith: Company[] = [];
    const includes: Company[] = [];
    for (const c of companies) {
      const name = c.name.toLowerCase();
      if (name.startsWith(lq)) startsWith.push(c);
      else if (name.includes(lq)) includes.push(c);
    }
    return [...startsWith, ...includes].slice(0, 20);
  }, [companies, companySearch]);

  const selectedCompany = companies.find((c) => c.id === companyId);
  const selectedOwner = users.find((u) => u.id === ownerUserId);

  // タイトル自動生成
  const generatedTitle = useMemo(() => {
    if (!appointmentDate || !selectedCompany || !selectedOwner) return "";
    const d = appointmentDate.replaceAll("-", "/");
    return `${d} ${selectedCompany.name} ${selectedOwner.name}`;
  }, [appointmentDate, selectedCompany, selectedOwner]);

  // 既存企業の HP URL 不在チェック
  const existingCompanyMissingHp =
    !!selectedCompany && !selectedCompany.websiteUrl?.trim();

  function resetAll() {
    setCompanyId(defaultCompanyId ?? "");
    setCompanySearch("");
    setShowNewCompany(false);
    setNewCompanyName("");
    setNewCompanyHp("");
    setNewCompanyIndustry("");
    setAppointmentDate(new Date().toISOString().slice(0, 10));
    setOwnerUserId("");
    setPipelineStage(DEFAULT_STAGE);
    setLeadSourceId("");
    setLeadSourceMemo("");
    setContactMode("new");
    setExistingContactId("");
    setContactDrafts([newContactDraft()]);
    setExistingContacts([]);
    setWebsiteUrlForExisting("");
    setSubmitError(null);
    setMasterError(null);
  }

  function pickCompany(id: string) {
    setCompanyId(id);
    setCompanySearch("");
    setShowNewCompany(false);
  }

  function patchDraft(uid: string, patch: Partial<ContactDraft>) {
    setContactDrafts((prev) =>
      prev.map((d) => (d.uid === uid ? { ...d, ...patch } : d)),
    );
  }
  function addDraft() {
    setContactDrafts((prev) => [...prev, newContactDraft()]);
  }
  function removeDraft(uid: string) {
    setContactDrafts((prev) => {
      const next = prev.filter((d) => d.uid !== uid);
      return next.length === 0 ? [newContactDraft()] : next;
    });
  }

  /**
   * 担当者ドラフトのバリデーション。
   * - メール形式チェック（入力ありの行のみ）
   * - name も email も両方空 → スキップ（採用対象外）
   * @returns エラーメッセージ or null（OK）
   */
  function validateDrafts(drafts: ContactDraft[]): string | null {
    for (const d of drafts) {
      if (!d.name.trim() && !d.email.trim()) continue; // 空行はスキップ
      if (d.email.trim() && !isValidEmail(d.email.trim())) {
        return `担当者メールアドレスの形式が不正です：${d.email}`;
      }
    }
    return null;
  }

  async function createNewCompanyInline() {
    if (!newCompanyName) return;
    if (!newCompanyHp.trim()) {
      setSubmitError("HP URL は必須です");
      return;
    }
    if (!isValidHttpUrl(newCompanyHp.trim())) {
      setSubmitError("HP URL は http:// または https:// で始まる正しいURLを入力してください");
      return;
    }
    // 担当者ドラフトのバリデーション
    const err = validateDrafts(contactDrafts);
    if (err) {
      setSubmitError(err);
      return;
    }

    setLoading(true);
    setSubmitError(null);
    try {
      const r = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCompanyName,
          industry: newCompanyIndustry || undefined,
          websiteUrl: newCompanyHp.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setSubmitError(j.error ?? "企業作成に失敗しました");
        return;
      }
      const created: Company = j.company;
      setCompanies((prev) => [created, ...prev]);
      setCompanyId(created.id);

      // 担当者ドラフト一括作成（採用行のみ）
      const drafts = activeDrafts(contactDrafts);
      const createdContacts: Contact[] = [];
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const cr = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: created.id,
            name: d.name.trim() || (d.email.trim().split("@")[0] ?? "(名前未入力)"),
            role: d.role.trim() || undefined,
            email: d.email.trim() || undefined,
            phone: d.phone.trim() || undefined,
            note: d.note.trim() || undefined,
            isPrimary: i === 0, // 1行目を主担当にする
            isDecisionMaker: d.isDecisionMaker,
          }),
        });
        if (cr.ok) {
          const cj = await cr.json();
          if (cj.contact) createdContacts.push(cj.contact);
        }
      }
      if (createdContacts.length > 0) {
        setExistingContacts((prev) => [...createdContacts, ...prev]);
        setContactMode("existing");
        setExistingContactId(createdContacts[0].id);
      }

      setShowNewCompany(false);
      setNewCompanyName("");
      setNewCompanyHp("");
      setNewCompanyIndustry("");
      // contactDraftsは選択企業フェーズでも継続利用するためリセットしない
      // （既存企業モードに移った後にユーザーが追加担当者を入力できるように）
      setContactDrafts([newContactDraft()]);
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!companyId) {
      setSubmitError("企業を選択してください");
      return;
    }
    if (!ownerUserId) {
      setSubmitError("担当者は必須です");
      return;
    }
    if (!leadSourceId) {
      setSubmitError("リード獲得経由は必須です");
      return;
    }
    if (!appointmentDate) {
      setSubmitError("初回商談日を入力してください");
      return;
    }

    // 既存企業に HP URL が無い場合：必須
    if (existingCompanyMissingHp) {
      if (!websiteUrlForExisting.trim()) {
        setSubmitError("選択中の企業に HP URL が登録されていません。HP URL を入力してください");
        return;
      }
      if (!isValidHttpUrl(websiteUrlForExisting.trim())) {
        setSubmitError("HP URL は http:// または https:// で始まる正しいURLを入力してください");
        return;
      }
    }

    // 連絡先バリデーション（new モード時のみドラフトをチェック）
    if (contactMode === "new") {
      const err = validateDrafts(contactDrafts);
      if (err) {
        setSubmitError(err);
        return;
      }
    }

    setLoading(true);
    try {
      // 1. 既存企業 HP URL の補完
      if (existingCompanyMissingHp && websiteUrlForExisting.trim()) {
        await fetch(`/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl: websiteUrlForExisting.trim() }),
        });
      }

      // 2. 連絡先：複数ドラフトを一括作成（contactMode === "new" のみ）
      if (contactMode === "new") {
        const drafts = activeDrafts(contactDrafts);
        for (let i = 0; i < drafts.length; i++) {
          const d = drafts[i];
          await fetch("/api/contacts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId,
              name: d.name.trim() || (d.email.trim().split("@")[0] ?? "(名前未入力)"),
              role: d.role.trim() || null,
              email: d.email.trim() || null,
              phone: d.phone.trim() || null,
              note: d.note.trim() || undefined,
              isPrimary: existingContacts.length === 0 && i === 0,
              isDecisionMaker: d.isDecisionMaker,
            }),
          });
        }
      }
      // contactMode === "existing" の場合、特に連絡先操作は不要
      // （Dealにcontact紐付けカラムは無いため、選択値は表示用のヒント）

      // 3. 商談作成
      const title = generatedTitle || "新規商談";
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          title,
          ownerUserId,
          leadSourceId,
          leadSourceMemo: leadSourceMemo.trim() || undefined,
          pipelineStage,
          appointmentDate: new Date(`${appointmentDate}T00:00:00+09:00`).toISOString(),
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.deal) {
        setSubmitError(j.error ?? "作成に失敗しました");
        return;
      }
      setOpen(false);
      resetAll();
      router.push(`/deals/${j.deal.id}`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const required = (
    <span className="text-rose-500 ml-0.5" title="必須">
      *
    </span>
  );

  // 担当者ドラフト編集UI（新規企業/既存企業 両モードで使う共通パーツ）
  const draftsEditor = (
    <div className="space-y-2">
      {contactDrafts.map((d, idx) => (
        <div
          key={d.uid}
          className="rounded-md border border-sky-200 bg-white p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold text-sky-700">
              担当者 #{idx + 1}
              <span className="text-zinc-400 font-normal ml-1">
                （氏名 or メール のいずれか入力で登録）
              </span>
            </p>
            {contactDrafts.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeDraft(d.uid)}
                className="h-7 px-2 text-zinc-400 hover:text-rose-500"
                title="この担当者を削除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">氏名</Label>
              <Input
                value={d.name}
                onChange={(e) => patchDraft(d.uid, { name: e.target.value })}
                placeholder="例：山田 太郎"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">役職</Label>
              <Input
                value={d.role}
                onChange={(e) => patchDraft(d.uid, { role: e.target.value })}
                placeholder="例：人事部長"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <Mail className="h-3 w-3 text-sky-600" />
                メールアドレス
              </Label>
              <Input
                type="email"
                value={d.email}
                onChange={(e) => patchDraft(d.uid, { email: e.target.value })}
                placeholder="taro@example.com"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <Phone className="h-3 w-3 text-sky-600" />
                電話番号
              </Label>
              <Input
                value={d.phone}
                onChange={(e) => patchDraft(d.uid, { phone: e.target.value })}
                placeholder="03-XXXX-XXXX"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
            <label className="md:col-span-1 inline-flex items-center gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={d.isDecisionMaker}
                onChange={(e) =>
                  patchDraft(d.uid, { isDecisionMaker: e.target.checked })
                }
              />
              <Crown className="h-3.5 w-3.5 text-amber-500" />
              決裁者
            </label>
            <div className="md:col-span-2 space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <NotebookPen className="h-3 w-3 text-fuchsia-500" />
                メモ
              </Label>
              <Input
                value={d.note}
                onChange={(e) => patchDraft(d.uid, { note: e.target.value })}
                placeholder="関係性 / 紹介者 / 押さえどころ など"
                className="h-9"
              />
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addDraft}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-dashed border-sky-300 text-sky-700 text-xs font-semibold hover:bg-sky-50 transition-colors"
      >
        <UserPlus className="h-3.5 w-3.5" />+ 担当者を追加
      </button>
      <p className="text-[10px] text-zinc-500">
        全行が空欄の場合、連絡先は何も作成されません。
      </p>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetAll();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="h-4 w-4" />
          新規商談
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5">
              <Sparkles className="h-4 w-4" />
            </span>
            新規商談を作成
          </DialogTitle>
          <DialogDescription>
            商談タイトルは「初回商談日 + 顧客名 + 担当者名」で自動生成されます。
            プロダクト構成は商談作成後に詳細画面から追加してください。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          {/* 1. 企業選択 */}
          <section className="space-y-2 rounded-lg border-2 border-orange-200 bg-orange-50/30 p-4">
            <Label className="text-sm font-bold flex items-center gap-1.5">
              <Building2 className="h-4 w-4 text-orange-600" />
              企業 {required}
            </Label>
            {selectedCompany ? (
              <div className="flex items-center justify-between rounded-md bg-white border border-orange-300 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Check className="h-4 w-4 text-orange-600 shrink-0" />
                  <span className="font-bold text-base truncate">{selectedCompany.name}</span>
                  {selectedCompany.industry && (
                    <span className="text-xs text-zinc-500 truncate">
                      ／ {selectedCompany.industry}
                    </span>
                  )}
                  {selectedCompany.websiteUrl ? (
                    <a
                      href={selectedCompany.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-orange-600 hover:underline inline-flex items-center gap-0.5"
                    >
                      <Globe className="h-3 w-3" />
                      HP
                    </a>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCompanyId("");
                    setExistingDealForCompany(null);
                    setExistingContacts([]);
                  }}
                  className="text-xs text-zinc-500 hover:text-rose-600"
                >
                  変更
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <Input
                    value={companySearch}
                    onChange={(e) => setCompanySearch(e.target.value)}
                    placeholder="企業名で検索（前方一致 + 部分一致）"
                    className="pl-9 h-10 text-sm"
                  />
                </div>
                {filteredCompanies.length > 0 && (
                  <div className="max-h-56 overflow-y-auto rounded-md border border-zinc-200 bg-white divide-y divide-zinc-100">
                    {filteredCompanies.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pickCompany(c.id)}
                        className="w-full text-left px-3 py-2 hover:bg-orange-50 transition-colors flex items-center gap-2"
                      >
                        <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span className="text-sm font-medium truncate">{c.name}</span>
                        {c.industry && (
                          <span className="text-xs text-zinc-500 truncate ml-auto">
                            {c.industry}
                          </span>
                        )}
                        {!c.websiteUrl && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 ml-1">
                            HP未登録
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {filteredCompanies.length === 0 && companySearch && (
                  <p className="text-xs text-zinc-500 px-1">該当企業なし</p>
                )}

                {/* ＋新規企業を登録 */}
                <button
                  type="button"
                  onClick={() => setShowNewCompany((v) => !v)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border-2 border-dashed border-orange-400 text-orange-700 font-bold text-sm hover:bg-orange-100 transition-colors"
                >
                  {showNewCompany ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  該当企業がない場合 → ＋ 新規企業を登録
                </button>

                {showNewCompany && (
                  <div className="space-y-3 rounded-md bg-white border border-orange-300 p-3">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <div className="space-y-1 md:col-span-3">
                        <Label className="text-xs">社名 {required}</Label>
                        <Input
                          value={newCompanyName}
                          onChange={(e) => setNewCompanyName(e.target.value)}
                          placeholder="例：株式会社オオヨドコーポレーション"
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <Label className="text-xs">
                          HP URL {required}
                          <span className="ml-1 text-[10px] text-zinc-400">http(s)://</span>
                        </Label>
                        <Input
                          value={newCompanyHp}
                          onChange={(e) => setNewCompanyHp(e.target.value)}
                          placeholder="https://..."
                          className="h-9"
                          required
                        />
                      </div>
                      <div className="space-y-1.5 md:col-span-3">
                        <Label className="text-xs">業種（複数選択可）</Label>
                        <IndustryPicker
                          value={newCompanyIndustry}
                          onChange={setNewCompanyIndustry}
                        />
                      </div>
                    </div>

                    {/* 顧客の担当者（任意・複数同時登録） */}
                    <div className="border-t border-orange-200 pt-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <NotebookPen className="h-3.5 w-3.5 text-orange-700" />
                        <p className="text-xs font-bold text-orange-900">
                          顧客の担当者（任意・複数同時登録）
                        </p>
                      </div>
                      {draftsEditor}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={
                          !newCompanyName || !newCompanyHp.trim() || loading
                        }
                        onClick={createNewCompanyInline}
                      >
                        企業 + 担当者を作成して選択
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 既存企業の HP URL 補完 */}
            {existingCompanyMissingHp && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-xs space-y-1 flex-1">
                    <p className="font-semibold text-amber-900">
                      この企業の HP URL が未登録です（必須）
                    </p>
                    <p className="text-amber-800">
                      下に入力するとこの企業マスタも更新されます。
                    </p>
                  </div>
                </div>
                <Input
                  value={websiteUrlForExisting}
                  onChange={(e) => setWebsiteUrlForExisting(e.target.value)}
                  placeholder="https://..."
                  className="h-9 bg-white"
                />
              </div>
            )}

            {/* 既存Deal警告 */}
            {existingDealForCompany && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-xs space-y-1.5 flex-1">
                    <p className="font-semibold text-amber-900">
                      この企業には既に商談があります（プロダクト
                      {existingDealForCompany.productCount}件）
                    </p>
                    <p className="text-amber-800">タイトル: {existingDealForCompany.title}</p>
                    <p className="text-amber-800">
                      別案件であればこのまま新規商談を作成できます。既存商談の続きなら下のボタンから開いてください。
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => router.push(`/deals/${existingDealForCompany.id}`)}
                    >
                      既存商談を開く
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {existingDealLoading && (
              <p className="text-xs text-zinc-500">既存商談・連絡先を確認中…</p>
            )}
          </section>

          {/* 2. 初回商談日 */}
          <section className="space-y-1.5">
            <Label className="text-sm font-semibold">
              初回商談日 {required}
            </Label>
            <DateInput
              value={appointmentDate}
              onChange={(v) => setAppointmentDate(v)}
              disabled={loading}
            />
          </section>

          {/* 3. 担当者（必須） */}
          <section className="space-y-1.5">
            <Label className="text-sm font-semibold">
              担当者 {required}
            </Label>
            <Select value={ownerUserId} onValueChange={setOwnerUserId}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="担当者を選択">
                  {selectedOwner && (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-5 h-5 rounded-full text-white text-[11px] font-bold flex items-center justify-center"
                        style={{ background: selectedOwner.avatarColor ?? "#6366f1" }}
                      >
                        {selectedOwner.name.charAt(0)}
                      </span>
                      <span className="font-semibold">{selectedOwner.name}</span>
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
                        style={{ background: u.avatarColor ?? "#6366f1" }}
                      >
                        {u.name.charAt(0)}
                      </span>
                      {u.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {/* 4. 商談プロセスステージ（DBから動的に） */}
          <section className="space-y-1.5">
            <Label className="text-sm font-semibold">商談プロセスステージ</Label>
            <Select value={pipelineStage} onValueChange={setPipelineStage}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["before", "after", "contract"] as const).map((g: StageGroup) => {
                  // value 空の行は Radix SelectItem が例外を投げる（空value禁止）ため除外。
                  const rows = stages.filter(
                    (s) => s.group === g && s.active && s.value,
                  );
                  if (rows.length === 0) return null;
                  return (
                    <div key={g}>
                      <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                        {STAGE_GROUP_LABEL[g]}
                      </div>
                      {rows.map((row) => {
                        const s = rowToStageDef(row);
                        return (
                          <SelectItem key={row.id} value={s.value}>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${s.bg} ${s.text}`}
                            >
                              {s.label}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </div>
                  );
                })}
              </SelectContent>
            </Select>
          </section>

          {/* 5. リード獲得経由（必須） */}
          <section className="space-y-1.5">
            <Label className="text-sm font-semibold">
              リード獲得経由 {required}
            </Label>
            <Select value={leadSourceId} onValueChange={setLeadSourceId}>
              <SelectTrigger className="h-10">
                <SelectValue placeholder="リード獲得経由を選択">
                  {(() => {
                    const ls = leadSources.find((s) => s.id === leadSourceId);
                    if (!ls) return null;
                    const c = leadSourceColor(ls.name);
                    return (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${c.bg} ${c.text} ${c.border}`}
                      >
                        {ls.name}
                      </span>
                    );
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {leadSources.map((ls) => {
                  const c = leadSourceColor(ls.name);
                  return (
                    <SelectItem key={ls.id} value={ls.id}>
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${c.bg} ${c.text} ${c.border}`}
                      >
                        {ls.name}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {leadSources.length === 0 && (
              <p className="text-xs text-zinc-500">
                リード獲得経由が登録されていません。管理者メニュー →「リード獲得経由」から追加してください。
              </p>
            )}
          </section>

          {/* 6. リード獲得メモ */}
          <section className="space-y-1.5">
            <Label className="text-sm font-semibold inline-flex items-center gap-1.5">
              <NotebookPen className="h-3.5 w-3.5 text-fuchsia-500" />
              リード獲得メモ
              <span className="text-[10px] font-normal text-zinc-400">任意</span>
            </Label>
            <textarea
              value={leadSourceMemo}
              onChange={(e) => setLeadSourceMemo(e.target.value)}
              placeholder="どのようにアポを取得したか / 会話のきっかけ / 紹介者など"
              className="w-full min-h-[64px] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-300 focus:border-fuchsia-300 resize-y"
            />
          </section>

          {/* 7. 顧客情報（連絡先） */}
          {companyId && (
            <section className="space-y-2 rounded-lg border-2 border-sky-200 bg-sky-50/30 p-4">
              <Label className="text-sm font-bold flex items-center gap-1.5">
                <Mail className="h-4 w-4 text-sky-600" />
                顧客情報（連絡先）
                <span className="text-[10px] font-normal text-zinc-400 ml-1">任意</span>
              </Label>

              {existingContacts.length > 0 && (
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setContactMode("existing")}
                    className={`px-2.5 py-1 rounded ${
                      contactMode === "existing"
                        ? "bg-sky-600 text-white font-bold"
                        : "bg-white border border-zinc-200 text-zinc-600"
                    }`}
                  >
                    既存連絡先から選択（{existingContacts.length}件）
                  </button>
                  <button
                    type="button"
                    onClick={() => setContactMode("new")}
                    className={`px-2.5 py-1 rounded ${
                      contactMode === "new"
                        ? "bg-sky-600 text-white font-bold"
                        : "bg-white border border-zinc-200 text-zinc-600"
                    }`}
                  >
                    新規連絡先を追加（複数可）
                  </button>
                </div>
              )}

              {contactMode === "existing" && existingContacts.length > 0 ? (
                <Select value={existingContactId} onValueChange={setExistingContactId}>
                  <SelectTrigger className="h-10 bg-white">
                    <SelectValue placeholder="連絡先を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {existingContacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="font-semibold">{c.name}</span>
                        {c.role && <span className="text-xs text-zinc-500 ml-1">／ {c.role}</span>}
                        {c.email && <span className="text-xs text-zinc-500 ml-2">{c.email}</span>}
                        {c.isPrimary && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                            主
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                draftsEditor
              )}
            </section>
          )}

          {/* タイトルプレビュー */}
          <section className="rounded-lg bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200 p-4 space-y-1">
            <Label className="text-xs flex items-center gap-1 text-orange-700">
              <Sparkles className="h-3 w-3" />
              商談タイトル（自動生成）
            </Label>
            <p className="text-base font-bold text-zinc-900 tabular-nums">
              {generatedTitle || (
                <span className="text-zinc-400 font-normal text-sm">
                  企業 + 初回商談日 + 担当者 を入力すると自動生成されます
                </span>
              )}
            </p>
          </section>

          {masterError && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {masterError}
            </p>
          )}

          {submitError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                loading ||
                !companyId ||
                !ownerUserId ||
                !leadSourceId ||
                !appointmentDate ||
                // 既存商談があっても作成は許可する（警告は表示するが押下はブロックしない）。
                // 2026-05-03 のNotion一括取込で大半の企業に既存商談が付いたため、
                // ここで !!existingDealForCompany を禁止条件に入れると新規商談を作れなくなる。
                (existingCompanyMissingHp && !websiteUrlForExisting.trim())
              }
            >
              {loading ? "作成中..." : "新規商談を作成"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
