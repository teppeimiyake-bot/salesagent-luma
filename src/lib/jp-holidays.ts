/**
 * 日本の祝日（1980〜2099年）
 * ============================================================
 * 撮影会は土日祝に集中するため、カレンダー・一覧で祝日を土日と同じ扱いで見せる。
 * 外部APIを呼ばずに算出する（Vercel の実行環境やオフラインでも同じ結果になる）。
 *
 * 対応している規則:
 *   - 固定日の祝日
 *   - ハッピーマンデー（成人の日・海の日・敬老の日・スポーツの日）
 *   - 春分の日・秋分の日（1980〜2099年の近似式）
 *   - 振替休日（日曜が祝日なら、その後の最初の平日）
 *   - 国民の休日（祝日に挟まれた平日。敬老の日と秋分の日の間など）
 *
 * 注: 2020東京五輪のような単年の特例、2019年の即位関連は対象外（過去日であり実務に不要）。
 * すべて UTC で扱う（撮影会の date 列が @db.Date のため）。
 */

const key = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** その月の第 n 月曜日 */
function nthMonday(year: number, month: number, n: number): Date {
  const first = utc(year, month, 1);
  const offset = (8 - first.getUTCDay()) % 7; // 最初の月曜まで
  return utc(year, month, 1 + offset + (n - 1) * 7);
}

/** 春分日（1980〜2099） */
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分日（1980〜2099） */
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

const cache = new Map<number, Map<string, string>>();

/** その年の祝日（"YYYY-MM-DD" → 名称） */
export function holidaysOfYear(year: number): Map<string, string> {
  const cached = cache.get(year);
  if (cached) return cached;

  const base: [Date, string][] = [
    [utc(year, 1, 1), "元日"],
    [nthMonday(year, 1, 2), "成人の日"],
    [utc(year, 2, 11), "建国記念の日"],
    [utc(year, 2, 23), "天皇誕生日"],
    [utc(year, 3, vernalEquinoxDay(year)), "春分の日"],
    [utc(year, 4, 29), "昭和の日"],
    [utc(year, 5, 3), "憲法記念日"],
    [utc(year, 5, 4), "みどりの日"],
    [utc(year, 5, 5), "こどもの日"],
    [nthMonday(year, 7, 3), "海の日"],
    [utc(year, 8, 11), "山の日"],
    [nthMonday(year, 9, 3), "敬老の日"],
    [utc(year, 9, autumnalEquinoxDay(year)), "秋分の日"],
    [nthMonday(year, 10, 2), "スポーツの日"],
    [utc(year, 11, 3), "文化の日"],
    [utc(year, 11, 23), "勤労感謝の日"],
  ];

  const map = new Map<string, string>();
  for (const [d, name] of base) map.set(key(d), name);

  // 振替休日: 日曜が祝日なら、その後の最初の「祝日でない日」を休みにする
  for (const [d] of base) {
    if (d.getUTCDay() !== 0) continue;
    const next = new Date(d);
    do {
      next.setUTCDate(next.getUTCDate() + 1);
    } while (map.has(key(next)));
    map.set(key(next), "振替休日");
  }

  // 国民の休日: 祝日と祝日に挟まれた平日（敬老の日と秋分の日の間など）
  for (const [d] of base) {
    const prev = new Date(d);
    prev.setUTCDate(prev.getUTCDate() - 2);
    const between = new Date(d);
    between.setUTCDate(between.getUTCDate() - 1);
    if (
      map.has(key(prev)) &&
      !map.has(key(between)) &&
      between.getUTCDay() !== 0 &&
      between.getUTCDay() !== 6
    ) {
      map.set(key(between), "国民の休日");
    }
  }

  cache.set(year, map);
  return map;
}

/** "YYYY-MM-DD" が祝日ならその名称、そうでなければ null */
export function holidayName(iso: string): string | null {
  const year = Number(iso.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return holidaysOfYear(year).get(iso) ?? null;
}

/** 土日または祝日か（撮影会が集中する日） */
export function isRestDay(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6 || holidayName(iso) !== null;
}
