"""Regression checks for the Pose Lab ASR-only endpoint used by LukaChat."""
import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import wave

os.environ.setdefault('POSELAB_VOICE_CACHE', '/tmp/pose-lab-voice')
source = Path('/Users/toby/Documents/deepseek-harness/default-workspace/pose-lab/sim/voice_bridge.py')
spec = importlib.util.spec_from_file_location('voice_bridge', source)
voice = importlib.util.module_from_spec(spec); spec.loader.exec_module(voice)

def recording(rate=16000, channels=1):
    output = io.BytesIO()
    with wave.open(output, 'wb') as file:
        file.setnchannels(channels); file.setsampwidth(2); file.setframerate(rate); file.writeframes(b'\0\0' * int(rate * .4) * channels)
    return output.getvalue()

class AsrTests(unittest.TestCase):
    def handler(self, raw):
        handler = object.__new__(voice.Handler); handler.headers = {'content-length': str(len(raw))}
        handler._raw_body = Mock(return_value=raw); handler._send = Mock(); return handler

    def test_transcription_endpoint_calls_no_reasoning_or_tts_and_cleans_up(self):
        handler = self.handler(recording())
        with patch.object(voice, 'transcribe', return_value=('Hello Luka', 12)) as asr, patch.object(voice, 'reason') as reason, patch.object(voice, 'synthesise') as tts:
            handler._transcribe_upload()
            self.assertEqual(handler._send.call_args.args[0]['transcript'], 'Hello Luka')
            self.assertFalse(asr.call_args.args[0].exists()); reason.assert_not_called(); tts.assert_not_called()

    def test_wrong_sample_rate_and_stereo_are_rejected_before_asr(self):
        for raw in [recording(44100), recording(16000, 2)]:
            handler = self.handler(raw)
            with patch.object(voice, 'transcribe') as asr:
                handler._transcribe_upload(); asr.assert_not_called(); self.assertEqual(handler._send.call_args.args[1], 400)

    def test_oversized_upload_is_not_read(self):
        handler = self.handler(b''); handler.headers['content-length'] = '2000001'
        handler._transcribe_upload(); handler._raw_body.assert_not_called(); self.assertEqual(handler._send.call_args.args[1], 400)

if __name__ == '__main__': unittest.main()
