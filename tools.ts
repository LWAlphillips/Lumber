import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { isAllowed } from "./access";
import { lumberGetAll, type Query } from "./lumber";

type Timesheet = {
  id: string;
  date_worked: string;
  employee_code?: string;
  project_code?: string;
  cost_code_code?: string;
  classification_name?: string;
  union_code?: string;
  shift_name?: string;
  status?: string;
  type?: string;
  regular_work_duration_in_secs?: number;
  overtime_duration_in_secs?: number;
  double_overtime_duration_in_secs?: number;
  total_work_duration_in_secs?: number;
  per_diem?: boolean;
};

const hrs = (s?: number) => Math.round(((s ?? 0) / 3600) * 100) / 100;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const STATUSES = [
  "CLOCKED_IN", "MEAL_BREAK", "OTHER_BREAK", "CLOCKED_OUT", "SUBMITTED", "REJECTED",
  "APPROVED", "SUBMITTED_FOR_PAYROLL", "PAYROLL_PROCESSING", "PAYROLL_PROCESSED",
] as const;
const TYPES = [
  "REGULAR", "RESTITUTED", "RESTITUTED_REJECTED", "SICK_LEAVE", "PTO_LEAVE",
  "BEREAVEMENT_LEAVE", "PAID_HOLIDAY", "OTHER_PAID_LEAVE",
] as const;
const GROUPS = ["none", "project", "employee", "project_employee", "date", "cost_code"] as const;

function caller(): string | undefined {
  return getMcpAuthContext()?.props?.user as string | undefined;
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildServer() {
  const server = new McpServer({ name: "lwa-lumber", version: "1.0.0" });

  server.registerTool(
    "lumber_get_timesheets",
    {
      title: "Get Lumber timesheets",
      description:
        "Read LWA field timesheets from Lumber for a date range: one row per worker per day with project, cost code, " +
        "classification, union, and regular/OT/DT hours. LWA's pay week runs Saturday through Friday. " +
        "Use group_by for totals (e.g. hours by project or by employee) instead of pulling every row. Read-only.",
      inputSchema: z.object({
        start_date: DATE.describe("First date worked to include, e.g. 2026-11-07"),
        end_date: DATE.describe("Last date worked to include, e.g. 2026-11-13"),
        project_codes: z.array(z.string()).optional().describe("Limit to these Lumber/Acumatica project codes, e.g. [\"25437\"]"),
        employee_codes: z.array(z.string()).optional().describe("Limit to these employee codes"),
        status: z.enum(STATUSES).optional().describe("Only timesheets in this status, e.g. APPROVED"),
        timesheet_type: z.enum(TYPES).optional().describe("Only this timesheet type, e.g. REGULAR"),
        group_by: z.enum(GROUPS).default("none").describe("Return hour totals grouped this way instead of individual rows"),
        max_rows: z.number().int().min(1).max(2000).default(500).describe("Maximum individual rows to return when group_by is none"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!isAllowed(env, [caller()])) {
        return fail("You are not on this connector's access list. Ask Larry to add you.");
      }
      const start = Date.parse(args.start_date);
      const end = Date.parse(args.end_date);
      if (end < start) return fail("end_date is before start_date.");
      if ((end - start) / 86_400_000 > 92) return fail("Date range is limited to 93 days. Narrow it or split the request.");

      const query: Query = [
        ["start_date", args.start_date],
        ["end_date", args.end_date],
      ];
      for (const p of args.project_codes ?? []) query.push(["project_codes", p]);
      for (const e of args.employee_codes ?? []) query.push(["employee_codes", e]);
      if (args.status) query.push(["timesheet_status", args.status]);
      if (args.timesheet_type) query.push(["timesheet_type", args.timesheet_type]);

      let result: { rows: Timesheet[]; capped: boolean };
      try {
        result = await lumberGetAll<Timesheet>(env, "/timesheets", query);
      } catch (e) {
        return fail((e as Error).message);
      }

      const rows = result.rows.map((t) => ({
        date: t.date_worked,
        employee: t.employee_code ?? "",
        project: t.project_code ?? "",
        cost_code: t.cost_code_code ?? "",
        classification: t.classification_name ?? "",
        union: t.union_code ?? "",
        reg: hrs(t.regular_work_duration_in_secs),
        ot: hrs(t.overtime_duration_in_secs),
        dt: hrs(t.double_overtime_duration_in_secs),
        total: hrs(t.total_work_duration_in_secs),
        type: t.type ?? "",
        status: t.status ?? "",
        id: t.id,
      }));

      const sum = (list: typeof rows) => ({
        reg: Math.round(list.reduce((a, r) => a + r.reg, 0) * 100) / 100,
        ot: Math.round(list.reduce((a, r) => a + r.ot, 0) * 100) / 100,
        dt: Math.round(list.reduce((a, r) => a + r.dt, 0) * 100) / 100,
        total: Math.round(list.reduce((a, r) => a + r.total, 0) * 100) / 100,
      });

      const output: Record<string, unknown> = {
        range: { start: args.start_date, end: args.end_date },
        timesheets: rows.length,
        totals: sum(rows),
      };
      if (result.capped) output.warning = "Lumber returned more pages than allowed; totals may be incomplete. Narrow the filters.";

      if (args.group_by !== "none") {
        const keyOf: Record<Exclude<(typeof GROUPS)[number], "none">, (r: (typeof rows)[number]) => string> = {
          project: (r) => r.project,
          employee: (r) => r.employee,
          project_employee: (r) => `${r.project} | ${r.employee}`,
          date: (r) => r.date,
          cost_code: (r) => `${r.project} | ${r.cost_code}`,
        };
        const groups = new Map<string, typeof rows>();
        for (const r of rows) {
          const k = keyOf[args.group_by](r);
          groups.set(k, [...(groups.get(k) ?? []), r]);
        }
        output.group_by = args.group_by;
        output.groups = [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, list]) => ({ key, timesheets: list.length, ...sum(list) }));
      } else {
        rows.sort((a, b) => a.project.localeCompare(b.project) || a.employee.localeCompare(b.employee) || a.date.localeCompare(b.date));
        output.rows = rows.slice(0, args.max_rows);
        if (rows.length > args.max_rows) {
          output.note = `Showing ${args.max_rows} of ${rows.length} rows. Totals cover all rows. Use group_by or narrower filters for more.`;
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    },
  );

  return server;
}
