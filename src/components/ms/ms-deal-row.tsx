"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Building2,
  Globe,
  Loader2,
  Check,
  X,
  Pencil,
  ExternalLink,
  CalendarCheck,
  CalendarClock,
  NotebookPen,
  User as UserIcon,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  STAGE_GROUP_LABEL,
  rowToStageDef,
  type PipelineStageRow,
  type StageGroup,
} from "@/lib/pipeline-stage";
import { leadSourceColor } from "@/lib/lead-source";
import type { MsLeadSource, MsUser } from "@/components/ms/ms-board";

export type MsContact = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

export type MsDeal = {
  id: string;
  title: string;
  pipelineStage: string | null;
  appointmentDate: string | null;
  meetingScheduledAt: string | null;
  leadSourceId: string | null;
  leadSourceMemo: string | null;
  ownerUserId: string | null;
  company: {
    id: string;
    name: string;
    websiteUrl: string | null;
    contacts: MsContact[];
  };
  owner: { id: string; name: string; avatarColor: string | null } | null;
  leadSource: { id: string; name: string } | null;
};

// ISO 文字列 → "YYYY-MM-DD"（DateInput 用）
function isoToDateStr(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
// "YYYY-MM-DD" → JST 0:00 の ISO 文字列（"" は null）
function dateStrToIso(s: string): string | null {
  if (!s) return null;
  return new Date(`${s}T00:00:00+09:00`).toISOString();
}

/**
 * ms管理の1商談行。クリックで展開し、初期フェーズの各フィールドをインライン編集できる。
 */
export function MsDealRow({
  deal,
  stages,
  leadSources,
  users,
  canEdit,
  onChanged,
  onDeleted,
}: {
  deal: MsDeal;
  stages: PipelineStageRow[];
  leadSources: MsLeadSource[];
  users: MsUser[];
  canEdit: boolean;
  onChanged: () => void;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 削除確認ダイアログ
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 全 group のステージ（ステージ変更で before 以外へも移せる）
  // すべての group は API では before のみ渡されるため、ここでは props.stages を使い、
  // 加えて移動先の候補として親から渡される stages（before のみ）+ 既存値を使う。
  // → 仕様：3ステージ間移動 + 他ステージへ移動可。other へ移すと一覧から外れる。

  // 行に表示する確定値（クイック編集の保存で楽観的に更新する）
  const [rowAppointmentDate, setRowAppointmentDate] = useState(
    isoToDateStr(deal.appointmentDate),
  );
  const [rowMeetingScheduledAt, setRowMeetingScheduledAt] = useState(
    isoToDateStr(deal.meetingScheduledAt),
  );
  const [rowLeadSourceId, setRowLeadSourceId] = useState(deal.leadSourceId ?? "");
  const [rowLeadSourceMemo, setRowLeadSourceMemo] = useState(
    deal.leadSourceMemo ?? "",
  );
  // 行表示用の担当者（クイック編集で楽観的に更新）
  const [rowOwnerUserId, setRowOwnerUserId] = useState(deal.ownerUserId ?? "");

  // クイック編集：現在編集中のフィールド（null = 全て表示モード）
  const [editingField, setEditingField] = useState<
    | "meetingScheduledAt"
    | "appointmentDate"
    | "leadSourceId"
    | "leadSourceMemo"
    | "ownerUserId"
    | null
  >(null);
  // クイック編集の下書き値
  const [draftMeeting, setDraftMeeting] = useState("");
  const [draftAppointment, setDraftAppointment] = useState("");
  const [draftLeadSourceId, setDraftLeadSourceId] = useState("");
  const [draftLeadSourceMemo, setDraftLeadSourceMemo] = useState("");
  const [draftOwnerUserId, setDraftOwnerUserId] = useState("");

  // 編集状態（展開フォーム用）
  const [stage, setStage] = useState(deal.pipelineStage ?? "");
  const [appointmentDate, setAppointmentDate] = useState(
    isoToDateStr(deal.appointmentDate),
  );
  const [meetingScheduledAt, setMeetingScheduledAt] = useState(
    isoToDateStr(deal.meetingScheduledAt),
  );
  const [leadSourceId, setLeadSourceId] = useState(deal.leadSourceId ?? "");
  const [leadSourceMemo, setLeadSourceMemo] = useState(deal.leadSourceMemo ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(deal.company.websiteUrl ?? "");

  // 主担当 Contact（無ければ作成）
  const primaryContact =
    deal.company.contacts.find((c) => c.isPrimary) ??
    deal.company.contacts[0] ??
    null;
  const [contactName, setContactName] = useState(primaryContact?.name ?? "");
  const [contactRole, setContactRole] = useState(primaryContact?.role ?? "");
  const [contactEmail, setContactEmail] = useState(primaryContact?.email ?? "");
  const [contactPhone, setContactPhone] = useState(primaryContact?.phone ?? "");
  const [ownerUserId, setOwnerUserId] = useState(deal.ownerUserId ?? "");

  const stageDef = stages.find((s) => s.value === deal.pipelineStage);
  const badgeClass = stageDef
    ? `${stageDef.badgeBg} ${stageDef.badgeText}`
    : "bg-zinc-100 text-zinc-700";

  // 行表示用の担当者（クイック編集での楽観的更新を反映）
  const rowOwner = users.find((u) => u.id === rowOwnerUserId) ?? null;

  // 単一フィールドのステージ即時変更（折りたたみ行のセレクト）
  async function changeStageOnly(newStage: string) {
    if (newStage === deal.pipelineStage) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipelineStage: newStage }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? "ステージ変更に失敗しました");
        return;
      }
      // タブ間移動 → 親で再フェッチ
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  // クイック編集を開始（下書きを現在値で初期化）
  function startQuickEdit(field: NonNullable<typeof editingField>) {
    setError(null);
    if (field === "meetingScheduledAt") setDraftMeeting(rowMeetingScheduledAt);
    if (field === "appointmentDate") setDraftAppointment(rowAppointmentDate);
    if (field === "leadSourceId") setDraftLeadSourceId(rowLeadSourceId);
    if (field === "leadSourceMemo") setDraftLeadSourceMemo(rowLeadSourceMemo);
    if (field === "ownerUserId") setDraftOwnerUserId(rowOwnerUserId);
    setEditingField(field);
  }

  function cancelQuickEdit() {
    setEditingField(null);
    setError(null);
  }

  // クイック編集の保存：単一フィールドのみ PATCH /api/deals/[id]
  async function saveQuickField(field: NonNullable<typeof editingField>) {
    setSaving(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (field === "meetingScheduledAt") {
        body = { meetingScheduledAt: dateStrToIso(draftMeeting) };
      } else if (field === "appointmentDate") {
        body = { appointmentDate: dateStrToIso(draftAppointment) };
      } else if (field === "leadSourceId") {
        body = { leadSourceId: draftLeadSourceId || null };
      } else if (field === "ownerUserId") {
        body = { ownerUserId: draftOwnerUserId || null };
      } else {
        body = { leadSourceMemo: draftLeadSourceMemo.trim() || null };
      }
      const r = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? "更新に失敗しました");
        return;
      }
      // 楽観的更新：行表示値と展開フォーム下書きの両方を同期
      if (field === "meetingScheduledAt") {
        setRowMeetingScheduledAt(draftMeeting);
        setMeetingScheduledAt(draftMeeting);
      } else if (field === "appointmentDate") {
        setRowAppointmentDate(draftAppointment);
        setAppointmentDate(draftAppointment);
      } else if (field === "leadSourceId") {
        setRowLeadSourceId(draftLeadSourceId);
        setLeadSourceId(draftLeadSourceId);
      } else if (field === "ownerUserId") {
        setRowOwnerUserId(draftOwnerUserId);
        setOwnerUserId(draftOwnerUserId);
      } else {
        setRowLeadSourceMemo(draftLeadSourceMemo.trim());
        setLeadSourceMemo(draftLeadSourceMemo.trim());
      }
      setEditingField(null);
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  // 展開フォームの一括保存
  async function saveAll() {
    if (isValidEmailOrEmpty(contactEmail) === false) {
      setError("メールアドレスの形式が不正です");
      return;
    }
    if (websiteUrl.trim() && !isValidHttpUrl(websiteUrl.trim())) {
      setError("HP URL は http:// または https:// で始まる正しいURLを入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 1. Deal 更新
      const dealRes = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineStage: stage || null,
          appointmentDate: dateStrToIso(appointmentDate),
          meetingScheduledAt: dateStrToIso(meetingScheduledAt),
          leadSourceId: leadSourceId || null,
          leadSourceMemo: leadSourceMemo.trim() || null,
          ownerUserId: ownerUserId || null,
        }),
      });
      if (!dealRes.ok) {
        const j = await dealRes.json().catch(() => ({}));
        setError(j.error ?? "商談の更新に失敗しました");
        return;
      }

      // 2. Company（HP URL）更新
      if ((websiteUrl.trim() || null) !== (deal.company.websiteUrl ?? null)) {
        await fetch(`/api/companies/${deal.company.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl: websiteUrl.trim() || null }),
        });
      }

      // 3. 顧客担当者 Contact 更新 or 作成
      const contactPayload = {
        name: contactName.trim() || "(名前未入力)",
        role: contactRole.trim() || null,
        email: contactEmail.trim() || null,
        phone: contactPhone.trim() || null,
      };
      const hasContactInput =
        contactName.trim() ||
        contactRole.trim() ||
        contactEmail.trim() ||
        contactPhone.trim();
      if (primaryContact) {
        await fetch(`/api/contacts/${primaryContact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(contactPayload),
        });
      } else if (hasContactInput) {
        await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: deal.company.id,
            ...contactPayload,
            isPrimary: true,
          }),
        });
      }

      // 行表示用の確定値も同期（クイック編集と展開フォームで値がズレないように）
      setRowAppointmentDate(appointmentDate);
      setRowMeetingScheduledAt(meetingScheduledAt);
      setRowLeadSourceId(leadSourceId);
      setRowLeadSourceMemo(leadSourceMemo.trim());
      setRowOwnerUserId(ownerUserId);

      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2000);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  // 商談（Deal）の削除：既存 DELETE /api/deals/[id]（permanent 指定なし = ソフト削除）に合わせる。
  async function deleteDeal() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const r = await fetch(`/api/deals/${deal.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setDeleteError(j.error ?? "削除に失敗しました");
        return;
      }
      setConfirmDelete(false);
      // 一覧から即時に取り除く（楽観的）。親側にも通知。
      if (onDeleted) onDeleted();
      else onChanged();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      {/* 折りたたみ行 */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-zinc-400 hover:text-zinc-600 shrink-0"
          aria-label={open ? "折りたたむ" : "展開する"}
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <Building2 className="h-4 w-4 text-amber-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <Link
            href={`/deals/${deal.id}`}
            className="text-sm font-semibold text-zinc-900 hover:text-amber-600 hover:underline truncate inline-flex items-center gap-1"
          >
            {deal.company.name}
            <ExternalLink className="h-3 w-3 text-zinc-400" />
          </Link>
          <p className="text-[11px] text-zinc-500 truncate">{deal.title}</p>
        </div>

        {/* 担当者 */}
        {rowOwner && (
          <span
            className="hidden sm:inline-flex items-center gap-1.5 text-[11px] shrink-0"
            title={`担当：${rowOwner.name}`}
          >
            <span
              className="w-5 h-5 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
              style={{ background: rowOwner.avatarColor ?? "#6366f1" }}
            >
              {rowOwner.name.charAt(0)}
            </span>
          </span>
        )}

        {/* ステージ即時変更セレクト */}
        <div className="shrink-0 w-[210px]">
          <Select
            value={deal.pipelineStage ?? ""}
            onValueChange={changeStageOnly}
            disabled={!canEdit || saving}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] ${badgeClass}`}
                >
                  {stageDef?.label ?? deal.pipelineStage ?? "未設定"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(["before", "after", "contract"] as const).map((g: StageGroup) => {
                const rows = stages.filter((s) => s.group === g && s.active);
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
        </div>

        {/* 削除 */}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
            disabled={saving || deleting}
            aria-label="この商談を削除"
            title="この商談を削除"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* クイック編集ストリップ：行を展開せず 5 項目を直接インライン編集 */}
      <div className="flex flex-wrap items-stretch gap-x-5 gap-y-2 border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5">
        {/* 商談日 */}
        <QuickField
          icon={<CalendarClock className="h-3.5 w-3.5 text-amber-500" />}
          label="商談日"
          editing={editingField === "meetingScheduledAt"}
          saving={saving}
          canEdit={canEdit}
          onEdit={() => startQuickEdit("meetingScheduledAt")}
          onSave={() => saveQuickField("meetingScheduledAt")}
          onCancel={cancelQuickEdit}
          display={
            rowMeetingScheduledAt
              ? rowMeetingScheduledAt.replaceAll("-", "/")
              : "—"
          }
        >
          <DateInput
            value={draftMeeting}
            onChange={setDraftMeeting}
            disabled={saving}
          />
        </QuickField>

        {/* アポ獲得日 */}
        <QuickField
          icon={<CalendarCheck className="h-3.5 w-3.5 text-emerald-500" />}
          label="アポ獲得日"
          editing={editingField === "appointmentDate"}
          saving={saving}
          canEdit={canEdit}
          onEdit={() => startQuickEdit("appointmentDate")}
          onSave={() => saveQuickField("appointmentDate")}
          onCancel={cancelQuickEdit}
          display={
            rowAppointmentDate
              ? rowAppointmentDate.replaceAll("-", "/")
              : "—"
          }
        >
          <DateInput
            value={draftAppointment}
            onChange={setDraftAppointment}
            disabled={saving}
          />
        </QuickField>

        {/* リード獲得経由 */}
        <QuickField
          icon={<Building2 className="h-3.5 w-3.5 text-indigo-500" />}
          label="リード獲得経由"
          editing={editingField === "leadSourceId"}
          saving={saving}
          canEdit={canEdit}
          onEdit={() => startQuickEdit("leadSourceId")}
          onSave={() => saveQuickField("leadSourceId")}
          onCancel={cancelQuickEdit}
          display={(() => {
            const ls = leadSources.find((s) => s.id === rowLeadSourceId);
            if (!ls) return "—";
            const c = leadSourceColor(ls.name);
            return (
              <span
                className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold border ${c.bg} ${c.text} ${c.border}`}
              >
                {ls.name}
              </span>
            );
          })()}
        >
          <Select
            value={draftLeadSourceId}
            onValueChange={setDraftLeadSourceId}
            disabled={saving}
          >
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="未選択">
                {(() => {
                  const ls = leadSources.find(
                    (s) => s.id === draftLeadSourceId,
                  );
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
        </QuickField>

        {/* リード獲得メモ */}
        <QuickField
          icon={<NotebookPen className="h-3.5 w-3.5 text-fuchsia-500" />}
          label="リード獲得メモ"
          editing={editingField === "leadSourceMemo"}
          saving={saving}
          canEdit={canEdit}
          onEdit={() => startQuickEdit("leadSourceMemo")}
          onSave={() => saveQuickField("leadSourceMemo")}
          onCancel={cancelQuickEdit}
          grow
          display={
            rowLeadSourceMemo ? (
              <span className="truncate" title={rowLeadSourceMemo}>
                {rowLeadSourceMemo}
              </span>
            ) : (
              "—"
            )
          }
        >
          <Input
            value={draftLeadSourceMemo}
            onChange={(e) => setDraftLeadSourceMemo(e.target.value)}
            placeholder="きっかけ / 紹介者など"
            className="h-9 w-[240px]"
            disabled={saving}
          />
        </QuickField>

        {/* 商談担当者（owner） */}
        <QuickField
          icon={<UserIcon className="h-3.5 w-3.5 text-sky-500" />}
          label="担当者"
          editing={editingField === "ownerUserId"}
          saving={saving}
          canEdit={canEdit}
          onEdit={() => startQuickEdit("ownerUserId")}
          onSave={() => saveQuickField("ownerUserId")}
          onCancel={cancelQuickEdit}
          display={
            rowOwner ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
                  style={{ background: rowOwner.avatarColor ?? "#6366f1" }}
                >
                  {rowOwner.name.charAt(0)}
                </span>
                {rowOwner.name}
              </span>
            ) : (
              "—"
            )
          }
        >
          <Select
            value={draftOwnerUserId || "__none__"}
            onValueChange={(v) => setDraftOwnerUserId(v === "__none__" ? "" : v)}
            disabled={saving}
          >
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="未選択" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未設定</SelectItem>
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
        </QuickField>

        {editingField === null && savedAt && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 self-center">
            <Check className="h-3.5 w-3.5" />
            保存しました
          </span>
        )}
        {editingField === null && error && (
          <span className="text-[11px] text-red-600 self-center">{error}</span>
        )}
      </div>

      {/* 展開フォーム */}
      {open && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 px-4 py-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* アポ獲得日 */}
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <CalendarCheck className="h-3.5 w-3.5 text-emerald-500" />
                アポ獲得日
              </Label>
              <DateInput
                value={appointmentDate}
                onChange={setAppointmentDate}
                disabled={!canEdit || saving}
              />
            </div>

            {/* 商談日（商談予定日） */}
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5 text-amber-500" />
                商談日（商談予定日）
              </Label>
              <DateInput
                value={meetingScheduledAt}
                onChange={setMeetingScheduledAt}
                disabled={!canEdit || saving}
              />
            </div>

            {/* リード獲得経由 */}
            <div className="space-y-1">
              <Label className="text-xs">リード獲得経由</Label>
              <Select
                value={leadSourceId}
                onValueChange={setLeadSourceId}
                disabled={!canEdit || saving}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="未選択">
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
            </div>

            {/* 主担当（自社） */}
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                <UserIcon className="h-3.5 w-3.5 text-sky-500" />
                主担当（自社）
              </Label>
              <Select
                value={ownerUserId}
                onValueChange={setOwnerUserId}
                disabled={!canEdit || saving}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="未選択" />
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
            </div>

            {/* HP URL */}
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs inline-flex items-center gap-1">
                <Globe className="h-3.5 w-3.5 text-orange-500" />
                HP URL
              </Label>
              <Input
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://..."
                className="h-9"
                disabled={!canEdit || saving}
              />
            </div>
          </div>

          {/* リード獲得メモ */}
          <div className="space-y-1">
            <Label className="text-xs inline-flex items-center gap-1">
              <NotebookPen className="h-3.5 w-3.5 text-fuchsia-500" />
              リード獲得メモ
            </Label>
            <textarea
              value={leadSourceMemo}
              onChange={(e) => setLeadSourceMemo(e.target.value)}
              placeholder="どのようにアポを取得したか / きっかけ / 紹介者など"
              disabled={!canEdit || saving}
              className="w-full min-h-[56px] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-300 focus:border-fuchsia-300 resize-y disabled:opacity-60"
            />
          </div>

          {/* 顧客側担当者 */}
          <div className="rounded-md border border-sky-200 bg-sky-50/40 p-3 space-y-2">
            <p className="text-[11px] font-bold text-sky-700">
              顧客側 担当者{primaryContact ? "" : "（未登録 → 保存で新規作成）"}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">氏名</Label>
                <Input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="例：山田 太郎"
                  className="h-9"
                  disabled={!canEdit || saving}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">役職</Label>
                <Input
                  value={contactRole}
                  onChange={(e) => setContactRole(e.target.value)}
                  placeholder="例：人事部長"
                  className="h-9"
                  disabled={!canEdit || saving}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">メールアドレス</Label>
                <Input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="taro@example.com"
                  className="h-9"
                  disabled={!canEdit || saving}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">電話番号</Label>
                <Input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="03-XXXX-XXXX"
                  className="h-9"
                  disabled={!canEdit || saving}
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {savedAt && (
              <span className="text-xs text-emerald-600 inline-flex items-center gap-1">
                <Check className="h-3.5 w-3.5" />
                保存しました
              </span>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={saveAll}
              disabled={!canEdit || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  保存中…
                </>
              ) : (
                "変更を保存"
              )}
            </Button>
          </div>
        </div>
      )}

      {/* 削除確認ダイアログ */}
      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (deleting) return;
          setConfirmDelete(o);
          if (!o) setDeleteError(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" />
              商談を削除しますか？
            </DialogTitle>
            <DialogDescription>
              「{deal.company.name}」の商談「{deal.title}」を削除します。
              この操作は ms管理 の一覧から除外されます。
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {deleteError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={deleteDeal}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  削除中…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  削除する
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * クイック編集の 1 項目。
 * 表示モード：アイコン + ラベル + 現在値 + 鉛筆。
 * 編集モード：children（入力UI）+ 保存 / キャンセル。
 */
function QuickField({
  icon,
  label,
  display,
  editing,
  saving,
  canEdit,
  grow,
  onEdit,
  onSave,
  onCancel,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  display: React.ReactNode;
  editing: boolean;
  saving: boolean;
  canEdit: boolean;
  grow?: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 ${grow ? "min-w-[200px] flex-1" : ""}`}
    >
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400">
        {icon}
        {label}
      </span>
      {editing ? (
        <div className="flex items-center gap-1">
          {children}
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            aria-label="保存"
            title="保存"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            aria-label="キャンセル"
            title="キャンセル"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 text-xs text-zinc-700 tabular-nums">
            {display}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`${label}を編集`}
              title={`${label}を編集`}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-amber-50 hover:text-amber-600"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function isValidEmailOrEmpty(s: string): boolean {
  if (!s.trim()) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
