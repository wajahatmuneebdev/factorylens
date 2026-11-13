import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { PageState } from "./components/PageState";
import { NewInspectionForm } from "./new-inspection";
import {
  Badge,
  Button,
  Dialog,
  Notification,
  Progress,
  TableFrame,
} from "./components/ui";

function PageHeader({
  action,
  eyebrow,
  title,
}: {
  action?: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {action}
    </header>
  );
}

export function DashboardPage() {
  return (
    <div className="page-stack">
      <PageHeader
        action={
          <Link className="button button--primary" to="/inspections/new">
            <span aria-hidden="true">＋</span> New inspection
          </Link>
        }
        eyebrow="Monday, 9 November"
        title="Good morning"
      />

      <section aria-labelledby="overview-title" className="section-stack">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Overview</p>
            <h2 id="overview-title">Inspection activity</h2>
          </div>
          <span className="preview-label">Interface preview</span>
        </div>
        <div className="metric-grid">
          <article className="metric-card metric-card--accent">
            <span className="metric-card__label">Ready to review</span>
            <strong>12</strong>
            <span className="metric-card__meta">3 added this week</span>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">In progress</span>
            <strong>2</strong>
            <span className="metric-card__meta">Processing normally</span>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Needs attention</span>
            <strong>1</strong>
            <span className="metric-card__meta">Action may be required</span>
          </article>
        </div>
      </section>

      <section aria-labelledby="recent-title" className="panel section-stack">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2 id="recent-title">Recent inspections</h2>
          </div>
          <Link className="text-link" to="/history">
            View history <span aria-hidden="true">→</span>
          </Link>
        </div>
        <TableFrame>
          <table>
            <caption className="sr-only">
              Example recent inspection rows
            </caption>
            <thead>
              <tr>
                <th scope="col">Inspection</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>Packaging line check</strong>
                  <span className="table-subtext">42 second recording</span>
                </td>
                <td>Uploaded video</td>
                <td>
                  <Badge tone="positive">Completed</Badge>
                </td>
                <td>18 minutes ago</td>
                <td>
                  <Link
                    aria-label="Open Packaging line check"
                    className="table-link"
                    to="/inspections/preview"
                  >
                    →
                  </Link>
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Loading bay walkthrough</strong>
                  <span className="table-subtext">1 minute recording</span>
                </td>
                <td>Browser recording</td>
                <td>
                  <Badge tone="info">Processing</Badge>
                </td>
                <td>4 minutes ago</td>
                <td>
                  <Link
                    aria-label="Open Loading bay walkthrough"
                    className="table-link"
                    to="/inspections/preview"
                  >
                    →
                  </Link>
                </td>
              </tr>
            </tbody>
          </table>
        </TableFrame>
      </section>

      <section aria-labelledby="states-title" className="section-stack">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reusable components</p>
            <h2 id="states-title">Page states</h2>
          </div>
          <p className="section-note">Generic states for every feature area</p>
        </div>
        <div className="state-grid">
          <PageState kind="loading" />
          <PageState kind="empty" />
          <PageState kind="degraded" />
          <PageState kind="error" />
        </div>
      </section>
    </div>
  );
}

export function NewInspectionPage() {
  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader eyebrow="Create" title="New inspection" />
      <p className="page-intro">
        Choose a recording to securely upload. FactoryLens will verify it before
        adding the inspection to the processing queue.
      </p>
      <NewInspectionForm />
    </div>
  );
}

export function InspectionPage() {
  const { inspectionId } = useParams();
  const location = useLocation();
  const queuedInspection = (
    location.state as { queuedInspection?: { title: string } } | null
  )?.queuedInspection;

  return (
    <div className="page-stack">
      <PageHeader
        action={
          <Badge tone="info">
            {queuedInspection ? "Queued" : "Processing"}
          </Badge>
        }
        eyebrow={queuedInspection ? "Inspection created" : "Inspection preview"}
        title={queuedInspection?.title ?? "Packaging line check"}
      />
      <div className="detail-grid">
        <section aria-labelledby="media-title" className="media-placeholder">
          <div className="media-placeholder__frame">
            <span aria-hidden="true" className="media-placeholder__play">
              ▶
            </span>
            <span>Video player surface</span>
          </div>
          <div className="media-placeholder__caption">
            <div>
              <p className="eyebrow">Route parameter</p>
              <strong id="media-title">{inspectionId}</strong>
            </div>
            <span>00:00 / 00:42</span>
          </div>
        </section>
        <aside aria-labelledby="status-title" className="panel status-card">
          <div>
            <p className="eyebrow">Current stage</p>
            <h2 id="status-title">
              {queuedInspection ? "Waiting to begin" : "Analyzing recording"}
            </h2>
          </div>
          <Progress
            label={queuedInspection ? "Queued" : "Inspection progress"}
            value={queuedInspection ? 0 : 62}
          />
          <p className="muted-copy">
            Progress, playback, annotations, and result data are visual
            placeholders in this shell.
          </p>
          <Button disabled variant="secondary">
            Cancel unavailable in preview
          </Button>
        </aside>
      </div>
    </div>
  );
}

export function HistoryPage() {
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Archive" title="Inspection history" />
      <div className="filter-bar">
        <label className="search-field">
          <span className="sr-only">Search inspection history</span>
          <span aria-hidden="true">⌕</span>
          <input placeholder="Search history" type="search" />
        </label>
        <label className="compact-field">
          <span>Status</span>
          <select defaultValue="all">
            <option value="all">All statuses</option>
            <option value="completed">Completed</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      <section
        aria-labelledby="history-table-title"
        className="panel section-stack"
      >
        <div className="section-heading">
          <h2 id="history-table-title">All inspections</h2>
          <span className="preview-label">Sample rows</span>
        </div>
        <TableFrame>
          <table>
            <caption className="sr-only">Example inspection history</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Created</th>
                <th scope="col">Duration</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Link className="text-link" to="/inspections/preview">
                    Packaging line check
                  </Link>
                </td>
                <td>9 Nov 2026</td>
                <td>00:42</td>
                <td>
                  <Badge tone="positive">Completed</Badge>
                </td>
              </tr>
              <tr>
                <td>
                  <Link className="text-link" to="/inspections/preview">
                    Loading bay walkthrough
                  </Link>
                </td>
                <td>9 Nov 2026</td>
                <td>01:04</td>
                <td>
                  <Badge tone="info">Processing</Badge>
                </td>
              </tr>
              <tr>
                <td>
                  <Link className="text-link" to="/inspections/preview">
                    Conveyor guard review
                  </Link>
                </td>
                <td>8 Nov 2026</td>
                <td>00:31</td>
                <td>
                  <Badge tone="critical">Failed</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </TableFrame>
      </section>
    </div>
  );
}

export function AccountPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  async function signOut() {
    setSignOutError(false);
    setSigningOut(true);
    try {
      const response = await fetch("/auth/logout", { method: "POST" });
      if (!response.ok) {
        throw new Error("Sign-out failed");
      }
      navigate("/sign-in", { replace: true });
    } catch {
      setDialogOpen(false);
      setSignOutError(true);
      setSigningOut(false);
    }
  }

  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader eyebrow="Settings" title="Account" />
      <section aria-labelledby="profile-title" className="panel profile-card">
        <div aria-hidden="true" className="profile-card__avatar">
          FM
        </div>
        <div>
          <p className="eyebrow">Profile preview</p>
          <h2 id="profile-title">Factory member</h2>
          <p className="muted-copy">member@example.com</p>
        </div>
        <Badge tone="positive">Active</Badge>
      </section>
      <section aria-labelledby="session-title" className="panel settings-row">
        <div>
          <h2 id="session-title">Session</h2>
          <p>Signing out revokes this FactoryLens session on the server.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} variant="danger">
          Sign out
        </Button>
      </section>
      {signOutError ? (
        <Notification onDismiss={() => setSignOutError(false)} tone="error">
          <strong>FactoryLens could not sign you out.</strong>
          <span>Your session is still active. Please try again.</span>
        </Notification>
      ) : null}
      <Dialog
        description="Your current FactoryLens session will be revoked."
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title="Leave FactoryLens?"
      >
        <div className="dialog__actions">
          <Button onClick={() => setDialogOpen(false)} variant="quiet">
            Stay signed in
          </Button>
          <Button disabled={signingOut} onClick={signOut} variant="danger">
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function SignInPage() {
  return (
    <main className="sign-in">
      <section aria-labelledby="sign-in-title" className="sign-in__card">
        <div aria-hidden="true" className="sign-in__brand-mark">
          <span />
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">FactoryLens</p>
        <h1 id="sign-in-title">See every moment that matters.</h1>
        <p>
          Investigate recorded factory video through a focused, synchronized
          workspace.
        </p>
        <a
          className="button button--primary button--full"
          href="/auth/google?returnTo=/dashboard"
        >
          <span aria-hidden="true" className="google-mark">
            G
          </span>
          Continue with Google
        </a>
        <p className="sign-in__note">
          Google verifies your identity. FactoryLens manages your application
          session.
        </p>
      </section>
      <aside aria-label="Product preview" className="sign-in__visual">
        <div className="viewfinder">
          <span className="viewfinder__corner viewfinder__corner--one" />
          <span className="viewfinder__corner viewfinder__corner--two" />
          <span className="viewfinder__corner viewfinder__corner--three" />
          <span className="viewfinder__corner viewfinder__corner--four" />
          <div className="viewfinder__object">
            <span>Object 98%</span>
          </div>
          <div className="viewfinder__timeline">
            <span />
          </div>
        </div>
        <p>Recorded video · Synchronized insight</p>
      </aside>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader eyebrow="404" title="This view is out of frame" />
      <PageState kind="empty" title="Page not found">
        Check the address or return to the application overview.
      </PageState>
      <Link className="button button--primary self-start" to="/dashboard">
        Return to dashboard
      </Link>
    </div>
  );
}
