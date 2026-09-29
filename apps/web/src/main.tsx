import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {flushSync} from "react-dom";
import { createHashRouter, NavLink, Navigate, Outlet, RouterProvider, useNavigate } from "react-router-dom";
import "./styles.css";
import { api, session, setSession } from "./lib/api";
import { ROLE_RU } from "./lib/labels";
import { Icon, ToastHost } from "./components/ui";
import {AnnotationLibrary} from "./pages/AnnotationLibrary";
import { DataVerification } from "./pages/DataVerification";
import { Login } from "./pages/Login";
import { Files } from "./pages/Files";
import { Inspections } from "./pages/Inspections";
import { ObjectCard, Objects } from "./pages/Objects";
import { NewInspection } from "./pages/NewInspection";
import { Inspection } from "./pages/Inspection";
import { Verify } from "./pages/Verify";
import { Sample } from "./pages/Sample";
import { Matrix } from "./pages/Matrix";
import { Normative } from "./pages/Normative";
import { Ml } from "./pages/Ml";
import { Audit } from "./pages/Audit";
import { Monitoring } from "./pages/Monitoring";
import { DemoBanner } from "./components/DemoBanner";
import { canSeeInspections, canWork, canAnnotate } from "./lib/access";
import {verificationOnly} from './lib/verification-mode';

function Shell() {
  const s = session();
  const nav = useNavigate();
  const [, force] = useState(0);
  const [closing,setClosing]=useState(false);
  if (!s) return <Navigate to="/login" replace />;
  const role = s.user.role;
  const link = (to: string, icon: string, label: string, show = true): ReactNode =>
    show && (
      <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")} title={label}>
        <Icon name={icon} size={20} />
        {label}
      </NavLink>
    );
  return (
    <div className="shell">
      <nav className="rail" aria-label="Модули">
        <div className="logo" title="Инспектор ИИ">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        {/* T-166 (вариант Б плана T-142): «Объекты» — главный раздел, проверки — журнал внутри объекта */}
        {link("/objects", "building", "Объекты", !verificationOnly&&canSeeInspections(role))}
        {link("/inspections", "list", "Проверки", !verificationOnly&&canSeeInspections(role))}
        {link("/files", "list", "Файлы", !verificationOnly&&canSeeInspections(role))}
        {link("/new", "upload", "Загрузка", !verificationOnly&&canWork(role))}
        {link("/verification", "list", "Разметка данных", canAnnotate(role))}
        {link("/verification-library", "matrix", "Витрина разметки", canAnnotate(role))}
        {link("/matrix", "matrix", "Матрица", !verificationOnly&&role !== "verifier")}
        {link("/normative", "book", "Нормы", !verificationOnly&&role !== "verifier")}
        {link("/ml", "brain", "Модель", !verificationOnly&&role !== "inspector" && role !== "verifier")}
        {link("/audit", "log", "Журнал", !verificationOnly&&(role === "supervisor" || role === "admin"))}
        {link("/monitoring", "pulse", "Метрики", !verificationOnly&&role === "admin")}
        <div className="spacer" />
        <a
          href="#/login"
          title={`${s.user.name} · ${ROLE_RU[role]} — выйти`}
          onClick={async (e) => {
            e.preventDefault();
            if(closing)return;
            // Tear down PDF workers and pending source loads before revoking
            // their leases. Otherwise a background range request races a 403.
            flushSync(()=>setClosing(true));
            await api("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
            setSession(null);
            force((x) => x + 1);
            nav("/login");
          }}
        >
          <Icon name="out" size={20} />
          Выйти
        </a>
      </nav>
      <div className="main">
        {!verificationOnly&&<DemoBanner />}
        {closing?<p role="status">Выходим…</p>:<Outlet />}
      </div>
    </div>
  );
}

// OS-INSP-4.1.27: ML-инженер и куратор начинают с раздела модели — проверки им закрыты
function Home() {
  return <Navigate to={verificationOnly||session()?.user.role === "verifier" ? "/verification" : canSeeInspections(session()?.user.role) ? "/inspections" : "/ml"} replace />;
}

const router = createHashRouter([
  { path: "/login", element: <Login /> },
  {
    path: "/",
    element: <Shell />,
    children: verificationOnly?[
      {index:true,element:<Home/>},
      {path:'verification',element:<DataVerification/>},
      {path:'verification-library',element:<AnnotationLibrary/>},
      {path:'*',element:<Navigate to='/verification' replace/>},
    ]:[
      { index: true, element: <Home /> },
      { path: "objects", element: <Objects /> },
      { path: "objects/:id", element: <ObjectCard /> },
      { path: "inspections", element: <Inspections /> },
      { path: "files", element: <Files /> },
      { path: "new", element: <NewInspection /> },
      { path: "inspections/:id", element: <Inspection /> },
      { path: "inspections/:id/verify", element: <Verify /> },
      { path: "inspections/:id/sample", element: <Sample /> },
      { path: "verification", element: <DataVerification /> },
      { path: "verification-library", element: <AnnotationLibrary /> },
      { path: "matrix", element: <Matrix /> },
      { path: "normative", element: <Normative /> },
      { path: "ml", element: <Ml /> },
      { path: "audit", element: <Audit /> },
      { path: "monitoring", element: <Monitoring /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastHost>
      <RouterProvider router={router} />
    </ToastHost>
  </StrictMode>,
);
