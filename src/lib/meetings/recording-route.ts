import type { MeetingOwnerType } from "./meeting-owner";

export type RecordingRouteKind = "automatic" | "browser" | "manual" | "microphone" | "undecided";

export type RecordingRoutePresentation = {
  kind: RecordingRouteKind;
  /**
   * 自社発行Meet（deals.meet_url を参加先に使える商談）か。自動記録フラグに関係なく own_meet だけ true。
   * 会議種別を変えても meet_url は残るため、画面はこれが true のときだけMeet URLを使う（T21/T24）。
   */
  ownMeet: boolean;
  ownerLabel: string;
  routeLabel: string;
  heroAction: string;
  detail: string;
  /** 記録ルート欄の補足。自社Meetを自動取得するかどうかは自動記録フラグで変わる。 */
  note: string;
  manualSectionTitle: string;
  manualSectionDescription: string;
};

export type RecordingRouteOptions = {
  /**
   * FEATURE_MEET_AUTO_RECORD（T16の自動録画・自動文字起こし）が有効か。
   * OFF（既定値・切り戻し時）は自動記録が動かないので、自社Meetも従来どおりブラウザ録音（タブ音声）を
   * 記録ルートとして案内する（T16：OFFのあいだ画面は現行と同一）。
   * 省略時は有効として扱う（記録ルート表示だけのプレビュー用）。商談ページは必ずフラグの値を渡すこと。
   */
  autoRecordEnabled?: boolean;
};

/** T21〜T23で確定した経路を、商談詳細に表示するための文言へ変換する。 */
export function recordingRouteFor(
  meetingOwnerType: MeetingOwnerType,
  { autoRecordEnabled = true }: RecordingRouteOptions = {},
): RecordingRoutePresentation {
  const note = autoRecordEnabled
    ? "自社Meetは自動取得します。取得できない成果物と先方会議は手動添付を利用し、カレンダーからのコピー＆ペーストは補助として扱います。"
    : "自社Meetはブラウザのタブ音声録音で記録します。先方会議は手動添付を利用し、カレンダーからのコピー＆ペーストは補助として扱います。";
  return { ...routeByOwner(meetingOwnerType, autoRecordEnabled), note };
}

function routeByOwner(
  meetingOwnerType: MeetingOwnerType,
  autoRecordEnabled: boolean,
): Omit<RecordingRoutePresentation, "note"> {
  switch (meetingOwnerType) {
    case "own_meet":
      if (!autoRecordEnabled) {
        // 切り戻し時：Meet側の自動記録が無いので、商談ページのライブ商談録音（タブ音声）で録る。
        return {
          kind: "browser",
          ownMeet: true,
          ownerLabel: "自社発行Meet",
          routeLabel: "ブラウザ録音",
          heroAction:
            "Meetに参加したら、商談記録の「ライブ商談録音」で「タブ音声」を選んで録音を開始し、終了後に「停止して送信」を押してください。",
          detail:
            "自社発行Meetは、ブラウザのタブ音声録音で相手の声も含めて記録し、既存AI分析へつなぎます。Meet側の自動録画・文字起こしは使いません。",
          manualSectionTitle: "自社発行Meetをブラウザ録音",
          manualSectionDescription:
            "ライブ商談録音の「タブ音声」でMeetのタブを選んで記録します。受領済みの議事録や録画は下から添付できます。",
        };
      }
      return {
        kind: "automatic",
        ownMeet: true,
        ownerLabel: "自社発行Meet",
        routeLabel: "自動記録",
        heroAction: "自動記録の設定が完了しているか確認してください。設定済みの場合は録音開始の操作は不要です。",
        detail:
          "自社発行Meetは録画・文字起こしを自動取得し、既存AI分析へつなぎます。取得できない成果物だけ、下の手動添付で補います。",
        // T16 AC8：自社Meetの通常経路にブラウザ録音は置かない。救済は受領ファイル・テキストの手動添付だけ。
        manualSectionTitle: "必要な場合の手動添付",
        manualSectionDescription:
          "自動取得できない成果物がある場合に、録画・音声・議事録・文字起こしを取り込みます。",
      };
    case "guest_meet":
      return {
        kind: "manual",
        ownMeet: false,
        ownerLabel: "先方発行Meet",
        routeLabel: "手動添付",
        heroAction: "先方から議事録・文字起こし・録画を受け取り、商談記録へ添付してください。",
        detail:
          "先方主催Meetは自動記録の対象外です。先方から成果物を受け取り、下の手動添付から取り込みます。",
        manualSectionTitle: "成果物を手動添付",
        manualSectionDescription:
          "先方から受領した議事録・文字起こし・録画を取り込みます。必要に応じてマイク録音も利用できます。",
      };
    case "zoom":
      return {
        kind: "manual",
        ownMeet: false,
        ownerLabel: "先方発行Zoom",
        routeLabel: "手動添付",
        heroAction: "先方から議事録・文字起こし・録画を受け取り、商談記録へ添付してください。",
        detail:
          "Zoomの自動連携はありません。先方から成果物を受け取り、下の手動添付から取り込みます。",
        manualSectionTitle: "成果物を手動添付",
        manualSectionDescription:
          "先方から受領した議事録・文字起こし・録画を取り込みます。必要に応じてマイク録音も利用できます。",
      };
    case "in_person":
      return {
        kind: "microphone",
        ownMeet: false,
        ownerLabel: "対面商談",
        routeLabel: "マイク録音",
        heroAction: "商談開始時に、商談記録の「マイクのみ」で録音を開始してください。",
        detail:
          "対面商談はブラウザのマイク録音が主経路です。受領済みの議事録がある場合は手動添付も利用できます。",
        manualSectionTitle: "対面商談をマイク録音",
        manualSectionDescription:
          "ライブ商談録音の「マイクのみ」で記録します。既存の議事録や録画は下から添付できます。",
      };
    case "unknown":
      return {
        kind: "undecided",
        ownMeet: false,
        ownerLabel: "会議種別未選択",
        routeLabel: "ルート未確定",
        heroAction: "まず商談記録で、会議の主催者・形式を選択してください。",
        detail:
          "自社発行と確認できるまでは自動記録を行いません。会議種別を選ぶと、この商談の記録ルートが確定します。",
        manualSectionTitle: "手動記録・添付",
        manualSectionDescription:
          "種別を確定する前でも、マイク録音と受領ファイルの手動添付は利用できます。",
      };
  }
}
