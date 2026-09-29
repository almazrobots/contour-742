import importlib.util,unittest,tempfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('verification_import',Path(__file__).parents[1]/'runner'/'verification-import.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ImportContract(unittest.TestCase):
    def candidate(self):return {'id':'test','source_sha256':'a'*64,'parameter':'M-007','page':2,'extraction':{'raw':'11','bbox':[.1,.2,.3,.4]},'artifact_sha256':None,'provenance':{}}
    def ref(self,obj='object'):return {'object':obj,'archive':'14_original.tar','path':'source.pdf'}
    def test_alias_dedup_keeps_object_memberships_distinct(self):
        c=self.candidate();refs=[self.ref(),{**self.ref(),'path':'alias.pdf'},self.ref('other')]
        tasks=m.tasks_for(c,refs,'pdf','v1');self.assertEqual(len(tasks),2)
        self.assertNotEqual(tasks[0]['sides'][0]['object_key'],tasks[1]['sides'][0]['object_key'])
        self.assertIsNone(tasks[0]['sides'][0]['file_id']);self.assertIsNone(tasks[0]['sides'][0]['artifact_sha256'])
    def test_methodology_and_historical_sha_only_links_are_not_membership(self):
        c=self.candidate();refs=[{**self.ref(),'archive':'02_methodology.tar'},{'source_kind':'historical_file_identity','file':{'id':'old'}}]
        self.assertEqual(m.tasks_for(c,refs,'pdf','v1'),[])
    def test_crop_page_and_bytes_are_pinned(self):
        with tempfile.TemporaryDirectory() as r:
            reader=Path(r)/'reader';reader.mkdir();name='a'*64+'-p2-b1.png';(reader/name).write_bytes(b'synthetic bytes')
            c=self.candidate();c['provenance']['crop_path']='/private/'+name
            side=m.side(c,self.ref(),'pdf',r)
            self.assertEqual(side['crop']['sha256'],hashlib.sha256(b'synthetic bytes').hexdigest());self.assertEqual(side['geometry'],'coarse_band')
            c['provenance']['crop_path']='/private/'+'a'*64+'-p3-b1.png'
            with self.assertRaises(ValueError):m.side(c,self.ref(),'pdf',r)
    def test_unsupported_viewer_is_explicitly_not_a_ready_task(self):
        self.assertEqual(m.tasks_for(self.candidate(),[self.ref()],'docx','v1'),[])
    def test_structured_tasks_require_pinned_view_and_never_invent_word_boxes(self):
        preview={'key':'b'*64,'sha256':'b'*64,'label':'XLSX · лист 2','revision':'structured-original.v1'}
        task=m.tasks_for(self.candidate(),[self.ref()],'xlsx','structured-v1',structured=preview)[0]
        s=task['sides'][0];self.assertEqual(s['preview'],preview);self.assertIsNone(s['bbox']);self.assertIsNone(s['anchor_bbox']);self.assertEqual(s['geometry'],'none')
    def test_pairs_are_bounded_distinct_sources_and_restart_stable(self):
        with tempfile.TemporaryDirectory() as r:
            path=Path(r)/'pairs.sqlite';db=m.prepare_pair_index(path)
            task=m.tasks_for(self.candidate(),[self.ref()],'pdf','v1')[0]
            self.assertEqual(m.pair_tasks(task,db),[])
            same=m.tasks_for({**self.candidate(),'page':3},[self.ref()],'pdf','v1')[0]
            self.assertEqual(m.pair_tasks(same,db),[])
            second=m.tasks_for({**self.candidate(),'source_sha256':'b'*64},[self.ref()],'pdf','v1')[0]
            pair=m.pair_tasks(second,db);self.assertEqual(len(pair),1);self.assertEqual(pair[0]['operation'],'field_match')
            self.assertEqual([s['sha256'] for s in pair[0]['sides']],['a'*64,'b'*64])
            db.commit();db.close();db=m.prepare_pair_index(path)
            self.assertEqual(m.pair_tasks(second,db),[])
            third=m.tasks_for({**self.candidate(),'source_sha256':'c'*64},[self.ref()],'pdf','v1')[0]
            self.assertEqual(len(m.pair_tasks(third,db)),1)
            db.close()
    def test_pairs_do_not_cross_objects_or_use_mixed_archive(self):
        with tempfile.TemporaryDirectory() as r:
            db=m.prepare_pair_index(Path(r)/'pairs.sqlite')
            first=m.tasks_for(self.candidate(),[self.ref()],'pdf','v1')[0];m.pair_tasks(first,db)
            c={**self.candidate(),'source_sha256':'b'*64}
            other=m.tasks_for(c,[self.ref('other')],'pdf','v1')[0]
            self.assertEqual(m.pair_tasks(other,db),[])
            mixed=m.tasks_for(c,[{**self.ref(),'archive':'01_mixed.tar'}],'pdf','v1')[0]
            self.assertEqual(m.pair_tasks(mixed,db),[])
            unknown=m.tasks_for(c,[self.ref('unknown')],'pdf','v1')[0]
            self.assertEqual(m.pair_tasks(unknown,db),[])
            db.close()
    def test_failed_api_batch_rolls_back_pair_seeds(self):
        with tempfile.TemporaryDirectory() as r:
            path=Path(r)/'pairs.sqlite';db=m.prepare_pair_index(path)
            first=m.tasks_for(self.candidate(),[self.ref()],'pdf','v1')[0]
            db.execute('BEGIN');m.pair_tasks(first,db);db.rollback()
            self.assertEqual(db.execute('select count(*) from seeds').fetchone()[0],0)
            db.close()
