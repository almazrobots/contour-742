// Gradual rollout: the annotation feature has its own routes and session namespace.
export const verificationOnly=import.meta.env.VITE_VERIFICATION_ONLY==='true';
export function apiUrl(path:string):string {
  return verificationOnly&&path.startsWith('/api/')?`${import.meta.env.BASE_URL.replace(/\/$/,'')}${path}`:path;
}
