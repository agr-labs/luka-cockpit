import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('playback',Path(__file__).with_name('luka-playback.py'))
player=importlib.util.module_from_spec(spec);spec.loader.exec_module(player)

class PlaybackTests(unittest.TestCase):
    def run_statuses(self, states):
        clock=[0]; seen=[]; sequence=iter(states)
        def rpc(method,body):
            self.assertEqual(body,{'trace_id':'clip'})
            try: state=next(sequence)
            except StopIteration: state='TTSStatusType_NOTInQue'
            return {'tts_status':{'trace_id':'clip','tts_status':state}}
        def sleep(seconds):clock[0]+=seconds
        result=player.wait_for_playback('clip',1,rpc=rpc,now=lambda:clock[0],sleep=sleep,on_playing=lambda:seen.append('playing'))
        return result,seen
    def test_queued_playback_waits_for_playing_and_end(self):
        result,seen=self.run_statuses(['TTSStatusType_NOTInQue','TTSStatusType_Playing','TTSStatusType_Playing','TTSStatusType_End'])
        self.assertEqual(result['tts_status'],'TTSStatusType_End');self.assertEqual(seen,['playing'])
    def test_short_completed_clip_is_not_replayed(self):
        _,seen=self.run_statuses(['TTSStatusType_End']);self.assertEqual(seen,['playing'])
    def test_unqueued_clip_times_out_instead_of_claiming_success(self):
        with self.assertRaisesRegex(RuntimeError,'confirm playback'):self.run_statuses([])
    def test_interrupted_clip_is_not_reported_finished(self):
        with self.assertRaisesRegex(RuntimeError,'Interrupted'):self.run_statuses(['TTSStatusType_Playing','TTSStatusType_Interrupted'])
if __name__=='__main__':unittest.main()
