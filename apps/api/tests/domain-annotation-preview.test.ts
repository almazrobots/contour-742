import {describe,it,expect} from 'vitest';
import {AnnotationSide} from '../src/domain/data-verification.ts';
describe('structured original descriptors',()=>{
 const source={sha256:'a'.repeat(64),file_name:'original.xlsx',kind:'xlsx',page:2,object_key:'catalog:test',preview:{key:'b'.repeat(64),sha256:'b'.repeat(64),label:'XLSX · лист 2',revision:'structured-original.v1'}};
 it('pins structured original without imaginary word boxes',()=>{const s=AnnotationSide.parse(source);expect(s.bbox).toBeNull();expect(s.preview?.label).toContain('лист');});
 it('refuses path traversal, raster mixing and unknown rendering contracts',()=>{
  expect(AnnotationSide.safeParse({...source,preview:{...source.preview,key:'../../secret'}}).success).toBe(false);
  expect(AnnotationSide.safeParse({...source,kind:'pdf'}).success).toBe(false);
  expect(AnnotationSide.safeParse({...source,bbox:[0,0,.5,.5]}).success).toBe(false);
  expect(AnnotationSide.safeParse({...source,preview:{...source.preview,revision:'invented'}}).success).toBe(false);
 });
 it('keeps existing raster inputs compatible',()=>{expect(AnnotationSide.parse({...source,kind:'pdf',preview:undefined}).preview).toBeUndefined();});
});
