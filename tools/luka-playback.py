"""Upload one PCM clip and confirm its playback through TTS status, over SSH."""
import json
from pathlib import Path
import re
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:59301/rpc/aimdk.protocol.TTSService/'

def call(method, body):
    request = urllib.request.Request(BASE + method, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)

def wait_for_playback(trace, duration, rpc=call, now=time.monotonic, sleep=time.sleep, on_playing=lambda: None):
    deadline = now() + duration + 20
    announced = False
    while now() < deadline:
        status = rpc('GetAudioStatus', {'trace_id': trace}).get('tts_status', {})
        if status.get('trace_id') == trace:
            if status.get('error_message'):
                raise RuntimeError(status['error_message'])
            state = status.get('tts_status', '')
            if state in ('TTSStatusType_Playing', 'TTSStatusType_End'):
                if not announced:
                    on_playing(); announced = True
                if state == 'TTSStatusType_End':
                    return status
            if any(word in state.lower() for word in ('interrupt', 'error', 'fail', 'cancel')):
                raise RuntimeError('Luka playback ended with ' + state)
        sleep(.25)
    raise RuntimeError('Luka did not confirm playback completion')

def main():
    directory, filename, rate = sys.argv[1:4]
    rate = int(rate)
    if rate not in (16000, 22050, 24000, 48000) or not re.fullmatch(r'say_[A-Za-z0-9_]+\.pcm', filename):
        raise ValueError('invalid playback configuration')
    pcm = sys.stdin.buffer.read(300001)
    if not pcm or len(pcm) > 300000 or len(pcm) % 2:
        raise ValueError('invalid PCM clip')
    (Path(directory) / filename).write_bytes(pcm)
    trace = filename[:-4]
    response = call('PlayMediaFile', {'file_name': filename, 'sample_rate': rate,
                    'priority_level': 'INTERACTION_L6', 'domain': 'mcp-say',
                    'trace_id': trace, 'is_interrupted': False})
    if response.get('error_message'):
        raise RuntimeError(response['error_message'])
    # is_sucess can be false for a clip that has been queued successfully.
    status = wait_for_playback(trace, len(pcm) / (rate * 2),
                              on_playing=lambda: print(json.dumps({'phase': 'speaking'}), flush=True))
    print(json.dumps({'ok': True, 'completed': True, 'status': status.get('tts_status'),
                      'acknowledged': response.get('is_sucess')}), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
        sys.exit(1)
