/**
 * 書き込み・AI 呼び出し・外部取得をする API の権限の確認（利用者以上）。
 * ------------------------------------------------------------
 * 権限は操作中の会社での権限（getCurrentPermission、UserTenant.permission）で決める。
 *   - 未ログイン: 401
 *   - 全社統合ビュー: 403（書き込みは Prisma Extension も止める。会社を切り替える案内を返す）
 *   - 閲覧のみ・権限が取れない: 403
 * 通ってよいときは null を返す。route の先頭で
 *   const denied = await requireWriter(); if (denied) return denied;
 * のように使う。
 */
import { NextResponse } from "next/server";
import { getCurrentPermission, getSession, hasPermission } from "@/lib/auth";
import { currentTenant, getRequestTenant } from "@/lib/tenant-context";

export const CROSS_TENANT_WRITE_MESSAGE =
  "全社統合ビューでは追加・変更・AIの実行はできません。会社を Luma / リージー のいずれかに切り替えてから操作してください。";
export const READ_ONLY_MESSAGE = "閲覧のみの権限では、この操作はできません。";

export async function requireWriter(): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = currentTenant() ?? (await getRequestTenant());
  if (ctx?.crossTenant) return NextResponse.json({ error: CROSS_TENANT_WRITE_MESSAGE }, { status: 403 });
  if (!hasPermission(await getCurrentPermission(), "user")) {
    return NextResponse.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
  }
  return null;
}

/**
 * 書き込みに必要な権限が無いときの 403（日本語の理由つき）。権限の判定は呼び出し側で済ませてから使う。
 * 全社統合ビューなら会社の切り替え、それ以外は閲覧のみの理由を返す（requireWriter と同じ文言）。
 */
export async function writeForbidden(): Promise<NextResponse> {
  const ctx = currentTenant() ?? (await getRequestTenant());
  return NextResponse.json({ error: ctx?.crossTenant ? CROSS_TENANT_WRITE_MESSAGE : READ_ONLY_MESSAGE }, { status: 403 });
}
