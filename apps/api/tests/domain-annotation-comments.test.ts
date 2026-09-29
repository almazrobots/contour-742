import {expect,it} from 'vitest';
import {censorAnnotationComment as censor} from '../src/domain/annotation-comments.ts';
it('masks comment profanity without changing technical words or punctuation',()=>{
 expect(censor('Блять, это хуйня. Нахуй! Заебался. Сука. Пиздец.')).toBe('*****, это *****. *****! ********. ****. ******.');
 expect(censor('Небольшой размер, учебный корпус, страховка, сукно, требуется исправить.')).toBe('Небольшой размер, учебный корпус, страховка, сукно, требуется исправить.');
 expect(censor('')).toBe('');
});
