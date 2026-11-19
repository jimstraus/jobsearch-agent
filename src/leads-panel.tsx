import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  StarIcon,
  XIcon,
  ArrowClockwiseIcon
} from "@phosphor-icons/react";
import type { JobSearchState, Lead, LeadStatus } from "./server";

type Stub = {
  listLeads: (filter: {
    status?: LeadStatus;
    limit?: number;
  }) => Promise<Lead[]>;
  triageLeads: (
    ids: number[],
    status: LeadStatus,
    note?: string
  ) => Promise<unknown>;
};

const TABS: LeadStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Passed",
  "Filtered"
];

const FIT_VARIANT: Record<
  string,
  "primary" | "secondary" | "outline" | "destructive"
> = {
  High: "primary",
  Medium: "secondary",
  Low: "outline",
  Reject: "destructive"
};

export function LeadsPanel({
  stub,
  state
}: {
  stub: Stub;
  state: JobSearchState | undefined;
}) {
  const [tab, setTab] = useState<LeadStatus>("New");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeads(await stub.listLeads({ status: tab, limit: 100 }));
    } finally {
      setLoading(false);
    }
  }, [stub, tab]);

  // Refetch on tab change and whenever the agent reports that leads changed.
  useEffect(() => {
    load();
  }, [load, state?.leadsVersion]);

  const triage = async (id: number, status: LeadStatus) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    await stub.triageLeads([id], status);
  };

  return (
    <aside className="flex flex-col h-full border-l border-kumo-line bg-kumo-base">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <Text variant="heading3" as="h2">
          Leads
        </Text>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Refresh leads"
          icon={
            <ArrowClockwiseIcon
              size={14}
              className={loading ? "animate-spin" : ""}
            />
          }
          onClick={load}
        />
      </div>
      <div className="px-4 pb-3 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={t === tab ? "primary" : "ghost"}
            onClick={() => setTab(t)}
          >
            {t}
            {state?.counts?.[t] ? ` ${state.counts[t]}` : ""}
          </Button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {leads.length === 0 && (
          <Text size="sm" variant="secondary">
            {loading ? "Loading…" : `No ${tab.toLowerCase()} leads.`}
          </Text>
        )}
        {leads.map((lead) => (
          <Surface key={lead.id} className="p-3 rounded-lg ring ring-kumo-line">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <a
                  href={lead.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-sm text-kumo-default hover:underline inline-flex items-center gap-1"
                >
                  {lead.title}
                  <ArrowSquareOutIcon size={12} className="shrink-0" />
                </a>
                <div className="text-xs text-kumo-subtle">
                  #{lead.id} · {lead.company} ·{" "}
                  {lead.location || "location n/a"}
                  {lead.salary ? ` · ${lead.salary}` : ""}
                </div>
              </div>
              <Badge variant={FIT_VARIANT[lead.fit] ?? "secondary"}>
                {lead.fit}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs text-kumo-default">{lead.rationale}</p>
            {!lead.location_ok && (
              <p className="mt-1 text-xs text-kumo-danger">
                Location rule not met
              </p>
            )}
            {lead.note && (
              <p className="mt-1 text-xs italic text-kumo-subtle">
                {lead.note}
              </p>
            )}
            <div className="mt-2 flex gap-1">
              {tab !== "Interested" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<StarIcon size={12} />}
                  onClick={() => triage(lead.id, "Interested")}
                >
                  Interested
                </Button>
              )}
              {tab !== "Applied" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<CheckIcon size={12} />}
                  onClick={() => triage(lead.id, "Applied")}
                >
                  Applied
                </Button>
              )}
              {tab !== "Passed" && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<XIcon size={12} />}
                  onClick={() => triage(lead.id, "Passed")}
                >
                  Pass
                </Button>
              )}
            </div>
          </Surface>
        ))}
      </div>
    </aside>
  );
}
