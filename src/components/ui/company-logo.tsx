"use client";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** 企業ロゴ。logoUrl があれば画像、なければグラデーションアイコン */
export function CompanyLogo({
  name,
  logoUrl,
  logoColor,
  size = "md",
  className,
}: {
  name: string;
  logoUrl?: string | null;
  logoColor?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const [error, setError] = useState(false);
  const sizes = {
    sm: { box: "w-8 h-8 text-xs rounded-md", icon: "h-4 w-4" },
    md: { box: "w-10 h-10 text-sm rounded-lg", icon: "h-5 w-5" },
    lg: { box: "w-14 h-14 text-base rounded-xl", icon: "h-7 w-7" },
    xl: { box: "w-20 h-20 text-lg rounded-2xl", icon: "h-10 w-10" },
  }[size];

  const usableUrl = logoUrl && !error ? logoUrl : null;

  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-center text-white font-bold shadow-sm overflow-hidden",
        sizes.box,
        className,
      )}
      style={
        usableUrl
          ? { background: "white", border: "1px solid rgb(228 228 231)" }
          : {
              background:
                logoColor ??
                "linear-gradient(135deg, #6366f1, #8b5cf6, #d946ef)",
            }
      }
    >
      {usableUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={usableUrl}
          alt={name}
          onError={() => setError(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <Building2 className={sizes.icon} />
      )}
    </div>
  );
}
