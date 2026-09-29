import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setSession } from "../lib/api";
import { ROLE_RU } from "../lib/labels";
import { publication, provenanceLine, type Publication } from "../lib/demo";
import {verificationOnly} from '../lib/verification-mode';

const DEMO = ["inspector", "supervisor", "admin", "curator", "ml"];

export function Login() {
  const nav = useNavigate();
  const [login, setLogin] = useState(verificationOnly?"curator":"inspector");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Publication | null>(null);
  const [guestOn, setGuestOn] = useState(false);
  useEffect(() => {
    if(verificationOnly)return;
    void publication().then(setDemo);
    // T-131: кнопка гостя — только если сервер её включил; иначе вход по логину и паролю
    api<{ enabled: boolean }>("/api/v1/auth/guest").then((r) => setGuestOn(r.enabled)).catch(() => setGuestOn(false));
  }, []);
  // демо-стенд (T-131): вход без пароля — гость смотрит, изменить ничего не может (API отвечает 403)
  const guest = async () => {
    setBusy(true);
    setError(null);
    try {
      setSession(await api("/api/v1/auth/guest", { method: "POST" }));
      nav("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api("/api/v1/auth/login", { body: { login, password } });
            setSession(r);
            nav("/");
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row" style={{ gap: 12 }}>
          <div className="rail-logo" style={{ width: 40, height: 40, borderRadius: 11, background: "var(--ink)", display: "grid", placeItems: "center" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </div>
          <div>
            <h1>Инспектор ИИ</h1>
            <div className="mute small">{verificationOnly?"Разметка данных · проверка фрагментов документов":"Сверка ПД, РД и ИД по 132 параметрам Матрицы"}</div>
          </div>
        </div>
        {demo && (
          <div className="demo-login">
            <b>Демо-стенд «Надзориум» · только просмотр</b>
            <span className="small">{provenanceLine(demo)}</span>
            {guestOn && (
              <button type="button" className="btn primary" disabled={busy} onClick={guest} style={{ justifyContent: "center", padding: "9px 12px" }}>
                Войти для просмотра
              </button>
            )}
            <span className="small mute">
              Карта требований, пайплайн и методика — <a href="/docs/index.html">в материалах стенда</a>.
            </span>
          </div>
        )}
        <label className="stack" style={{ gap: 4 }} htmlFor="login">
          <span className="label">Логин</span>
          <input id="login" className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
        </label>
        <label className="stack" style={{ gap: 4 }} htmlFor="password">
          <span className="label">Пароль</span>
          <input id="password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="pill red" style={{ alignSelf: "flex-start" }}>{error}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: "center", padding: "9px 12px" }}>
          {busy ? "Входим…" : "Войти"}
        </button>
        {!demo && !verificationOnly && (
        <div className="small mute">
          Демо-учётки прототипа (пароль — INSPECTOR_DEMO_PASSWORD или var/demo-password.txt):{" "}
          {DEMO.map((d, i) => (
            <span key={d}>
              <a href="#" onClick={(e) => (e.preventDefault(), setLogin(d))} className="mono">
                {d}
              </a>
              {i < DEMO.length - 1 ? ", " : ""}
            </span>
          ))}
          . Роли: {Object.values(ROLE_RU).join(", ").toLowerCase()}.
        </div>
        )}
      </form>
    </div>
  );
}
