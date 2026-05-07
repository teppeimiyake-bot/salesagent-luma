import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const maxDuration = 30;

/** HP の <link rel="icon"> / og:image を抽出。なければ Google Favicon API URL を保存 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!company.websiteUrl) return NextResponse.json({ error: "websiteUrl is empty" }, { status: 400 });

  let logoUrl: string | null = null;
  try {
    const res = await fetch(company.websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 ReeasySalesAgent/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      const icon =
        html.match(/<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i) ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["']/i);
      const candidate = og?.[1] || icon?.[1];
      if (candidate) {
        logoUrl = new URL(candidate, company.websiteUrl).toString();
      }
    }
  } catch {
    /* ignore */
  }

  // フォールバック：Google Favicon API
  if (!logoUrl) {
    try {
      const host = new URL(company.websiteUrl).host;
      logoUrl = `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
    } catch {
      /* ignore */
    }
  }

  if (!logoUrl) {
    return NextResponse.json({ error: "Could not extract logo" }, { status: 502 });
  }

  const updated = await prisma.company.update({ where: { id }, data: { logoUrl } });
  return NextResponse.json({ company: updated });
}
