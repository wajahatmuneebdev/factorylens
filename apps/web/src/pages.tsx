import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { PageState } from "./components/PageState";
import {
  Badge,
  Button,
  Dialog,
  Field,
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
  const [noticeVisible, setNoticeVisible] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNoticeVisible(true);
  }

  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader eyebrow="Create" title="New inspection" />
      <p className="page-intro">
        Set up the inspection workspace. Media upload and processing will be
        connected in a later feature.
      </p>

      {noticeVisible ? (
        <Notification onDismiss={() => setNoticeVisible(false)}>
          <strong>Form interaction confirmed.</strong>
          <span>This preview does not create or upload an inspection.</span>
        </Notification>
      ) : null}

      <form className="panel form-stack" onSubmit={handleSubmit}>
        <div className="section-heading section-heading--bordered">
          <div>
            <p className="eyebrow">Details</p>
            <h2>Describe the recording</h2>
          </div>
          <Badge>Step 1 of 2</Badge>
        </div>
        <Field
          hint="Use a name that will be easy to find in history."
          label="Inspection name"
        >
          <input
            name="title"
            placeholder="e.g. Packaging line check"
            required
          />
        </Field>
        <div className="form-grid">
          <Field label="Source type">
            <select defaultValue="upload" name="sourceType">
              <option value="upload">Upload a video</option>
              <option value="record">Record in browser</option>
              <option value="sample">Use prepared sample</option>
            </select>
          </Field>
          <Field label="Workflow">
            <select defaultValue="safety" name="workflow">
              <option value="safety">Factory safety review</option>
            </select>
          </Field>
        </div>
        <Field
          hint="Optional context is kept with this inspection."
          label="Notes"
        >
          <textarea
            name="notes"
            placeholder="Add shift, line, or camera context"
            rows={4}
          />
        </Field>
        <div className="form-actions">
          <Link className="button button--quiet" to="/dashboard">
            Cancel
          </Link>
          <Button type="submit">Continue to media</Button>
        </div>
      </form>
    </div>
  );
}

export function InspectionPage() {
  const { inspectionId } = useParams();

  return (
    <div className="page-stack">
      <PageHeader
        action={<Badge tone="info">Processing</Badge>}
        eyebrow="Inspection preview"
        title="Packaging line check"
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
            <h2 id="status-title">Analyzing recording</h2>
          </div>
          <Progress label="Inspection progress" value={62} />
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
          <p>Authentication is not connected in this interface foundation.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} variant="danger">
          Sign out preview
        </Button>
      </section>
      <Dialog
        description="This demonstrates the shared confirmation dialog. No session will be changed."
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title="Leave FactoryLens?"
      >
        <div className="dialog__actions">
          <Button onClick={() => setDialogOpen(false)} variant="quiet">
            Stay signed in
          </Button>
          <Button onClick={() => setDialogOpen(false)} variant="danger">
            Sign out preview
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function SignInPage() {
  const [noticeVisible, setNoticeVisible] = useState(false);

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
        {noticeVisible ? (
          <Notification
            onDismiss={() => setNoticeVisible(false)}
            tone="warning"
          >
            <strong>Sign-in is not connected yet.</strong>
            <span>Explore the shell below while authentication is built.</span>
          </Notification>
        ) : null}
        <Button className="button--full" onClick={() => setNoticeVisible(true)}>
          <span aria-hidden="true" className="google-mark">
            G
          </span>
          Continue with Google
        </Button>
        <p className="sign-in__note">
          Sign-in is a visual preview and is not connected yet.
        </p>
        <Link className="text-link" to="/dashboard">
          Explore the application shell
        </Link>
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
