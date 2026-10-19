export const PM_STAFF_ROLES = ["pm", "director", "camera", "editor"] as const;
export type PmStaffRole = (typeof PM_STAFF_ROLES)[number];
