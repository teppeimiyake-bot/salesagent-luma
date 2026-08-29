import { NextResponse } from "next/server";
import { guardKyopro, ensureKyoproRates } from "@/lib/kyopro-server";

/** GET /api/kyopro/rates — 職種レートと設定（未作成なら初期値を作って返す） */
export async function GET() {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const { rates, setting } = await ensureKyoproRates();
  return NextResponse.json({ rates, setting });
}
