import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./app/auth";
import { Shell, TrialEndedPage } from "./app/Shell";
import { Spinner } from "./components/ui";
import { hasAccess } from "./data/types";
import { CompleteProfilePage, LoginPage, ResetPage, SignupPage } from "./pages/AuthPages";
import { PatientsPage } from "./pages/PatientsPage";
import "./index.css";

const PatientPage = lazy(() => import("./pages/PatientPage"));
const SessionPage = lazy(() => import("./pages/SessionPage"));
const PlayPage = lazy(() => import("./pages/PlayPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function Routed() {
  const { uid, profile, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!uid) {
    return (
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (!profile) return <CompleteProfilePage />;
  if (!hasAccess(profile)) return <TrialEndedPage />;
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/patients/:id/play" element={<PlayPage />} />
        <Route element={<Shell />}>
          <Route index element={<PatientsPage />} />
          <Route path="/patients/:id" element={<PatientPage />} />
          <Route path="/patients/:id/sessions/:sid" element={<SessionPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
