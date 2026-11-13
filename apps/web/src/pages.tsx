import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { PageState } from "./components/PageState";
import { NewInspectionForm } from "./new-inspection";
import { InspectionHistory, RecentInspections } from "./inspection-history";
import { InspectionStatus } from "./inspection-status";
import { Badge, Button, Dialog, Notification } from "./components/ui";

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
        eyebrow="Workspace"
        title="Inspection dashboard"
      />

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
        <RecentInspections />
      </section>
    </div>
  );
}

export function NewInspectionPage() {
  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader eyebrow="Create" title="New inspection" />
      <p className="page-intro">
        Upload an existing video, record one in this browser, or use the
        prepared sample. Every source follows the same inspection contract.
      </p>
      <NewInspectionForm />
    </div>
  );
}

export function InspectionPage() {
  const { inspectionId } = useParams();
  return (
    <div className="page-stack">
      {inspectionId ? <InspectionStatus inspectionId={inspectionId} /> : null}
    </div>
  );
}

export function HistoryPage() {
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Archive" title="Inspection history" />
      <section
        aria-labelledby="history-table-title"
        className="panel section-stack"
      >
        <div className="section-heading">
          <h2 id="history-table-title">All inspections</h2>
        </div>
        <InspectionHistory />
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
