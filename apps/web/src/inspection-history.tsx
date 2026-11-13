import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  INSPECTION_STATUS_PRESENTATION,
  InspectionStateSchema,
  ListInspectionsResponseSchema,
  type Inspection,
  type InspectionState,
} from "@factorylens/contracts";
import { type ChangeEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { PageState } from "./components/PageState";
import { Badge, Button, Progress, TableFrame } from "./components/ui";

class InspectionListError extends Error {
  constructor(readonly status: number) {
    super("Inspection history request failed");
  }
}

async function fetchInspections(
  limit: number,
  cursor?: string,
  status?: InspectionState,
) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  if (status) query.set("status", status);

  const response = await fetch(`/api/inspections?${query}`);
  if (!response.ok) throw new InspectionListError(response.status);
  return ListInspectionsResponseSchema.parse(await response.json());
}

function signedOut(error: unknown) {
  return error instanceof InspectionListError && error.status === 401;
}

function retryInspectionList(failureCount: number, error: Error) {
  return !signedOut(error) && failureCount < 2;
}

function sourceLabel(inspection: Inspection) {
  return {
    upload: "Uploaded video",
    recording: "Browser recording",
    sample: "Prepared sample",
  }[inspection.sourceType];
}

function resultSummary(inspection: Inspection) {
  if (inspection.status === "completed" && inspection.summary) {
    const count = inspection.summary.missingHardHatEventCount;
    return `${count} missing hard-hat ${count === 1 ? "event" : "events"}`;
  }
  if (inspection.status === "failed") {
    return inspection.error?.message ?? "Inspection could not be completed";
  }
  if (inspection.status === "cancelled") return "Inspection cancelled";
  if (inspection.status === "awaiting_upload")
    return "Waiting for video upload";
  return `${inspection.progress.percent}% complete`;
}

function createdTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function InspectionStatus({ inspection }: { inspection: Inspection }) {
  const presentation = INSPECTION_STATUS_PRESENTATION[inspection.status];
  return <Badge tone={presentation.tone}>{presentation.label}</Badge>;
}

function InspectionTable({
  inspections,
  label,
}: {
  inspections: Inspection[];
  label: string;
}) {
  return (
    <TableFrame>
      <table>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Inspection</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col">Progress or result</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {inspections.map((inspection) => (
            <tr key={inspection.id}>
              <td>
                <Link
                  className="text-link"
                  to={`/inspections/${inspection.id}`}
                >
                  {inspection.title}
                </Link>
              </td>
              <td>{sourceLabel(inspection)}</td>
              <td>
                <InspectionStatus inspection={inspection} />
              </td>
              <td className="history-summary">
                {inspection.status === "queued" ||
                inspection.status === "processing" ? (
                  <Progress
                    label={resultSummary(inspection)}
                    value={inspection.progress.percent}
                  />
                ) : (
                  resultSummary(inspection)
                )}
              </td>
              <td>
                <time dateTime={inspection.createdAt}>
                  {createdTime(inspection.createdAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

export function RecentInspections() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["inspections", "recent"],
    queryFn: () => fetchInspections(5),
    refetchInterval: (currentQuery) =>
      currentQuery.state.data?.inspections.some((inspection) =>
        ["queued", "processing"].includes(inspection.status),
      )
        ? 5_000
        : false,
    retry: retryInspectionList,
  });

  if (signedOut(query.error)) return <Navigate replace to="/sign-in" />;
  if (query.isPending)
    return <PageState kind="loading" title="Loading recent inspections" />;
  if (query.isError)
    return (
      <PageState
        actionLabel="Try again"
        kind="error"
        onAction={() => void query.refetch()}
        title="Recent inspections are unavailable"
      />
    );
  if (query.data.inspections.length === 0) {
    return (
      <PageState
        actionLabel="Start an inspection"
        kind="empty"
        onAction={() => navigate("/inspections/new")}
        title="No inspections yet"
      >
        Start with an uploaded video, a browser recording, or the prepared
        sample.
      </PageState>
    );
  }
  return (
    <InspectionTable
      inspections={query.data.inspections}
      label="Recent inspections"
    />
  );
}

export function InspectionHistory() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<InspectionState | undefined>();
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["inspections", "history", status],
    queryFn: ({ pageParam }) => fetchInspections(20, pageParam, status),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryInspectionList,
  });

  if (signedOut(query.error)) return <Navigate replace to="/sign-in" />;
  if (query.isPending)
    return <PageState kind="loading" title="Loading inspection history" />;
  if (query.isError)
    return (
      <PageState
        actionLabel="Try again"
        kind="error"
        onAction={() => void query.refetch()}
        title="Inspection history is unavailable"
      />
    );

  const inspections = query.data.pages.flatMap((page) => page.inspections);
  const visible = inspections.filter((inspection) =>
    inspection.title
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  if (inspections.length === 0 && !status) {
    return (
      <PageState
        actionLabel="Start an inspection"
        kind="empty"
        onAction={() => navigate("/inspections/new")}
        title="No inspection history yet"
      >
        Completed and in-progress inspections will appear here.
      </PageState>
    );
  }

  function changeStatus(event: ChangeEvent<HTMLSelectElement>) {
    const parsed = InspectionStateSchema.safeParse(event.target.value);
    setStatus(parsed.success ? parsed.data : undefined);
  }

  return (
    <>
      <div className="filter-bar">
        <label className="search-field">
          <span className="sr-only">Search inspection history</span>
          <span aria-hidden="true">⌕</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded history"
            type="search"
            value={search}
          />
        </label>
        <label className="compact-field">
          <span>Status</span>
          <select onChange={changeStatus} value={status ?? "all"}>
            <option value="all">All statuses</option>
            {InspectionStateSchema.options.map((option) => (
              <option key={option} value={option}>
                {INSPECTION_STATUS_PRESENTATION[option].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {visible.length > 0 ? (
        <InspectionTable
          inspections={visible}
          label="Inspection history, newest first"
        />
      ) : (
        <PageState kind="empty" title="No matching inspections">
          Change the search or status filter to see other inspections.
        </PageState>
      )}
      {query.hasNextPage ? (
        <div className="pagination">
          <Button
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            variant="secondary"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load older inspections"}
          </Button>
        </div>
      ) : inspections.length > 0 ? (
        <p className="pagination__end">
          You have reached the end of your history.
        </p>
      ) : null}
    </>
  );
}
