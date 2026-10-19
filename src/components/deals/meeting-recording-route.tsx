import { Bot, CalendarDays, CircleHelp, Mic, MonitorSpeaker, Paperclip } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecordingRoutePresentation } from "@/lib/meetings/recording-route";

const ICONS = {
  automatic: Bot,
  browser: MonitorSpeaker,
  manual: Paperclip,
  microphone: Mic,
  undecided: CircleHelp,
} as const;

export function MeetingRecordingRoute({ route }: { route: RecordingRoutePresentation }) {
  const Icon = ICONS[route.kind];

  return (
    <Card data-testid="meeting-recording-route">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-orange-500" />
            この商談の記録ルート
          </CardTitle>
          <span className="rounded-full bg-orange-50 px-2.5 py-1 text-[12px] font-medium text-orange-700">
            {route.ownerLabel}・{route.routeLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[14px] leading-relaxed text-zinc-700">{route.detail}</p>
        <div className="flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2.5">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <p className="text-[13px] leading-relaxed text-zinc-600">{route.note}</p>
        </div>
      </CardContent>
    </Card>
  );
}
