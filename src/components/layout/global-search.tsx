"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Building2, Briefcase, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/ui/company-logo";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { representativeYomi, yomiColor } from "@/lib/deal-aggregations";
import type { DealStatus } from "@prisma/client";

type SearchResult = {
  companies: Array<{
    id: string;
    name: string;
    industry: string | null;
    logoUrl: string | null;
    logoColor: string | null;
    _count: { deals: number };
  }>;
  deals: Array<{
    id: string;
    title: string;
    status: DealStatus;
    company: { id: string; name: string; logoUrl: string | null; logoColor: string | null };
    owner: { name: string; avatarColor: string | null } | null;
    products: Array<{
      id: string;
      productName: string;
      probability: number;
      amount: number | null;
      yomiStatus: string | null;
    }>;
  }>;
};

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (e.key === "Escape") setOpen(false);
    }
    function click(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setData(null);
      return;
    }
    const id = setTimeout(async () => {
      setLoading(true);
      const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const j = await r.json();
      setData(j);
      setLoading(false);
    }, 200);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-sm text-zinc-600 w-72"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">企業・商談を検索…</span>
        <kbd className="px-1.5 py-0.5 text-[10px] bg-white border border-zinc-300 rounded">⌘K</kbd>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[28rem] bg-white border border-zinc-200 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
            <Search className="h-4 w-4 text-zinc-400" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="企業名・商談・プロダクト・代表者…"
              className="flex-1 bg-transparent outline-none text-sm"
            />
            {loading && <Loader2 className="h-4 w-4 text-zinc-400 animate-spin" />}
          </div>
          <div className="max-h-[480px] overflow-y-auto">
            {!q && (
              <div className="p-6 text-center text-xs text-zinc-500">
                企業名・商談タイトル・プロダクト・代表者名・住所などで検索
                <br />
                <span className="text-zinc-400">⌘K でいつでも開けます</span>
              </div>
            )}
            {data && data.companies.length === 0 && data.deals.length === 0 && q && !loading && (
              <div className="p-6 text-center text-sm text-zinc-500">「{q}」に一致する結果なし</div>
            )}
            {data && data.companies.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-50 font-bold">
                  企業 ({data.companies.length})
                </div>
                {data.companies.map((c) => (
                  <Link
                    key={c.id}
                    href={`/companies/${c.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-orange-50 transition-colors"
                  >
                    <CompanyLogo name={c.name} logoUrl={c.logoUrl} logoColor={c.logoColor} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-3 w-3 text-zinc-400" />
                        <span className="font-semibold text-sm truncate">{c.name}</span>
                      </div>
                      {c.industry && <p className="text-xs text-zinc-500 truncate">{c.industry}</p>}
                    </div>
                    <Badge variant="outline" className="text-[10px]">商談 {c._count.deals}</Badge>
                  </Link>
                ))}
              </div>
            )}
            {data && data.deals.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-50 font-bold">
                  商談 ({data.deals.length})
                </div>
                {data.deals.map((d) => {
                  const repYomi = representativeYomi(d.products);
                  const repYomiC = yomiColor(repYomi);
                  const productSummary =
                    d.products.length === 0
                      ? d.title
                      : d.products
                          .slice(0, 2)
                          .map((p) => p.productName)
                          .join(", ") + (d.products.length > 2 ? ` 他${d.products.length - 2}件` : "");
                  return (
                    <Link
                      key={d.id}
                      href={`/deals/${d.id}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-orange-50 transition-colors"
                    >
                      <Briefcase className="h-4 w-4 text-amber-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{d.company.name}</p>
                        <p className="text-xs text-zinc-500 truncate">{productSummary}</p>
                      </div>
                      <Badge variant={statusColor(d.status)} className="text-[10px]">
                        {STATUS_LABEL[d.status]}
                      </Badge>
                      {repYomi && (
                        <span
                          className={`inline-flex items-center text-[10px] font-bold border rounded-full px-1.5 py-0.5 ${repYomiC.bg} ${repYomiC.text} ${repYomiC.border}`}
                        >
                          {repYomi}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
