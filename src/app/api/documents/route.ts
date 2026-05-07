import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { putFile } from "@/lib/storage";

const META_SCHEMA = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().optional(),
  scope: z.string().optional(),
  dealId: z.string().uuid().optional(),
  version: z.string().optional(),
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

    const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "bin" : "bin";
    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putFile(buf, {
      dir: "documents",
      ext,
      originalName: file.name,
      contentType: file.type || undefined,
    });
    const doc = await prisma.document.create({
      data: {
        name,
        category,
        scope,
        dealId,
        description: description || null,
        version,
        fileUrl: stored.url,
        fileSize: stored.size,
        mimeType: file.type || null,
        uploadedById: session?.userId ?? null,
        tags,
      },
    });
    return NextResponse.json({ document: doc });
  }

  const body = await req.json().catch(() => null);
  const parsed = META_SCHEMA.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  if (ADMIN_ONLY_CATEGORIES.has(parsed.data.category) && !hasPermission(me?.permission, "admin")) {
    return NextResponse.json(
      { error: "Forbidden: contracts can only be uploaded by admin" },
      { status: 403 },
    );
  }
  const doc = await prisma.document.create({
    data: { ...parsed.data, fileUrl: "(リンク未登録)", uploadedById: session?.userId ?? null, tags: [] },
  });
  return NextResponse.json({ document: doc });
}
