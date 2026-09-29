// Права ролей в интерфейсе — зеркало apps/api/src/domain/access.ts (OS-INSP-4.1.26, 4.1.27, T-139):
// действие, которое сервер отклонит с 403, интерфейс не предлагает.
const WORK = ["inspector", "supervisor"];
const READ = [...WORK, "admin"];

/** Загрузка, решения по кандидатам, выборка, финализация — инспектор и супервизор. */
export const canWork = (role?: string): boolean => WORK.includes(role ?? "");
/** Проверки, их карточки и файлы — инспектор, супервизор, администратор; ML-роли видят журналы в разделе «Модель». */
export const canSeeInspections = (role?: string): boolean => READ.includes(role ?? "");
/** OS-INSP-4.1.29 (T-234): закрыть спорный случай — супервизор и администратор (право dispute.resolve). */
export const canResolveDispute = (role?: string): boolean => ["supervisor", "admin"].includes(role ?? "");
/** OS-INSP-6.3.2, 6.3.3: подписать публикацию модели и откатить её — супервизор и администратор (ml.model.approve). */
export const canApproveModel = (role?: string): boolean => ["supervisor", "admin"].includes(role ?? "");

export const canAnnotate=(role?:string):boolean=>["verifier","inspector","supervisor","admin","curator"].includes(role??"");
export const canManageAnnotations=(role?:string):boolean=>["admin","curator"].includes(role??"");
