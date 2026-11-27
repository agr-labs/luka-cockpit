import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
let source;
export async function playPcm({ sshArgs, directory, file, pcm, sampleRate, onPlaying }) {
  source ??= readFile(new URL('./luka-playback.py', import.meta.url), 'utf8');
  const command = `python3 -u -c ${quote(await source)} ${quote(directory)} ${quote(file)} ${quote(String(sampleRate))}`;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', completed = null, error = null;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Luka playback timed out')); }, Math.ceil(pcm.length / (sampleRate * 2) * 1000) + 30000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let packet;
        try { packet = JSON.parse(line); } catch { continue; }
        if (packet.phase === 'speaking') onPlaying?.();
        if (packet.ok && packet.completed) completed = packet;
        if (packet.ok === false) error = packet.error;
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-300); });
    child.stdin.on('error', () => {});
    child.on('error', (reason) => { clearTimeout(timeout); reject(reason); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && completed) resolve(completed);
      else reject(new Error(error || stderr.trim() || 'Luka did not confirm playback completion'));
    });
    child.stdin.end(pcm);
  });
}
