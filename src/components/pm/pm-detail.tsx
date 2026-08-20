"use client";

import { useCallback, useState } from "react";
import {
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Youtube,
  Instagram,
  Plus,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { type ProductionStatus } from "@/lib/production";
import { StaffPicker } from "@/components/pm/staff-picker";
import { UserPicker } from "@/components/pm/user-picker";
import { StatusPill, StatusSelect } from "@/components/pm/status-pill";
import { toReadableText } from "@/lib/text-format";

type SnsPlatform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";

type DetailSnsAccount = {
  id: string;
  platform: SnsPlatform;
  accountId: string | null;
  password: string | null;
  profileUrl: string | null;
  miyakePcLogin: boolean;
};

export type PmDetailData = {
  project: {
    id: string;
    dealId: string;
    category: string | null;
    projectName: string;
    status: ProductionStatus;
    pmName: string | null;
    directorName: string | null;
    cameraName: string | null;
    editorName: string | null;
    note: string | null;
    storyboardUrl: string | null;
    shootingScheduleUrl: string | null;
    totalPosts: string | null;
    serviceStartMonth: string | null;
    serviceEndMonth: string | null;
    mgmtSheetUrl: string | null;
    companyName: string | null;
    planName: string | null;
    productName: string | null;
    snsAccounts: DetailSnsAccount[];
  };
  meetings: {
    id: string;
    title: string | null;
    meetingDate: string;
    minutes: string | null;
    summary: string | null;
    recordingUrl: string | null;
  }[];
  proposals: {
    id: string;
    name: string;
    sourceType: string;
    fileUrl: string;
    version: string | null;
    description: string | null;
    createdAt: string;
  }[];
  isSns: boolean;
  canEdit: boolean;
  canSeeSecret: boolean;
};

const PLATFORMS: { key: SnsPlatform; label: string; icon: React.ElementType }[] = [
  { key: "YOUTUBE", label: "YouTube", icon: Youtube },
  { key: "INSTAGRAM", label: "Instagram", icon: Instagram },
  { key: "TIKTOK", label: "TikTok", icon: ExternalLink },
];

function isoDay(s: string | null): string {
  return s ? s.slice(0, 10) : "";
}
function isoMonth(s: string | null): string {
  return s ? s.slice(0, 7) : "";
}

export function PmDetail({ data }: { data: PmDetailData }) {
  const { canEdit, canSeeSecret, isSns } = data;
  const [project, setProject] = useState(data.project);
  const [meetings, setMeetings] = useState(data.meetings);
  const [saving, setSaving] = useState(false);

  const patchProject = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/pm/${data.project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.project) {
          setProject((prev) => ({
            ...prev,
            status: j.project.status,
            pmName: j.project.pmName,
            directorName: j.project.directorName,
            cameraName: j.project.cameraName,
            editorName: j.project.editorName,
            note: j.project.note,
            storyboardUrl: j.project.storyboardUrl,
            shootingScheduleUrl: j.project.shootingScheduleUrl,
            totalPosts: j.project.totalPosts,
            serviceStartMonth: j.project.serviceStartMonth,
            serviceEndMonth: j.project.serviceEndMonth,
            mgmtSheetUrl: j.project.mgmtSheetUrl,
          }));
        }
      }
    } finally {
      setSaving(false);
    }
  }, [data.project.id]);

  return (
    <div className="space-y-5 max-w-5xl">
      {/* ヘッダーカード：ステータス・担当・基本情報 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate">{project.companyName ?? project.projectName}</CardTitle>
            <p className="text-xs text-zinc-500 mt-1 truncate">{project.projectName}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {project.planName && <Badge variant="secondary">{project.planName}</Badge>}
            {saving && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="ステータス">
            {canEdit ? (
              <StatusSelect
                status={project.status}
                category={project.category}
                onChange={(v) => patchProject({ status: v })}
              />
            ) : (
              <StatusPill status={project.status} />
            )}
          </Field>
          <Field label="PM担当">
            <UserPicker
              value={project.pmName}
              canEdit={canEdit}
              onChange={(v) => patchProject({ pmName: v })}
              width="w-[200px]"
            />
          </Field>
          {!isSns && (
            <>
              <Field label="カメラ">
                <StaffPicker
                  role="camera"
                  value={project.cameraName}
                  canEdit={canEdit}
                  onChange={(v) => patchProject({ cameraName: v })}
                  width="w-[200px]"
                />
              </Field>
              <Field label="編集">
                <StaffPicker
                  role="editor"
                  value={project.editorName}
                  canEdit={canEdit}
                  onChange={(v) => patchProject({ editorName: v })}
                  width="w-[200px]"
                />
              </Field>
            </>
          )}
          {isSns && (
            <>
              <EditableText
                label="総投稿本数"
                value={project.totalPosts}
                canEdit={canEdit}
                onSave={(v) => patchProject({ totalPosts: v })}
              />
              <EditableMonth
                label="提供開始月"
                value={project.serviceStartMonth}
                canEdit={canEdit}
                onSave={(v) => patchProject({ serviceStartMonth: v })}
              />
              <EditableMonth
                label="提供終了月"
                value={project.serviceEndMonth}
                canEdit={canEdit}
                onSave={(v) => patchProject({ serviceEndMonth: v })}
              />
            </>
          )}
          <div className="sm:col-span-2">
            <EditableText
              label="備考"
              value={project.note}
              canEdit={canEdit}
              onSave={(v) => patchProject({ note: v })}
              wide
            />
          </div>
        </CardContent>
      </Card>

      {/* リンク類：絵コンテ/香盤表（映像） or 管理シート（SNS） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">スプレッドシート・リンク</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isSns ? (
            <EditableUrl
              label="管理シート（スケジュール・企画書・香盤表）"
              value={project.mgmtSheetUrl}
              canEdit={canEdit}
              onSave={(v) => patchProject({ mgmtSheetUrl: v })}
            />
          ) : (
            <>
              <EditableUrl
                label="絵コンテ"
                value={project.storyboardUrl}
                canEdit={canEdit}
                onSave={(v) => patchProject({ storyboardUrl: v })}
              />
              <EditableUrl
                label="香盤表"
                value={project.shootingScheduleUrl}
                canEdit={canEdit}
                onSave={(v) => patchProject({ shootingScheduleUrl: v })}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* SNSアカウント表（SNSのみ） */}
      {isSns && (
        <SnsAccountsCard
          projectId={project.id}
          initial={project.snsAccounts}
          canEdit={canEdit}
          canSeeSecret={canSeeSecret}
        />
      )}

      {/* 提案企画書 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">提案企画書</CardTitle>
        </CardHeader>
        <CardContent>
          {data.proposals.length === 0 ? (
            <p className="text-sm text-zinc-400">この商談に紐づく提案企画書はありません。</p>
          ) : (
            <ul className="space-y-2">
              {data.proposals.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-zinc-400 shrink-0" />
                  <a
                    href={d.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 hover:underline truncate"
                  >
                    {d.name}
                  </a>
                  {d.version && <Badge variant="secondary">{d.version}</Badge>}
                  <span className="text-xs text-zinc-400 ml-auto shrink-0">
                    {isoDay(d.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 打ち合わせ議事録 */}
      <MeetingsCard
        projectId={project.id}
        meetings={meetings}
        setMeetings={setMeetings}
        canEdit={canEdit}
      />
    </div>
  );
}

// ---------- 小物 ----------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function EditableText({
  label,
  value,
  canEdit,
  onSave,
  wide,
}: {
  label: string;
  value: string | null;
  canEdit: boolean;
  onSave: (v: string | null) => void;
  wide?: boolean;
}) {
  return (
    <Field label={label}>
      {canEdit ? (
        <Input
          defaultValue={value ?? ""}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== value) onSave(v);
          }}
          className={`h-8 ${wide ? "w-full" : "w-[200px]"}`}
        />
      ) : (
        <span className="text-sm">{value ?? "—"}</span>
      )}
    </Field>
  );
}

function EditableMonth({
  label,
  value,
  canEdit,
  onSave,
}: {
  label: string;
  value: string | null;
  canEdit: boolean;
  onSave: (v: string | null) => void;
}) {
  return (
    <Field label={label}>
      {canEdit ? (
        <Input
          type="month"
          defaultValue={isoMonth(value)}
          onBlur={(e) => {
            const v = e.target.value || null;
            const cur = isoMonth(value) || null;
            if (v !== cur) onSave(v ? `${v}-01` : null);
          }}
          className="h-8 w-[160px]"
        />
      ) : (
        <span className="text-sm tabular-nums">{isoMonth(value) || "—"}</span>
      )}
    </Field>
  );
}

function EditableUrl({
  label,
  value,
  canEdit,
  onSave,
}: {
  label: string;
  value: string | null;
  canEdit: boolean;
  onSave: (v: string | null) => void;
}) {
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1 flex items-center gap-2">
        {label}
        {value && (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
          >
            開く <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {canEdit ? (
        <Input
          defaultValue={value ?? ""}
          placeholder="https://docs.google.com/..."
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== value) onSave(v);
          }}
          className="h-8 w-full"
        />
      ) : (
        <span className="text-sm break-all">{value ?? "—"}</span>
      )}
    </div>
  );
}

// ---------- SNSアカウント ----------

function SnsAccountsCard({
  projectId,
  initial,
  canEdit,
  canSeeSecret,
}: {
  projectId: string;
  initial: DetailSnsAccount[];
  canEdit: boolean;
  canSeeSecret: boolean;
}) {
  const [accounts, setAccounts] = useState<Record<SnsPlatform, DetailSnsAccount | undefined>>(() => {
    const m: Record<string, DetailSnsAccount> = {};
    for (const a of initial) m[a.platform] = a;
    return m as Record<SnsPlatform, DetailSnsAccount | undefined>;
  });
  const [savingPlat, setSavingPlat] = useState<SnsPlatform | null>(null);

  const save = useCallback(
    async (platform: SnsPlatform, body: Partial<DetailSnsAccount>) => {
      setSavingPlat(platform);
      try {
        const res = await fetch(`/api/pm/${projectId}/sns-accounts`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform, ...body }),
        });
        if (res.ok) {
          const j = await res.json();
          if (j.account) {
            setAccounts((prev) => ({
              ...prev,
              [platform]: { ...prev[platform], ...j.account } as DetailSnsAccount,
            }));
          }
        }
      } finally {
        setSavingPlat(null);
      }
    },
    [projectId],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">媒体別アカウント</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canSeeSecret && (
          <p className="text-xs text-amber-600">
            パスワードの閲覧には user 権限以上が必要です。
          </p>
        )}
        {PLATFORMS.map(({ key, label, icon: Icon }) => (
          <SnsAccountRow
            key={key}
            platform={key}
            label={label}
            Icon={Icon}
            account={accounts[key]}
            canEdit={canEdit}
            canSeeSecret={canSeeSecret}
            saving={savingPlat === key}
            onSave={(body) => save(key, body)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function SnsAccountRow({
  platform,
  label,
  Icon,
  account,
  canEdit,
  canSeeSecret,
  saving,
  onSave,
}: {
  platform: SnsPlatform;
  label: string;
  Icon: React.ElementType;
  account: DetailSnsAccount | undefined;
  canEdit: boolean;
  canSeeSecret: boolean;
  saving: boolean;
  onSave: (body: Partial<DetailSnsAccount>) => void;
}) {
  const [showPass, setShowPass] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="flex items-center gap-2 mb-2 text-sm font-medium text-zinc-700">
        <Icon className="h-4 w-4 text-zinc-400" />
        {label}
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        {account?.miyakePcLogin && (
          <Badge variant="info" className="ml-1">
            三宅PCログイン
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="ID">
          {canEdit ? (
            <Input
              defaultValue={account?.accountId ?? ""}
              onBlur={(e) => {
                const v = e.target.value.trim() || null;
                if (v !== (account?.accountId ?? null)) onSave({ accountId: v });
              }}
              className="h-8 w-full"
            />
          ) : (
            <span className="text-sm break-all">{account?.accountId ?? "—"}</span>
          )}
        </Field>
        <Field label="パスワード">
          {!canSeeSecret ? (
            <span className="text-sm text-zinc-400">••••••••</span>
          ) : canEdit ? (
            <div className="flex items-center gap-1">
              <Input
                type={showPass ? "text" : "password"}
                defaultValue={account?.password ?? ""}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== (account?.password ?? null)) onSave({ password: v });
                }}
                className="h-8 w-full"
              />
              <button
                type="button"
                onClick={() => setShowPass((s) => !s)}
                className="text-zinc-400 hover:text-zinc-700 shrink-0"
                title={showPass ? "隠す" : "表示"}
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm">
              {showPass ? account?.password ?? "—" : account?.password ? "••••••••" : "—"}
              {account?.password && (
                <button
                  type="button"
                  onClick={() => setShowPass((s) => !s)}
                  className="text-zinc-400 hover:text-zinc-700"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
            </span>
          )}
        </Field>
        <Field label="プロフィールリンク">
          {canEdit ? (
            <Input
              defaultValue={account?.profileUrl ?? ""}
              placeholder="https://..."
              onBlur={(e) => {
                const v = e.target.value.trim() || null;
                if (v !== (account?.profileUrl ?? null)) onSave({ profileUrl: v });
              }}
              className="h-8 w-full"
            />
          ) : account?.profileUrl ? (
            <a
              href={account.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-600 hover:underline break-all"
            >
              {account.profileUrl}
            </a>
          ) : (
            <span className="text-sm text-zinc-400">—</span>
          )}
        </Field>
        <Field label="三宅PCログイン">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => onSave({ miyakePcLogin: !account?.miyakePcLogin })}
            className={`inline-flex h-6 w-6 items-center justify-center rounded border transition-colors ${
              account?.miyakePcLogin
                ? "bg-emerald-500 border-emerald-500 text-white"
                : "bg-white border-zinc-300 text-transparent hover:border-zinc-400"
            } ${canEdit ? "cursor-pointer" : "cursor-default opacity-70"}`}
            aria-pressed={account?.miyakePcLogin ?? false}
          >
            <Check className="h-4 w-4" />
          </button>
        </Field>
      </div>
    </div>
  );
}

// ---------- 議事録 ----------

function MeetingsCard({
  projectId,
  meetings,
  setMeetings,
  canEdit,
}: {
  projectId: string;
  meetings: PmDetailData["meetings"];
  setMeetings: React.Dispatch<React.SetStateAction<PmDetailData["meetings"]>>;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!minutes.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/pm/${projectId}/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || null, minutes }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.meeting) {
          setMeetings((prev) => [j.meeting, ...prev]);
          setTitle("");
          setMinutes("");
          setAdding(false);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [projectId, title, minutes, setMeetings]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-sm">打ち合わせ議事録</CardTitle>
        {canEdit && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1" />
            メモを追加
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
            <Input
              placeholder="タイトル（任意・例: 第3回 撮影打ち合わせ）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8"
            />
            <Textarea
              placeholder="議事録メモ"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              rows={4}
            />
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
                キャンセル
              </Button>
              <Button size="sm" onClick={submit} disabled={busy || !minutes.trim()}>
                {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        )}
        {meetings.length === 0 ? (
          <p className="text-sm text-zinc-400">この商談に紐づく議事録はまだありません。</p>
        ) : (
          <ul className="space-y-3">
            {meetings.map((m) => (
              <li key={m.id} className="rounded-lg border border-zinc-200 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium">{m.title ?? "議事録"}</span>
                  <span className="text-xs text-zinc-400 ml-auto">{isoDay(m.meetingDate)}</span>
                </div>
                {(m.summary || m.minutes) && (
                  <p className="text-sm text-zinc-600 whitespace-pre-wrap line-clamp-6">
                    {toReadableText(m.summary || m.minutes)}
                  </p>
                )}
                {m.recordingUrl && (
                  <a
                    href={m.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline mt-1"
                  >
                    録画を開く <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
