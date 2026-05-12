import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import crypto from "node:crypto";
import { putFile, StorageConfigError } from "@/lib/storage";

const META_SCHEMA = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().optional(),
  scope: z.string().optional(),
  dealId: z.string().uuid().optional(),
  version: z.string().optional(),
  // sourceType='url' のとき：外部URLのみ登録（ファイル本体なし）
  sourceType: z.enum(["file", "url"]).optional(),
  url: z.string().url().optional(),
});

// 契約書のアップロードは admin のみ
const ADMIN_ONLY_CATEGORIES = new Set(["contract"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = url.searchParams.get("category");
  const scope = url.searchParams.get("scope");
  const dealId = url.searchParams.get("dealId");
  const docs = await prisma.document.findMany({
    where: {
      ...(category ? { category } : {}),
      ...(scope ? { scope } : {}),
      ...(dealId ? { dealId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ documents: docs });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (me?.permission === "viewer") {
    return NextResponse.json({ error: "Forbidden: viewer cannot upload" }, { status: 403 });
  }

  const ct = req.headers.get("content-type") ?? "";

  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const name = String(form.get("name") ?? "");
    const category = String(form.get("category") ?? "other");
    const scope = String(form.get("scope") ?? "global");
    const dealId = form.get("dealId") ? String(form.get("dealId")) : null;
    const description = String(form.get("description") ?? "");
    const version = form.get("version") ? String(form.get("version")) : null;
    const tagsRaw = String(form.get("tags") ?? "");
    const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
    const file = form.get("file") as File | null;
    if (!name || !file) return NextResponse.json({ error: "name and file required" }, { status: 400 });

    if (ADMIN_ONLY_CATEGORIES.has(category) && !hasPermission(me?.permission, "admin")) {
      return NextResponse.json(
        { error: "Forbidden: contracts can only be uploaded by admin" },
        { status: 403 },
      );
    }

    const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const safe = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    let fileUrl: string;
    try {
      ({ url: fileUrl } = await putFile({
        dir: "documents",
        filename: safe,
        buffer: buf,
        contentType: file.type || undefined,
      }));
    } catch (e) {
      const err = e as Error;
      // 詳細をログとレスポンス両方に出す（本番デバッグ用。Blob未設定・トークン無効・サイズ超過などを切り分ける）
      console.error("[api/documents] putFile failed:", {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
        blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
        onVercel: !!process.env.VERCEL,
      });
      const base =
        e instanceof StorageConfigError ? err.message : "ファイルの保存に失敗しました";
      const detail = e instanceof StorageConfigError ? undefined : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
      return NextResponse.json(
        {
          error: detail ? `${base}（詳細: ${detail}）` : base,
          debug: {
            errorName: err?.name ?? null,
            errorMessage: err?.message ?? null,
            blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
            onVercel: !!process.env.VERCEL,
          },
        },
        { status: 500 },
      );
    }

    const doc = await prisma.document.create({
      data: {
        name,
        category,
        sourceType: "file",
        scope,
        dealId,
        description: description || null,
        version,
        fileUrl,
        fileSize: buf.length,
        mimeType: file.type || null,
        uploadedById: session?.userId ?? null,
        tags,
      },
    });
    return NextResponse.json({ document: doc });
  }

  const body = await req.json().catch(() => null);
  const parsed = META_SCHEMA.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  if (ADMIN_ONLY_CATEGORIES.has(parsed.data.category) && !hasPermission(me?.permission, "admin")) {
    return NextResponse.json(
      { error: "Forbidden: contracts can only be uploaded by admin" },
      { status: 403 },
    );
  }
  const { sourceType: rawSourceType, url, ...rest } = parsed.data;
  const sourceType = rawSourceType ?? "file";
  if (sourceType === "url") {
    // 外部リンク登録：fileUrl に http(s) URL を入れる。ファイル本体は持たない。
    if (!url || !(url.startsWith("https://") || url.startsWith("http://"))) {
      return NextResponse.json({ error: "URL（http/https）を入力してください" }, { status: 400 });
    }
    const doc = await prisma.document.create({
      data: { ...rest, sourceType: "url", fileUrl: url, uploadedById: session?.userId ?? null, tags: [] },
    });
    return NextResponse.json({ document: doc });
  }
  // sourceType='file' だが multipart ではない（=リンク未登録のプレースホルダ作成。従来動作）
  const doc = await prisma.document.create({
    data: { ...rest, sourceType: "file", fileUrl: "(リンク未登録)", uploadedById: session?.userId ?? null, tags: [] },
  });
  return NextResponse.json({ document: doc });
}
