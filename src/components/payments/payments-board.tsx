"use client";

import { useState } from "react";
import { Receipt, CalendarRange } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SpotTable } from "@/components/payments/spot-table";
import { RecurringGrid } from "@/components/payments/recurring-grid";

/**
 * 入金管理ボード：スポット / 定期 の2サブタブ。
 */
export function PaymentsBoard({ canEdit }: { canEdit: boolean }) {
  const [tab, setTab] = useState("spot");

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        <TabsTrigger value="spot" className="gap-1.5">
          <Receipt className="h-4 w-4" />
          スポット
        </TabsTrigger>
        <TabsTrigger value="recurring" className="gap-1.5">
          <CalendarRange className="h-4 w-4" />
          定期
        </TabsTrigger>
      </TabsList>

      <TabsContent value="spot">
        <SpotTable canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="recurring">
        <RecurringGrid canEdit={canEdit} />
      </TabsContent>
    </Tabs>
  );
}
