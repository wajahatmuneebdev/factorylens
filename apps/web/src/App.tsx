import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router-dom";

import {
  AccountPage,
  DashboardPage,
  HistoryPage,
  InspectionPage,
  NewInspectionPage,
  NotFoundPage,
  SignInPage,
} from "./pages";

type IconName = "account" | "add" | "dashboard" | "history";

const queryClient = new QueryClient();

const iconPaths: Record<IconName, ReactNode> = {
  account: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  add: (
    <>
      <path d="M12 5v14M5 12h14" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  dashboard: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68" />
      <path d="M4 4v4.68h4.68M12 7v5l3 2" />
    </>
  ),
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24">
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      >
        {iconPaths[name]}
      </g>
    </svg>
  );
}

const primaryNavigation: Array<{ icon: IconName; label: string; to: string }> =
  [
    { icon: "dashboard", label: "Dashboard", to: "/dashboard" },
    { icon: "add", label: "New inspection", to: "/inspections/new" },
    { icon: "history", label: "History", to: "/history" },
  ];

function Brand() {
  return (
    <Link aria-label="FactoryLens dashboard" className="brand" to="/dashboard">
      <span aria-hidden="true" className="brand__mark">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span>FactoryLens</span>
    </Link>
  );
}

function PrimaryNav() {
  return (
    <nav aria-label="Primary" className="primary-nav">
      {primaryNavigation.map((item) => (
        <NavLink
          className={({ isActive }) =>
            `primary-nav__link${isActive ? " primary-nav__link--active" : ""}`
          }
          key={item.to}
          to={item.to}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="sidebar__context">
          <span className="sidebar__context-label">Workspace</span>
          <strong>Factory floor</strong>
        </div>
        <PrimaryNav />
        <div className="sidebar__footer">
          <NavLink
            className={({ isActive }) =>
              `account-link${isActive ? " account-link--active" : ""}`
            }
            to="/account"
          >
            <span aria-hidden="true" className="avatar">
              FM
            </span>
            <span className="account-link__identity">
              <strong>Factory member</strong>
              <span>Interface preview</span>
            </span>
            <Icon name="account" />
          </NavLink>
        </div>
      </aside>

      <header className="tablet-header">
        <Brand />
        <NavLink
          aria-label="Account"
          className="tablet-header__account"
          to="/account"
        >
          <span aria-hidden="true" className="avatar">
            FM
          </span>
        </NavLink>
      </header>
      <div className="tablet-nav">
        <PrimaryNav />
      </div>

      <main className="app-main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SignInPage />} path="/sign-in" />
      <Route element={<AppShell />}>
        <Route element={<Navigate replace to="/dashboard" />} path="/" />
        <Route element={<DashboardPage />} path="/dashboard" />
        <Route element={<NewInspectionPage />} path="/inspections/new" />
        <Route element={<InspectionPage />} path="/inspections/:inspectionId" />
        <Route element={<HistoryPage />} path="/history" />
        <Route element={<AccountPage />} path="/account" />
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
