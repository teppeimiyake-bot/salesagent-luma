-- T14 AC-07: 発行者設定の備考の初期値を、サンプル見積書（00_Docs/999_サンプル/見積書/*.pdf）の文面に差し替える。
-- 旧初期値（有効期限30日／交通費実費）のまま管理者が触っていない行だけを更新する。何度流しても同じ結果になる。
-- 本番は prisma/migrations-manual/2026-08-17_T14_quote_pdf_v2.sql の後に同じ文を流す（その INSERT は旧文面のため）。
UPDATE public.quote_issuer_profiles
SET default_notes = E'※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。\n※消費税はご契約日時点での税率となります。',
    updated_at = CURRENT_TIMESTAMP
WHERE default_notes = E'本見積書の有効期限は発行日より30日間です。\n業務内容の変更がある場合は別途お見積りいたします。';

UPDATE public.quote_issuer_profiles
SET travel_expense_note = E'※撮影交通費は撮影地をご相談の上、別途実費分をご負担いただきます。\n※撮影交通費は別途ご相談の上貴社にご負担いただきます',
    updated_at = CURRENT_TIMESTAMP
WHERE travel_expense_note = '撮影場所までの交通費は実費にて別途ご請求いたします。';
