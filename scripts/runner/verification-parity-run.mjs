import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const password=readFileSync('/opt/w1-gate/eval/verification/parity/password','utf8').trim();
const result=spawnSync('pnpm',['exec','vitest','run','tests/verification-concurrency.test.ts','tests/data-verification.test.ts','tests/verification-http.test.ts','tests/annotation-library.test.ts','tests/domain-annotation-comments.test.ts'],{
 cwd:'apps/api',stdio:'inherit',env:{...process.env,INSPECTOR_TEST_DATABASE_URL:`postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:48846/postgres`}
});
process.exit(result.status??1);
