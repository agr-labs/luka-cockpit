// Reuse Pose Lab's tested ASR/reasoning service; speech stays on Luka's bridge.
export function createChatProxy({ base = process.env.LUKA_REASONING_URL || 'http://127.0.0.1:4182', fetchImpl = fetch } = {}) {
  return async (req, res, url) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw Object.assign(new Error('Use LukaChat from this dashboard'), { status: 403 }); }
        if (origin.host !== req.headers.host) throw Object.assign(new Error('Use LukaChat from this dashboard'), { status: 403 });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('Use LukaChat from this dashboard'), { status: 403 });
      if (req.method === 'GET' && url.pathname === '/chat/status') {
        const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        const data = await response.json();
        return send(response.status, { asr: data.asr, llms: data.llms?.map(({ name, label, model, ready, note }) => ({ name, label, model, ready, note })), defaultLlm: data.llm_default });
      }
      if (req.method !== 'POST' || !['/chat/transcribe', '/chat/reason'].includes(url.pathname)) return send(404, { error: 'Chat route not found' });
      const type = req.headers['content-type']?.split(';')[0].trim();
      const audio = url.pathname === '/chat/transcribe';
      if (type !== (audio ? 'audio/wav' : 'application/json')) return send(415, { error: audio ? 'Send a WAV recording' : 'Send JSON' });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (audio ? 2_000_000 : 20_000)) return send(413, { error: 'Chat request is too large' });
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (audio) {
        if (body.length < 44 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WAVE') return send(400, { error: 'Recording is not a WAV file' });
      } else {
        let data;
        try { data = JSON.parse(body.toString('utf8')); } catch { return send(400, { error: 'Invalid chat JSON' }); }
        if (!data || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000) return send(400, { error: 'Enter a message up to 4000 characters' });
        if (data.llm != null && !['prism', 'inworld', 'local'].includes(data.llm)) return send(400, { error: 'Unknown reasoning provider' });
        const history = Array.isArray(data.history) ? data.history.slice(-6).filter((t) => ['user', 'assistant'].includes(t?.role) && typeof t.content === 'string').map((t) => ({ role: t.role, content: t.content.slice(0, 1200) })) : [];
        body = JSON.stringify({ text: data.text.trim(), history, llm: data.llm });
      }
      const response = await fetchImpl(`${base}/${audio ? 'transcribe' : 'reason'}`, {
        method: 'POST', headers: { 'Content-Type': audio ? 'audio/wav' : 'application/json' }, body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });
      return send(response.status, await response.json());
    } catch (error) {
      if (abort.signal.aborted) return;
      return send(error.status || 503, { error: error.message || 'The reasoning bridge is unavailable' });
    }
  };
}
