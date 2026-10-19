/**
 * 招待なしの登録（POST /api/auth/register で inviteToken なし）を受け付けるか。
 * ------------------------------------------------------------
 * 受け付けると、誰でも既定の会社（Luma）の利用者として所属できてしまうため、既定では受け付けない。
 * ALLOW_SELF_REGISTRATION=1 のときだけ受け付ける。ただし TENANT_STRICT=1 では、所属を決められない
 * （ログインしても会社が決まらず使えない）ので、許可していても受け付けない。
 * 招待URLからの登録は、この設定に関係なく受け付ける。
 */
export function isSelfRegistrationAllowed(): boolean {
  return process.env.ALLOW_SELF_REGISTRATION === "1" && process.env.TENANT_STRICT !== "1";
}

export const SELF_REGISTRATION_DISABLED_MESSAGE = "招待URLから登録してください（招待なしの登録は受け付けていません）。";
